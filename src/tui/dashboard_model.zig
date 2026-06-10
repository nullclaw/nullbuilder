const std = @import("std");

const dashboard_json = @import("dashboard_json.zig");
const dashboard_runs = @import("dashboard_runs.zig");

const JsonValue = dashboard_json.JsonValue;
const JsonObject = dashboard_json.JsonObject;

const empty_values = [_]JsonValue{};

pub const Dashboard = struct {
    items: []const JsonValue,
    errors: []const JsonValue,

    pub fn init(root: JsonObject) !Dashboard {
        const items = dashboard_json.arrayField(root, "items") orelse return error.InvalidDashboardJson;
        const errors = dashboard_json.arrayField(root, "errors") orelse emptyJsonValues();

        return .{
            .items = items,
            .errors = errors,
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
            const list = workItems(repo, self.kind);

            while (self.item_index < list.len) {
                const index = self.item_index;
                self.item_index += 1;
                if (workItemFromValue(list[index])) |item| {
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
    return switch (value) {
        .object => |repo| repositoryFromObject(repo),
        else => null,
    };
}

fn repositoryFromObject(repo: JsonObject) Repository {
    const status = dashboard_json.stringField(repo, "status", "ok");
    const latest = dashboard_json.objectField(repo, "latestRuns");

    return .{
        .slug = dashboard_json.stringField(repo, "slug", "unknown"),
        .open_issues = dashboard_json.intField(repo, "openIssues"),
        .open_pulls = dashboard_json.intField(repo, "openPulls"),
        .stars = dashboard_json.intField(repo, "stars"),
        .runs = dashboard_runs.repositoryRunStatuses(status, latest),
        .has_failure = dashboard_runs.repositoryHasFailure(latest),
        .issues = dashboard_json.arrayField(repo, "issues") orelse emptyJsonValues(),
        .pull_requests = dashboard_json.arrayField(repo, "pullRequests") orelse emptyJsonValues(),
    };
}

fn workItems(repo: Repository, kind: WorkKind) []const JsonValue {
    return switch (kind) {
        .issues => repo.issues,
        .pull_requests => repo.pull_requests,
    };
}

fn workItemFromValue(value: JsonValue) ?WorkItem {
    return switch (value) {
        .object => |work| .{
            .repo = dashboard_json.stringField(work, "repo", ""),
            .number = dashboard_json.intField(work, "number"),
            .title = dashboard_json.stringField(work, "title", ""),
        },
        else => null,
    };
}

fn loadErrorFromValue(value: JsonValue) ?LoadError {
    return switch (value) {
        .object => |load_error| .{
            .repo = dashboard_json.stringField(load_error, "repo", ""),
            .message = dashboard_json.stringField(load_error, "error", ""),
        },
        else => null,
    };
}

fn emptyJsonValues() []const JsonValue {
    return empty_values[0..];
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

    const dashboard = try Dashboard.init(parsed.value.object);
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

test "dashboard totals saturate untrusted counters" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    {"slug": "alpha", "openIssues": 9223372036854775807, "openPulls": 9223372036854775807, "stars": 9223372036854775807},
        \\    {"slug": "beta", "openIssues": 9223372036854775807, "openPulls": 9223372036854775807, "stars": 9223372036854775807},
        \\    {"slug": "gamma", "openIssues": 10, "openPulls": 10, "stars": 10}
        \\  ]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = try Dashboard.init(parsed.value.object);
    const totals = dashboard.totals();

    try std.testing.expectEqual(std.math.maxInt(u64), totals.issues);
    try std.testing.expectEqual(std.math.maxInt(u64), totals.pull_requests);
    try std.testing.expectEqual(std.math.maxInt(u64), totals.stars);
}

test "work item iterator skips invalid rows across repositories" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [
        \\    "invalid",
        \\    {"slug": "alpha", "issues": ["invalid", {"repo": "alpha", "number": 7, "title": "Fix build"}]},
        \\    {"slug": "beta", "issues": [{"repo": "beta", "number": 8, "title": "Ship tag"}]}
        \\  ]
        \\}
    , .{});
    defer parsed.deinit();

    const dashboard = try Dashboard.init(parsed.value.object);
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
