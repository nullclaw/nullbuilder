const std = @import("std");

const dashboard_model = @import("dashboard_model.zig");
const dashboard_json = @import("dashboard_json.zig");

const JsonValue = dashboard_json.JsonValue;
const Dashboard = dashboard_model.Dashboard;
const WorkKind = dashboard_model.WorkKind;

const green = "\x1b[32m";
const yellow = "\x1b[33m";
const red = "\x1b[31m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

const max_recent_work_items = 8;

pub fn render(
    arena: std.mem.Allocator,
    out: *std.Io.Writer,
    json: []const u8,
    no_color: bool,
) !void {
    var parsed = try std.json.parseFromSlice(JsonValue, arena, json, .{});
    defer parsed.deinit();

    const root = switch (parsed.value) {
        .object => |object| object,
        else => return error.InvalidDashboardJson,
    };
    const dashboard = try Dashboard.init(root);
    const totals = dashboard.totals();

    try out.print("nullbuilder command center\n", .{});
    try out.print("{s}{d} repos{s}  {d} issues  {d} PRs  {d} stars  {d} failing\n\n", .{
        color(no_color, dim),
        totals.repositories,
        color(no_color, reset),
        totals.issues,
        totals.pull_requests,
        totals.stars,
        totals.failing,
    });

    try out.print("{s:<28} {s:>6} {s:>6} {s:<12} {s:<12} {s:<12}\n", .{ "repo", "issues", "prs", "ci", "nightly", "release" });
    try out.writeAll("--------------------------------------------------------------------------------\n");

    for (dashboard.items) |item| {
        const repo = dashboard_model.repositoryFromValue(item) orelse continue;

        try out.print("{s:<28} {d:>6} {d:>6} ", .{
            clipUtf8(repo.slug, 28),
            repo.open_issues,
            repo.open_pulls,
        });
        try printStatus(out, no_color, repo.runs.ci, 12);
        try out.writeByte(' ');
        try printStatus(out, no_color, repo.runs.nightly, 12);
        try out.writeByte(' ');
        try printStatus(out, no_color, repo.runs.release, 12);
        try out.writeByte('\n');
    }

    try out.writeAll("\nRecent work\n");
    try out.writeAll("-----------\n");
    try printWorkItems(out, dashboard, .issues, "open issues");
    try printWorkItems(out, dashboard, .pull_requests, "open pull requests");

    if (dashboard.errors.len > 0) {
        try out.writeAll("\nLoad errors\n");
        try out.writeAll("-----------\n");
        var errors = dashboard_model.LoadErrorIterator.init(dashboard);
        while (errors.next()) |load_error| {
            try out.print("  {s:<28} {s}\n", .{
                clipUtf8(load_error.repo, 28),
                clipUtf8(load_error.message, 90),
            });
        }
    }
}

fn printWorkItems(out: *std.Io.Writer, dashboard: Dashboard, kind: WorkKind, label: []const u8) !void {
    var printed: usize = 0;
    var items = dashboard_model.WorkItemIterator.init(dashboard, kind);

    while (printed < max_recent_work_items) {
        const work = items.next() orelse break;
        try out.print("  {s:<28} #{d:<5} {s}\n", .{
            clipUtf8(work.repo, 28),
            work.number,
            clipUtf8(work.title, 74),
        });
        printed += 1;
    }

    if (printed == 0) {
        try out.print("  no {s}\n", .{label});
    }
}

fn printStatus(out: *std.Io.Writer, no_color: bool, status: []const u8, width: usize) !void {
    try out.writeAll(statusColor(no_color, status));
    try out.print("{s:<12}", .{clipUtf8(status, width)});
    try out.writeAll(color(no_color, reset));
}

fn statusColor(no_color: bool, status: []const u8) []const u8 {
    if (no_color) return "";
    if (std.mem.eql(u8, status, "success")) return green;
    if (std.mem.eql(u8, status, "queued") or std.mem.eql(u8, status, "in_progress")) return yellow;
    if (std.mem.eql(u8, status, "n/a")) return dim;
    if (std.mem.eql(u8, status, "failure") or std.mem.eql(u8, status, "cancelled") or std.mem.eql(u8, status, "timed_out") or std.mem.eql(u8, status, "error")) return red;
    return "";
}

fn color(no_color: bool, code: []const u8) []const u8 {
    return if (no_color) "" else code;
}

fn clipUtf8(value: []const u8, max_len: usize) []const u8 {
    if (value.len <= max_len) return value;
    if (max_len == 0) return "";

    var end = max_len;
    while (end > 0 and isUtf8ContinuationByte(value[end])) {
        end -= 1;
    }

    return value[0..end];
}

fn isUtf8ContinuationByte(byte: u8) bool {
    return byte & 0b1100_0000 == 0b1000_0000;
}

test "clipUtf8 does not split multibyte sequences" {
    const text = "repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82";

    try std.testing.expectEqualStrings("repo-", clipUtf8(text, 6));
    try std.testing.expectEqualStrings("repo-\xd0\xbf", clipUtf8(text, 7));
    try std.testing.expectEqualStrings("", clipUtf8(text, 0));
}

test "render prints repository rows recent work and load errors" {
    const json =
        \\{
        \\  "items": [
        \\    {
        \\      "slug": "alpha",
        \\      "status": "ok",
        \\      "openIssues": 2,
        \\      "openPulls": 1,
        \\      "stars": 42,
        \\      "latestRuns": {
        \\        "ci": {"status": "completed", "conclusion": "success"},
        \\        "nightly": {"status": "queued"},
        \\        "release": {"status": "completed", "conclusion": "cancelled"}
        \\      },
        \\      "issues": [{"repo": "alpha", "number": 7, "title": "Fix build"}],
        \\      "pullRequests": [{"repo": "alpha", "number": 9, "title": "Ship release"}]
        \\    }
        \\  ],
        \\  "errors": [{"repo": "beta", "error": "rate limited"}]
        \\}
    ;
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try render(std.testing.allocator, &out.writer, json, true);
    const output = out.writer.buffered();

    try expectContains(output, "nullbuilder command center\n");
    try expectContains(output, "1 repos  2 issues  1 PRs  42 stars  1 failing");
    try expectContains(output, "alpha");
    try expectContains(output, "success");
    try expectContains(output, "queued");
    try expectContains(output, "cancelled");
    try expectContains(output, "#7");
    try expectContains(output, "#9");
    try expectContains(output, "Load errors");
    try expectContains(output, "rate limited");
}

fn expectContains(haystack: []const u8, needle: []const u8) !void {
    try std.testing.expect(std.mem.indexOf(u8, haystack, needle) != null);
}
