const std = @import("std");

const dashboard_json = @import("dashboard_json.zig");
const dashboard_runs = @import("dashboard_runs.zig");

const JsonValue = dashboard_json.JsonValue;
const JsonObject = dashboard_json.JsonObject;

const max_dashboard_repositories = 1000;
const max_load_errors = 200;
const max_repo_text_len = 256;
const max_work_items_per_repository = 100;
const max_work_item_number = 999_999_999;
const max_work_title_len = 1024;
const max_error_message_len = 2048;

pub const Dashboard = struct {
    items: []const JsonValue,
    errors: []const JsonValue,

    pub fn init(root: JsonObject) Dashboard {
        return .{
            .items = dashboard_json.boundedArrayFieldOrEmpty(root, "items", max_dashboard_repositories),
            .errors = dashboard_json.boundedArrayFieldOrEmpty(root, "errors", max_load_errors),
        };
    }

    pub fn totals(self: Dashboard) Totals {
        var result = Totals{};

        for (self.items) |item| {
            const repo = repositoryFromValue(item) orelse continue;
            result.repositories += 1;
            result.issues = saturatingAdd(result.issues, repo.open_issues);
            result.pull_requests = saturatingAdd(result.pull_requests, repo.open_pulls);
            result.stars = saturatingAdd(result.stars, repo.stars);
            if (repo.has_failure) result.failing += 1;
        }

        return result;
    }
};

pub const Repository = struct {
    slug: []const u8,
    valid_slug: bool,
    open_issues: u64,
    open_pulls: u64,
    stars: u64,
    runs: RunStatuses,
    has_failure: bool,
    issues: []const JsonValue,
    pull_requests: []const JsonValue,
};

pub const RunStatuses = dashboard_runs.RunStatuses;

pub const Totals = struct {
    repositories: u64 = 0,
    issues: u64 = 0,
    pull_requests: u64 = 0,
    stars: u64 = 0,
    failing: u64 = 0,
};

pub const WorkKind = enum {
    issues,
    pull_requests,
};

pub const WorkItem = struct {
    repo: []const u8,
    number: u64,
    title: []const u8,
};

pub const WorkItemIterator = struct {
    dashboard: Dashboard,
    kind: WorkKind,
    repo_index: usize = 0,
    item_index: usize = 0,

    pub fn init(dashboard: Dashboard, kind: WorkKind) WorkItemIterator {
        return .{
            .dashboard = dashboard,
            .kind = kind,
        };
    }

    pub fn next(self: *WorkItemIterator) ?WorkItem {
        while (self.repo_index < self.dashboard.items.len) {
            const repo = repositoryFromValue(self.dashboard.items[self.repo_index]) orelse {
                self.repo_index += 1;
                self.item_index = 0;
                continue;
            };
            if (!repo.valid_slug) {
                self.repo_index += 1;
                self.item_index = 0;
                continue;
            }
            const list = workItems(repo, self.kind);

            while (self.item_index < list.len) {
                const index = self.item_index;
                self.item_index += 1;
                if (workItemFromValue(list[index], repo.slug)) |item| {
                    return item;
                }
            }

            self.repo_index += 1;
            self.item_index = 0;
        }

        return null;
    }
};

pub const LoadError = struct {
    repo: []const u8,
    message: []const u8,
};

pub const LoadErrorIterator = struct {
    errors: []const JsonValue,
    index: usize = 0,

    pub fn init(dashboard: Dashboard) LoadErrorIterator {
        return .{ .errors = dashboard.errors };
    }

    pub fn next(self: *LoadErrorIterator) ?LoadError {
        while (self.index < self.errors.len) {
            const index = self.index;
            self.index += 1;
            if (loadErrorFromValue(self.errors[index])) |load_error| {
                return load_error;
            }
        }

        return null;
    }
};

pub fn repositoryFromValue(value: JsonValue) ?Repository {
    const repo = dashboard_json.objectValue(value) orelse return null;
    return repositoryFromObject(repo);
}

fn repositoryFromObject(repo: JsonObject) Repository {
    const status = dashboard_json.safeTextField(repo, "status", "ok", max_repo_text_len);
    const latest = dashboard_json.objectField(repo, "latestRuns");
    const slug = dashboard_json.requiredSafeTextField(repo, "slug", max_repo_text_len);

    return .{
        .slug = slug orelse "unknown",
        .valid_slug = slug != null,
        .open_issues = dashboard_json.safeIntegerField(repo, "openIssues"),
        .open_pulls = dashboard_json.safeIntegerField(repo, "openPulls"),
        .stars = dashboard_json.safeIntegerField(repo, "stars"),
        .runs = dashboard_runs.repositoryRunStatuses(status, latest),
        .has_failure = dashboard_runs.repositoryHasFailure(latest),
        .issues = dashboard_json.boundedArrayFieldOrEmpty(repo, "issues", max_work_items_per_repository),
        .pull_requests = dashboard_json.boundedArrayFieldOrEmpty(repo, "pullRequests", max_work_items_per_repository),
    };
}

