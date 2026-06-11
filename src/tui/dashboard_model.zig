const std = @import("std");

const dashboard_json = @import("dashboard_json.zig");
const dashboard_runs = @import("dashboard_runs.zig");
const repository_safety = @import("repository_safety");

const JsonValue = dashboard_json.JsonValue;
const JsonObject = dashboard_json.JsonObject;

const max_dashboard_repositories = 1000;
const max_load_errors = 200;
const max_text_field_len = 256;
const max_work_items_per_repository = 100;
const max_work_item_number = 999_999_999;
const max_work_title_len = 1024;
const max_error_message_len = 2048;
const ok_status = "ok";
const error_status = "error";

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
        var repo_iter = self.repositories();

        while (repo_iter.next()) |repo| {
            result.repositories += 1;
            if (!repo.loaded) continue;
            result.issues = saturatingAdd(result.issues, repo.open_issues);
            result.pull_requests = saturatingAdd(result.pull_requests, repo.open_pulls);
            result.stars = saturatingAdd(result.stars, repo.stars);
            if (repo.has_failure) result.failing += 1;
        }

        return result;
    }

    pub fn repositories(self: Dashboard) RepositoryIterator {
        return RepositoryIterator.init(self);
    }
};

pub const Repository = struct {
    slug: []const u8,
    loaded: bool,
    open_issues: u64,
    open_pulls: u64,
    stars: u64,
    runs: RunStatuses,
    has_failure: bool,
    issues: []const JsonValue,
    pull_requests: []const JsonValue,
};

