const std = @import("std");

const dashboard_json = @import("dashboard_json.zig");

const JsonValue = dashboard_json.JsonValue;
const JsonObject = dashboard_json.JsonObject;

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
    const items = dashboard_json.arrayField(root, "items") orelse return error.InvalidDashboardJson;

    const totals = collectTotals(items);

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

    for (items) |item| {
        if (item != .object) continue;
        const repo = item.object;
        const slug = dashboard_json.stringField(repo, "slug", "unknown");
        const status = dashboard_json.stringField(repo, "status", "ok");
        const latest = dashboard_json.objectField(repo, "latestRuns");
        const ci = if (std.mem.eql(u8, status, "error")) "error" else if (latest) |latest_runs| runLabel(latest_runs, "ci") else "n/a";
        const nightly = if (std.mem.eql(u8, status, "error")) "error" else if (latest) |latest_runs| runLabel(latest_runs, "nightly") else "n/a";
        const release = if (std.mem.eql(u8, status, "error")) "error" else if (latest) |latest_runs| runLabel(latest_runs, "release") else "n/a";

        try out.print("{s:<28} {d:>6} {d:>6} ", .{
            clipUtf8(slug, 28),
            dashboard_json.intField(repo, "openIssues"),
            dashboard_json.intField(repo, "openPulls"),
        });
        try printStatus(out, no_color, ci, 12);
        try out.writeByte(' ');
        try printStatus(out, no_color, nightly, 12);
        try out.writeByte(' ');
        try printStatus(out, no_color, release, 12);
        try out.writeByte('\n');
    }

    try out.writeAll("\nRecent work\n");
    try out.writeAll("-----------\n");
    try printWorkItems(out, items, "issues", "open issues");
    try printWorkItems(out, items, "pullRequests", "open pull requests");

    if (dashboard_json.arrayField(root, "errors")) |errors| {
        if (errors.len > 0) {
            try out.writeAll("\nLoad errors\n");
            try out.writeAll("-----------\n");
            for (errors) |error_item| {
                if (error_item != .object) continue;
                const load_error = error_item.object;
                try out.print("  {s:<28} {s}\n", .{
                    clipUtf8(dashboard_json.stringField(load_error, "repo", ""), 28),
                    clipUtf8(dashboard_json.stringField(load_error, "error", ""), 90),
                });
            }
        }
    }
}

fn collectTotals(items: []const JsonValue) Totals {
    var totals = Totals{};

    for (items) |item| {
        if (item != .object) continue;
        const repo = item.object;
        totals.repositories += 1;
        totals.issues += dashboard_json.intField(repo, "openIssues");
        totals.pull_requests += dashboard_json.intField(repo, "openPulls");
        totals.stars += dashboard_json.intField(repo, "stars");
        if (repoHasFailure(repo)) totals.failing += 1;
    }

    return totals;
}

fn printWorkItems(out: *std.Io.Writer, repos: []const JsonValue, field_name: []const u8, label: []const u8) !void {
    var printed: usize = 0;

    for (repos) |item| {
        if (printed >= max_recent_work_items) break;
        if (item != .object) continue;
        const repo = item.object;
        const list = dashboard_json.arrayField(repo, field_name) orelse continue;

        for (list) |work_item| {
            if (printed >= max_recent_work_items) break;
            if (work_item != .object) continue;
            const work = work_item.object;
            try out.print("  {s:<28} #{d:<5} {s}\n", .{
                clipUtf8(dashboard_json.stringField(work, "repo", ""), 28),
                dashboard_json.intField(work, "number"),
                clipUtf8(dashboard_json.stringField(work, "title", ""), 74),
            });
            printed += 1;
        }
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

fn repoHasFailure(repo: JsonObject) bool {
    const latest = dashboard_json.objectField(repo, "latestRuns") orelse return false;
    return isFailedRun(latest, "ci") or isFailedRun(latest, "nightly") or isFailedRun(latest, "release");
}

fn isFailedRun(latest: JsonObject, field_name: []const u8) bool {
    const run = dashboard_json.objectField(latest, field_name) orelse return false;
    const status = dashboard_json.stringField(run, "status", "");
    if (!std.mem.eql(u8, status, "completed")) return false;
    return !std.mem.eql(u8, dashboard_json.stringField(run, "conclusion", ""), "success");
}

fn runLabel(latest: JsonObject, field_name: []const u8) []const u8 {
    const run = dashboard_json.objectField(latest, field_name) orelse return "n/a";
    const status = dashboard_json.stringField(run, "status", "");
    if (!std.mem.eql(u8, status, "completed")) return status;
    return dashboard_json.stringField(run, "conclusion", "completed");
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

const Totals = struct {
    repositories: u64 = 0,
    issues: u64 = 0,
    pull_requests: u64 = 0,
    stars: u64 = 0,
    failing: u64 = 0,
};

test "clipUtf8 does not split multibyte sequences" {
    const text = "repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82";

    try std.testing.expectEqualStrings("repo-", clipUtf8(text, 6));
    try std.testing.expectEqualStrings("repo-\xd0\xbf", clipUtf8(text, 7));
    try std.testing.expectEqualStrings("", clipUtf8(text, 0));
}

test "runLabel reports active completed and missing runs" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "ci":{"status":"completed","conclusion":"failure"},
        \\  "nightly":{"status":"in_progress"}
        \\}
    , .{});
    defer parsed.deinit();
    const latest = parsed.value.object;

    try std.testing.expectEqualStrings("failure", runLabel(latest, "ci"));
    try std.testing.expectEqualStrings("in_progress", runLabel(latest, "nightly"));
    try std.testing.expectEqualStrings("n/a", runLabel(latest, "release"));
}