fn workItems(repo: Repository, kind: WorkKind) []const JsonValue {
    return switch (kind) {
        .issues => repo.issues,
        .pull_requests => repo.pull_requests,
    };
}

fn workItemFromValue(value: JsonValue, repo_slug: []const u8) ?WorkItem {
    const work = dashboard_json.objectValue(value) orelse return null;
    return workItemFromObject(work, repo_slug);
}

fn workItemFromObject(work: JsonObject, repo_slug: []const u8) ?WorkItem {
    const number = dashboard_json.boundedIntField(work, "number", max_work_item_number);
    if (number == 0) return null;
    const title = dashboard_json.requiredSafeTextField(work, "title", max_work_title_len) orelse return null;

    return .{
        .repo = repo_slug,
        .number = number,
        .title = title,
    };
}

fn loadErrorFromValue(value: JsonValue) ?LoadError {
    const load_error = dashboard_json.objectValue(value) orelse return null;
    return loadErrorFromObject(load_error);
}

fn loadErrorFromObject(load_error: JsonObject) ?LoadError {
    const repo = dashboard_json.requiredSafeTextField(load_error, "repo", max_repo_text_len) orelse return null;
    const message = dashboard_json.requiredSafeTextField(load_error, "error", max_error_message_len) orelse return null;

    return .{
        .repo = repo,
        .message = message,
    };
}

fn saturatingAdd(a: u64, b: u64) u64 {
    return a +| b;
}

test "dashboard model collects repository totals and run statuses" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    {
        \\      "slug": "alpha",
        \\      "status": "ok",
        \\      "openIssues": 2,
        \\      "openPulls": 1,
        \\      "stars": 10,
        \\      "latestRuns": {
        \\        "ci": {"status": "completed", "conclusion": "failure"},
        \\        "nightly": {"status": "in_progress"}
        \\      }
        \\    },
        \\    {
        \\      "slug": "beta",
        \\      "status": "error",
        \\      "openIssues": 3,
        \\      "openPulls": 0,
        \\      "stars": 5
        \\    }
        \\  ],
        \\  "errors": [{"repo": "beta", "error": "rate limited"}]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    const totals = dashboard.totals();

    try std.testing.expectEqual(@as(u64, 2), totals.repositories);
    try std.testing.expectEqual(@as(u64, 5), totals.issues);
    try std.testing.expectEqual(@as(u64, 1), totals.pull_requests);
    try std.testing.expectEqual(@as(u64, 15), totals.stars);
    try std.testing.expectEqual(@as(u64, 1), totals.failing);

    const alpha = repositoryFromValue(dashboard.items[0]).?;
    try std.testing.expectEqualStrings("failure", alpha.runs.ci);
    try std.testing.expectEqualStrings("in_progress", alpha.runs.nightly);
    try std.testing.expectEqualStrings("n/a", alpha.runs.release);

    const beta = repositoryFromValue(dashboard.items[1]).?;
    try std.testing.expectEqualStrings("error", beta.runs.ci);
    try std.testing.expectEqualStrings("error", beta.runs.nightly);
    try std.testing.expectEqualStrings("error", beta.runs.release);

    var errors = LoadErrorIterator.init(dashboard);
    const load_error = errors.next().?;
    try std.testing.expectEqualStrings("beta", load_error.repo);
    try std.testing.expectEqualStrings("rate limited", load_error.message);
    try std.testing.expectEqual(null, errors.next());
}

test "dashboard totals reject counters outside the safe JSON integer domain" {
    const json = try std.fmt.allocPrint(std.testing.allocator,
        \\{{
        \\  "items": [
        \\    {{"slug": "alpha", "openIssues": {d}, "openPulls": {d}, "stars": {d}}},
        \\    {{"slug": "beta", "openIssues": 10, "openPulls": 10, "stars": 10}}
        \\  ]
        \\}}
    , .{
        dashboard_json.max_safe_json_integer,
        dashboard_json.max_safe_json_integer + 1,
        dashboard_json.max_safe_json_integer,
    });
    defer std.testing.allocator.free(json);

    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator, json, .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    const totals = dashboard.totals();

    try std.testing.expectEqual(dashboard_json.max_safe_json_integer + 10, totals.issues);
    try std.testing.expectEqual(@as(u64, 10), totals.pull_requests);
    try std.testing.expectEqual(dashboard_json.max_safe_json_integer + 10, totals.stars);
}