pub const RepositoryIterator = struct {
    items: []const JsonValue,
    index: usize = 0,

    pub fn init(dashboard: Dashboard) RepositoryIterator {
        return .{ .items = dashboard.items };
    }

    pub fn next(self: *RepositoryIterator) ?Repository {
        while (self.index < self.items.len) {
            const index = self.index;
            self.index += 1;
            const repo = repositoryFromValue(self.items[index]) orelse continue;
            return repo;
        }

        return null;
    }

    pub fn nextLoaded(self: *RepositoryIterator) ?Repository {
        while (self.next()) |repo| {
            if (repo.loaded) return repo;
        }

        return null;
    }
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
    repositories: RepositoryIterator,
    kind: WorkKind,
    current_repo_slug: []const u8 = "",
    current_items: []const JsonValue = dashboard_json.emptyValues(),
    item_index: usize = 0,

    pub fn init(dashboard: Dashboard, kind: WorkKind) WorkItemIterator {
        return .{
            .repositories = dashboard.repositories(),
            .kind = kind,
        };
    }

    pub fn next(self: *WorkItemIterator) ?WorkItem {
        while (true) {
            while (self.item_index < self.current_items.len) {
                const index = self.item_index;
                self.item_index += 1;
                if (workItemFromValue(self.current_items[index], self.current_repo_slug)) |item| {
                    return item;
                }
            }

            if (!self.loadNextRepository()) return null;
        }
    }

    fn loadNextRepository(self: *WorkItemIterator) bool {
        const repo = self.repositories.nextLoaded() orelse return false;
        self.current_repo_slug = repo.slug;
        self.current_items = workItems(repo, self.kind);
        self.item_index = 0;
        return true;
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

fn repositoryFromObject(repo: JsonObject) ?Repository {
    const slug = safeRepoSlugField(repo, "slug") orelse return null;
    const status = repositoryStatus(repo);
    const loaded = repositoryIsLoaded(status);
    const latest = dashboard_json.objectField(repo, "latestRuns");

    return .{
        .slug = slug,
        .loaded = loaded,
        .open_issues = if (loaded) dashboard_json.safeIntegerField(repo, "openIssues") else 0,
        .open_pulls = if (loaded) dashboard_json.safeIntegerField(repo, "openPulls") else 0,
        .stars = if (loaded) dashboard_json.safeIntegerField(repo, "stars") else 0,
        .runs = dashboard_runs.repositoryRunStatuses(status, latest),
        .has_failure = loaded and dashboard_runs.repositoryHasFailure(latest),
        .issues = if (loaded) dashboard_json.boundedArrayFieldOrEmpty(repo, "issues", max_work_items_per_repository) else dashboard_json.emptyValues(),
        .pull_requests = if (loaded) dashboard_json.boundedArrayFieldOrEmpty(repo, "pullRequests", max_work_items_per_repository) else dashboard_json.emptyValues(),
    };
}

fn repositoryIsLoaded(status: []const u8) bool {
    return std.mem.eql(u8, status, ok_status);
}

fn repositoryStatus(repo: JsonObject) []const u8 {
    if (repo.get("status") == null) return ok_status;
    const status = dashboard_json.requiredSafeTextField(repo, "status", max_text_field_len) orelse return error_status;
    if (std.mem.eql(u8, status, ok_status)) return ok_status;
    if (std.mem.eql(u8, status, error_status)) return error_status;
    return error_status;
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
    const repo = safeRepoSlugField(load_error, "repo") orelse return null;
    const message = dashboard_json.requiredSafeTextField(load_error, "error", max_error_message_len) orelse return null;

    return .{
        .repo = repo,
        .message = message,
    };
}

fn safeRepoSlugField(object: JsonObject, field_name: []const u8) ?[]const u8 {
    const slug = dashboard_json.requiredSafeTextField(
        object,
        field_name,
        repository_safety.max_repository_slug_bytes,
    ) orelse return null;
    return if (repository_safety.isRepositorySlug(slug)) slug else null;
}

fn saturatingAdd(a: u64, b: u64) u64 {
    return a +| b;
}

test "dashboard model collects repository totals and run statuses" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    {
        \\      "slug": "nullclaw/alpha",
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
        \\      "slug": "nullclaw/beta",
        \\      "status": "error",
        \\      "openIssues": 3,
        \\      "openPulls": 0,
        \\      "stars": 5
        \\    }
        \\  ],
        \\  "errors": [{"repo": "nullclaw/beta", "error": "rate limited"}]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    const totals = dashboard.totals();

    try std.testing.expectEqual(@as(u64, 2), totals.repositories);
    try std.testing.expectEqual(@as(u64, 2), totals.issues);
    try std.testing.expectEqual(@as(u64, 1), totals.pull_requests);
    try std.testing.expectEqual(@as(u64, 10), totals.stars);
    try std.testing.expectEqual(@as(u64, 1), totals.failing);

    const alpha = repositoryFromValue(dashboard.items[0]).?;
    try std.testing.expect(alpha.loaded);
    try std.testing.expectEqualStrings("failure", alpha.runs.ci);
    try std.testing.expectEqualStrings("in_progress", alpha.runs.nightly);
    try std.testing.expectEqualStrings("n/a", alpha.runs.release);

    const beta = repositoryFromValue(dashboard.items[1]).?;
    try std.testing.expect(!beta.loaded);
    try std.testing.expectEqualStrings("error", beta.runs.ci);
    try std.testing.expectEqualStrings("error", beta.runs.nightly);
    try std.testing.expectEqualStrings("error", beta.runs.release);

    var errors = LoadErrorIterator.init(dashboard);
    const load_error = errors.next().?;
    try std.testing.expectEqualStrings("nullclaw/beta", load_error.repo);
    try std.testing.expectEqualStrings("rate limited", load_error.message);
    try std.testing.expectEqual(null, errors.next());
}