test "dashboard model bounds external collection sizes" {
    var repos_json: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer repos_json.deinit();

    try repos_json.writer.writeAll("{\"items\":[");
    for (0..max_dashboard_repositories + 1) |index| {
        if (index > 0) try repos_json.writer.writeByte(',');
        try repos_json.writer.print("{{\"slug\":\"repo-{d}\"}}", .{index});
    }
    try repos_json.writer.writeAll("]}");

    var parsed_repos = try std.json.parseFromSlice(JsonValue, std.testing.allocator, repos_json.writer.buffered(), .{});
    defer parsed_repos.deinit();

    const bounded_dashboard = Dashboard.init(parsed_repos.value.object);
    try std.testing.expectEqual(@as(usize, max_dashboard_repositories), bounded_dashboard.items.len);

    var nested_json: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer nested_json.deinit();

    try nested_json.writer.writeAll("{\"items\":[{\"slug\":\"alpha\",\"issues\":[");
    for (0..max_work_items_per_repository + 1) |index| {
        if (index > 0) try nested_json.writer.writeByte(',');
        try nested_json.writer.print("{{\"repo\":\"alpha\",\"number\":{d},\"title\":\"issue-{d}\"}}", .{ index + 1, index + 1 });
    }
    try nested_json.writer.writeAll("],\"pullRequests\":[");
    for (0..max_work_items_per_repository + 1) |index| {
        if (index > 0) try nested_json.writer.writeByte(',');
        try nested_json.writer.print("{{\"repo\":\"alpha\",\"number\":{d},\"title\":\"pull-{d}\"}}", .{ index + 1, index + 1 });
    }
    try nested_json.writer.writeAll("]}],\"errors\":[");
    for (0..max_load_errors + 1) |index| {
        if (index > 0) try nested_json.writer.writeByte(',');
        try nested_json.writer.print("{{\"repo\":\"repo-{d}\",\"error\":\"error-{d}\"}}", .{ index, index });
    }
    try nested_json.writer.writeAll("]}");

    var parsed_nested = try std.json.parseFromSlice(JsonValue, std.testing.allocator, nested_json.writer.buffered(), .{});
    defer parsed_nested.deinit();

    const nested_dashboard = Dashboard.init(parsed_nested.value.object);
    const repo = repositoryFromValue(nested_dashboard.items[0]).?;
    try std.testing.expectEqual(@as(usize, max_work_items_per_repository), repo.issues.len);
    try std.testing.expectEqual(@as(usize, max_work_items_per_repository), repo.pull_requests.len);
    try std.testing.expectEqual(@as(usize, max_load_errors), nested_dashboard.errors.len);
}

test "dashboard model treats malformed collection fields as empty" {
    var malformed_root = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"items":"not-array","errors":{"repo":"alpha"}}
    , .{});
    defer malformed_root.deinit();

    const empty_dashboard = Dashboard.init(malformed_root.value.object);
    try std.testing.expectEqual(@as(usize, 0), empty_dashboard.items.len);
    try std.testing.expectEqual(@as(usize, 0), empty_dashboard.errors.len);

    var malformed_nested = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    {"slug": "alpha", "issues": "not-array", "pullRequests": {"number": 7}},
        \\    {"slug": "beta", "issues": [{"number": 8, "title": "Valid issue"}]}
        \\  ],
        \\  "errors": "not-array"
        \\}
    , .{});
    defer malformed_nested.deinit();

    const dashboard = Dashboard.init(malformed_nested.value.object);
    const alpha = repositoryFromValue(dashboard.items[0]).?;
    try std.testing.expectEqual(@as(usize, 0), alpha.issues.len);
    try std.testing.expectEqual(@as(usize, 0), alpha.pull_requests.len);
    try std.testing.expectEqual(@as(usize, 0), dashboard.errors.len);

    var issues = WorkItemIterator.init(dashboard, .issues);
    const issue = issues.next().?;
    try std.testing.expectEqualStrings("beta", issue.repo);
    try std.testing.expectEqual(@as(u64, 8), issue.number);
    try std.testing.expectEqual(null, issues.next());
}