test "dashboard totals reject counters outside the safe JSON integer domain" {
    const json = try std.fmt.allocPrint(std.testing.allocator,
        \\{{
        \\  "items": [
        \\    {{"slug": "nullclaw/alpha", "openIssues": {d}, "openPulls": {d}, "stars": {d}}},
        \\    {{"slug": "nullclaw/beta", "openIssues": 10, "openPulls": 10, "stars": 10}}
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

test "dashboard totals ignore repositories without safe slugs" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    {"openIssues": 99, "openPulls": 99, "stars": 99},
        \\    {"slug": "bad\nslug", "openIssues": 99, "openPulls": 99, "stars": 99},
        \\    {"slug": "unqualified", "openIssues": 99, "openPulls": 99, "stars": 99},
        \\    {"slug": "bad_owner!/repo", "openIssues": 99, "openPulls": 99, "stars": 99},
        \\    {"slug": "owner/repo.git", "openIssues": 99, "openPulls": 99, "stars": 99},
        \\    {"slug": "nullclaw/valid", "openIssues": 2, "openPulls": 1, "stars": 3, "latestRuns": {"ci": {"status": "completed", "conclusion": "failure"}}}
        \\  ]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    const totals = dashboard.totals();

    try std.testing.expectEqual(@as(u64, 1), totals.repositories);
    try std.testing.expectEqual(@as(u64, 2), totals.issues);
    try std.testing.expectEqual(@as(u64, 1), totals.pull_requests);
    try std.testing.expectEqual(@as(u64, 3), totals.stars);
    try std.testing.expectEqual(@as(u64, 1), totals.failing);
}

test "repository iterator yields only repositories with safe slugs" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    "invalid",
        \\    {"slug": "bad\nslug"},
        \\    {"slug": "missing-owner/"},
        \\    {"slug": "nullclaw/loaded", "status": "ok", "openIssues": 2},
        \\    {"slug": "nullclaw/errored", "status": "error", "openIssues": 99}
        \\  ]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    var repo_iter = dashboard.repositories();

    const loaded = repo_iter.next().?;
    try std.testing.expectEqualStrings("nullclaw/loaded", loaded.slug);
    try std.testing.expect(loaded.loaded);
    try std.testing.expectEqual(@as(u64, 2), loaded.open_issues);

    const errored = repo_iter.next().?;
    try std.testing.expectEqualStrings("nullclaw/errored", errored.slug);
    try std.testing.expect(!errored.loaded);
    try std.testing.expectEqual(@as(u64, 0), errored.open_issues);

    try std.testing.expectEqual(null, repo_iter.next());
}

test "dashboard totals and work iterators ignore errored repository payload counters" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    {
        \\      "slug": "nullclaw/errored",
        \\      "status": "error",
        \\      "openIssues": 99,
        \\      "openPulls": 99,
        \\      "stars": 99,
        \\      "latestRuns": {"ci": {"status": "completed", "conclusion": "failure"}},
        \\      "issues": [{"number": 7, "title": "Hidden issue"}],
        \\      "pullRequests": [{"number": 8, "title": "Hidden PR"}]
        \\    },
        \\    {
        \\      "slug": "nullclaw/loaded",
        \\      "status": "ok",
        \\      "openIssues": 2,
        \\      "openPulls": 1,
        \\      "stars": 3,
        \\      "issues": [{"number": 9, "title": "Visible issue"}],
        \\      "pullRequests": [{"number": 10, "title": "Visible PR"}]
        \\    }
        \\  ]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    const totals = dashboard.totals();
    const errored = repositoryFromValue(dashboard.items[0]).?;

    try std.testing.expectEqual(@as(u64, 2), totals.repositories);
    try std.testing.expectEqual(@as(u64, 2), totals.issues);
    try std.testing.expectEqual(@as(u64, 1), totals.pull_requests);
    try std.testing.expectEqual(@as(u64, 3), totals.stars);
    try std.testing.expectEqual(@as(u64, 0), totals.failing);
    try std.testing.expectEqual(@as(u64, 0), errored.open_issues);
    try std.testing.expectEqual(@as(u64, 0), errored.open_pulls);
    try std.testing.expectEqual(@as(u64, 0), errored.stars);
    try std.testing.expectEqual(@as(usize, 0), errored.issues.len);
    try std.testing.expectEqual(@as(usize, 0), errored.pull_requests.len);

    var issues = WorkItemIterator.init(dashboard, .issues);
    const issue = issues.next().?;
    try std.testing.expectEqualStrings("nullclaw/loaded", issue.repo);
    try std.testing.expectEqual(@as(u64, 9), issue.number);
    try std.testing.expectEqualStrings("Visible issue", issue.title);
    try std.testing.expectEqual(null, issues.next());

    var pulls = WorkItemIterator.init(dashboard, .pull_requests);
    const pull = pulls.next().?;
    try std.testing.expectEqualStrings("nullclaw/loaded", pull.repo);
    try std.testing.expectEqual(@as(u64, 10), pull.number);
    try std.testing.expectEqualStrings("Visible PR", pull.title);
    try std.testing.expectEqual(null, pulls.next());
}

test "dashboard model treats malformed repository statuses as unloaded" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    {"slug": "nullclaw/legacy", "openIssues": 2, "openPulls": 1, "stars": 3},
        \\    {"slug": "nullclaw/explicit", "status": "ok", "openIssues": 5, "openPulls": 8, "stars": 13},
        \\    {"slug": "nullclaw/unknown", "status": "loaded-secret", "openIssues": 99, "openPulls": 99, "stars": 99, "latestRuns": {"ci": {"status": "completed", "conclusion": "success"}}},
        \\    {"slug": "nullclaw/control", "status": "ok\u001b[31m", "openIssues": 99, "openPulls": 99, "stars": 99},
        \\    {"slug": "nullclaw/null", "status": null, "openIssues": 99, "openPulls": 99, "stars": 99}
        \\  ]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    const totals = dashboard.totals();

    try std.testing.expectEqual(@as(u64, 5), totals.repositories);
    try std.testing.expectEqual(@as(u64, 7), totals.issues);
    try std.testing.expectEqual(@as(u64, 9), totals.pull_requests);
    try std.testing.expectEqual(@as(u64, 16), totals.stars);
    try std.testing.expectEqual(@as(u64, 0), totals.failing);

    const legacy = repositoryFromValue(dashboard.items[0]).?;
    try std.testing.expect(legacy.loaded);

    const unknown = repositoryFromValue(dashboard.items[2]).?;
    try std.testing.expect(!unknown.loaded);
    try std.testing.expectEqualStrings(error_status, unknown.runs.ci);
    try std.testing.expectEqualStrings(error_status, unknown.runs.nightly);
    try std.testing.expectEqualStrings(error_status, unknown.runs.release);

    const control = repositoryFromValue(dashboard.items[3]).?;
    try std.testing.expect(!control.loaded);

    const null_status = repositoryFromValue(dashboard.items[4]).?;
    try std.testing.expect(!null_status.loaded);
}