test "dashboard model rejects oversized external text fields" {
    const oversized = [_]u8{'x'} ** 3000;
    const json = try std.fmt.allocPrint(std.testing.allocator,
        \\{{
        \\  "items": [
        \\    {{
        \\      "slug": "{s}",
        \\      "issues": [{{"repo": "{s}", "number": 7, "title": "{s}"}}]
        \\    }}
        \\  ],
        \\  "errors": [{{"repo": "{s}", "error": "{s}"}}]
        \\}}
    , .{ oversized[0..], oversized[0..], oversized[0..], oversized[0..], oversized[0..] });
    defer std.testing.allocator.free(json);

    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator, json, .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    const repo = repositoryFromValue(dashboard.items[0]).?;
    try std.testing.expectEqualStrings("unknown", repo.slug);

    var issues = WorkItemIterator.init(dashboard, .issues);
    try std.testing.expectEqual(null, issues.next());

    var errors = LoadErrorIterator.init(dashboard);
    try std.testing.expectEqual(null, errors.next());
}

test "dashboard model rejects control-bearing external text fields" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    {
        \\      "slug": "alpha\u001b[31m",
        \\      "status": "error\n",
        \\      "latestRuns": {
        \\        "ci": {"status": "completed", "conclusion": "success\u001b[2K"}
        \\      },
        \\      "issues": [{"repo": "alpha\r", "number": 7, "title": "Fix\nbuild"}],
        \\      "pullRequests": [{"repo": "alpha", "number": 8, "title": "Ship release"}]
        \\    }
        \\  ],
        \\  "errors": [{"repo": "beta\u0085", "error": "rate limited\rnow"}]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    const repo = repositoryFromValue(dashboard.items[0]).?;
    try std.testing.expectEqualStrings("unknown", repo.slug);
    try std.testing.expectEqualStrings("completed", repo.runs.ci);
    try std.testing.expect(repo.has_failure);

    var issues = WorkItemIterator.init(dashboard, .issues);
    try std.testing.expectEqual(null, issues.next());

    var pulls = WorkItemIterator.init(dashboard, .pull_requests);
    try std.testing.expectEqual(null, pulls.next());

    var errors = LoadErrorIterator.init(dashboard);
    try std.testing.expectEqual(null, errors.next());
}

test "work item iterator skips invalid rows across repositories" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    "invalid",
        \\    {"slug": "alpha", "issues": [
        \\      "invalid",
        \\      {"repo": "alpha", "number": 0, "title": "Zero"},
        \\      {"repo": "alpha", "title": "Missing number"},
        \\      {"number": 6},
        \\      {"repo": "alpha", "number": 6},
        \\      {"repo": "", "number": 6, "title": "Bad\nTitle"},
        \\      {"repo": "alpha", "number": 6, "title": ""},
        \\      {"repo": "alpha", "number": 1000000000, "title": "Huge number"},
        \\      {"repo": "alpha", "number": 7, "title": "Fix build"}
        \\    ]},
        \\    {"slug": "beta", "issues": [
        \\      {"repo": "beta", "number": "8", "title": "String number"},
        \\      {"repo": "beta", "number": 8, "title": "Ship tag"}
        \\    ]}
        \\  ]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    var issues = WorkItemIterator.init(dashboard, .issues);

    const first = issues.next().?;
    try std.testing.expectEqualStrings("alpha", first.repo);
    try std.testing.expectEqual(@as(u64, 7), first.number);
    try std.testing.expectEqualStrings("Fix build", first.title);

    const second = issues.next().?;
    try std.testing.expectEqualStrings("beta", second.repo);
    try std.testing.expectEqual(@as(u64, 8), second.number);
    try std.testing.expectEqualStrings("Ship tag", second.title);
    try std.testing.expectEqual(null, issues.next());
}

test "work item iterator binds item repos to the parent repository slug" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    {"slug": "alpha", "issues": [
        \\      {"repo": "evil/repo", "number": 7, "title": "Spoofed repo"},
        \\      {"number": 8, "title": "Missing nested repo"}
        \\    ]},
        \\    {"slug": "bad\u001b[31mrepo", "issues": [
        \\      {"repo": "safe", "number": 9, "title": "Unsafe parent"}
        \\    ]}
        \\  ]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    var issues = WorkItemIterator.init(dashboard, .issues);

    const first = issues.next().?;
    try std.testing.expectEqualStrings("alpha", first.repo);
    try std.testing.expectEqual(@as(u64, 7), first.number);
    try std.testing.expectEqualStrings("Spoofed repo", first.title);

    const second = issues.next().?;
    try std.testing.expectEqualStrings("alpha", second.repo);
    try std.testing.expectEqual(@as(u64, 8), second.number);
    try std.testing.expectEqualStrings("Missing nested repo", second.title);

    try std.testing.expectEqual(null, issues.next());
}