test "dashboard model bounds external collection sizes" {
    var repos_json: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer repos_json.deinit();

    try repos_json.writer.writeAll("{\"items\":[");
    for (0..max_dashboard_repositories + 1) |index| {
        if (index > 0) try repos_json.writer.writeByte(',');
        try repos_json.writer.print("{{\"slug\":\"nullclaw/repo-{d}\"}}", .{index});
    }
    try repos_json.writer.writeAll("]}");

    var parsed_repos = try std.json.parseFromSlice(JsonValue, std.testing.allocator, repos_json.writer.buffered(), .{});
    defer parsed_repos.deinit();

    const bounded_dashboard = Dashboard.init(parsed_repos.value.object);
    try std.testing.expectEqual(@as(usize, max_dashboard_repositories), bounded_dashboard.items.len);

    var nested_json: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer nested_json.deinit();

    try nested_json.writer.writeAll("{\"items\":[{\"slug\":\"nullclaw/alpha\",\"issues\":[");
    for (0..max_work_items_per_repository + 1) |index| {
        if (index > 0) try nested_json.writer.writeByte(',');
        try nested_json.writer.print("{{\"repo\":\"nullclaw/alpha\",\"number\":{d},\"title\":\"issue-{d}\"}}", .{ index + 1, index + 1 });
    }
    try nested_json.writer.writeAll("],\"pullRequests\":[");
    for (0..max_work_items_per_repository + 1) |index| {
        if (index > 0) try nested_json.writer.writeByte(',');
        try nested_json.writer.print("{{\"repo\":\"nullclaw/alpha\",\"number\":{d},\"title\":\"pull-{d}\"}}", .{ index + 1, index + 1 });
    }
    try nested_json.writer.writeAll("]}],\"errors\":[");
    for (0..max_load_errors + 1) |index| {
        if (index > 0) try nested_json.writer.writeByte(',');
        try nested_json.writer.print("{{\"repo\":\"nullclaw/repo-{d}\",\"error\":\"error-{d}\"}}", .{ index, index });
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
        \\    {"slug": "nullclaw/alpha", "issues": "not-array", "pullRequests": {"number": 7}},
        \\    {"slug": "nullclaw/beta", "issues": [{"number": 8, "title": "Valid issue"}]}
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
    try std.testing.expectEqualStrings("nullclaw/beta", issue.repo);
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
    try std.testing.expect(repositoryFromValue(dashboard.items[0]) == null);

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
        \\      "slug": "nullclaw/alpha\u001b[31m",
        \\      "status": "error\n",
        \\      "latestRuns": {
        \\        "ci": {"status": "completed", "conclusion": "success\u001b[2K"}
        \\      },
        \\      "issues": [{"repo": "nullclaw/alpha\r", "number": 7, "title": "Fix\nbuild"}],
        \\      "pullRequests": [{"repo": "nullclaw/alpha", "number": 8, "title": "Ship release"}]
        \\    }
        \\  ],
        \\  "errors": [{"repo": "nullclaw/beta\u0085", "error": "rate limited\rnow"}]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    try std.testing.expect(repositoryFromValue(dashboard.items[0]) == null);

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
        \\    {"slug": "nullclaw/alpha", "issues": [
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
        \\    {"slug": "nullclaw/beta", "issues": [
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
    try std.testing.expectEqualStrings("nullclaw/alpha", first.repo);
    try std.testing.expectEqual(@as(u64, 7), first.number);
    try std.testing.expectEqualStrings("Fix build", first.title);

    const second = issues.next().?;
    try std.testing.expectEqualStrings("nullclaw/beta", second.repo);
    try std.testing.expectEqual(@as(u64, 8), second.number);
    try std.testing.expectEqualStrings("Ship tag", second.title);
    try std.testing.expectEqual(null, issues.next());
}

test "work item iterator binds item repos to the parent repository slug" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    {"slug": "nullclaw/alpha", "issues": [
        \\      {"repo": "evil/repo", "number": 7, "title": "Spoofed repo"},
        \\      {"number": 8, "title": "Missing nested repo"}
        \\    ]},
        \\    {"slug": "nullclaw/bad\u001b[31mrepo", "issues": [
        \\      {"repo": "safe", "number": 9, "title": "Unsafe parent"}
        \\    ]}
        \\  ]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = Dashboard.init(parsed.value.object);
    var issues = WorkItemIterator.init(dashboard, .issues);

    const first = issues.next().?;
    try std.testing.expectEqualStrings("nullclaw/alpha", first.repo);
    try std.testing.expectEqual(@as(u64, 7), first.number);
    try std.testing.expectEqualStrings("Spoofed repo", first.title);

    const second = issues.next().?;
    try std.testing.expectEqualStrings("nullclaw/alpha", second.repo);
    try std.testing.expectEqual(@as(u64, 8), second.number);
    try std.testing.expectEqualStrings("Missing nested repo", second.title);

    try std.testing.expectEqual(null, issues.next());
}
