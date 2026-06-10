const std = @import("std");

const dashboard_model = @import("dashboard_model.zig");
const dashboard_json = @import("dashboard_json.zig");
const terminal = @import("terminal.zig");

const JsonValue = dashboard_json.JsonValue;
const Dashboard = dashboard_model.Dashboard;
const WorkKind = dashboard_model.WorkKind;

const green = "\x1b[32m";
const yellow = "\x1b[33m";
const red = "\x1b[31m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

const repo_column_width: usize = 28;
const count_column_width: usize = 6;
const status_column_width: usize = 12;
const work_number_width: usize = 5;
const work_title_width: usize = 74;
const error_message_width: usize = 90;
const max_recent_work_items = 8;

pub const max_json_bytes = 16 * 1024 * 1024;

pub fn render(
    arena: std.mem.Allocator,
    out: *std.Io.Writer,
    json: []const u8,
    no_color: bool,
) !void {
    if (json.len > max_json_bytes) return error.DashboardJsonTooLarge;

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

    try out.print("{s:<[6]} {s:>[7]} {s:>[7]} {s:<[8]} {s:<[8]} {s:<[8]}\n", .{
        "repo",
        "issues",
        "prs",
        "ci",
        "nightly",
        "release",
        repo_column_width,
        count_column_width,
        status_column_width,
    });
    try out.writeAll("--------------------------------------------------------------------------------\n");

    for (dashboard.items) |item| {
        const repo = dashboard_model.repositoryFromValue(item) orelse continue;
        const repo_slug = try sanitizeTerminalText(arena, repo.slug);
        defer repo_slug.deinit(arena);
        var issues_buffer: [count_column_width]u8 = undefined;
        var pulls_buffer: [count_column_width]u8 = undefined;

        try out.print("{s:<[3]} {s:>[4]} {s:>[4]} ", .{
            terminal.clipUtf8(repo_slug.value, repo_column_width),
            formatBoundedNumber(issues_buffer[0..], repo.open_issues),
            formatBoundedNumber(pulls_buffer[0..], repo.open_pulls),
            repo_column_width,
            count_column_width,
        });
        try printStatus(arena, out, no_color, repo.runs.ci, status_column_width);
        try out.writeByte(' ');
        try printStatus(arena, out, no_color, repo.runs.nightly, status_column_width);
        try out.writeByte(' ');
        try printStatus(arena, out, no_color, repo.runs.release, status_column_width);
        try out.writeByte('\n');
    }

    try out.writeAll("\nRecent work\n");
    try out.writeAll("-----------\n");
    try printWorkItems(arena, out, dashboard, .issues, "open issues");
    try printWorkItems(arena, out, dashboard, .pull_requests, "open pull requests");

    if (dashboard.errors.len > 0) {
        try out.writeAll("\nLoad errors\n");
        try out.writeAll("-----------\n");
        var errors = dashboard_model.LoadErrorIterator.init(dashboard);
        while (errors.next()) |load_error| {
            const error_repo = try sanitizeTerminalText(arena, load_error.repo);
            defer error_repo.deinit(arena);
            const message = try sanitizeTerminalText(arena, load_error.message);
            defer message.deinit(arena);

            try out.print("  {s:<[2]} {s}\n", .{
                terminal.clipUtf8(error_repo.value, repo_column_width),
                terminal.clipUtf8(message.value, error_message_width),
                repo_column_width,
            });
        }
    }
}

fn printWorkItems(
    arena: std.mem.Allocator,
    out: *std.Io.Writer,
    dashboard: Dashboard,
    kind: WorkKind,
    label: []const u8,
) !void {
    var printed: usize = 0;
    var items = dashboard_model.WorkItemIterator.init(dashboard, kind);

    while (printed < max_recent_work_items) {
        const work = items.next() orelse break;
        const work_repo = try sanitizeTerminalText(arena, work.repo);
        defer work_repo.deinit(arena);
        const title = try sanitizeTerminalText(arena, work.title);
        defer title.deinit(arena);
        var number_buffer: [work_number_width]u8 = undefined;

        try out.print("  {s:<[3]} #{s:<[4]} {s}\n", .{
            terminal.clipUtf8(work_repo.value, repo_column_width),
            formatBoundedNumber(number_buffer[0..], work.number),
            terminal.clipUtf8(title.value, work_title_width),
            repo_column_width,
            work_number_width,
        });
        printed += 1;
    }

    if (printed == 0) {
        try out.print("  no {s}\n", .{label});
    }
}

fn printStatus(arena: std.mem.Allocator, out: *std.Io.Writer, no_color: bool, status: []const u8, width: usize) !void {
    const safe_status = try sanitizeTerminalText(arena, status);
    defer safe_status.deinit(arena);

    try out.writeAll(statusColor(no_color, safe_status.value));
    try out.print("{s:<[1]}", .{ terminal.clipUtf8(safe_status.value, width), width });
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

fn formatBoundedNumber(buffer: []u8, value: u64) []const u8 {
    if (buffer.len == 0) return "";
    return std.fmt.bufPrint(buffer, "{d}", .{value}) catch overflowNumberLabel(buffer);
}

fn overflowNumberLabel(buffer: []u8) []const u8 {
    if (buffer.len == 0) return "";
    if (buffer.len == 1) {
        buffer[0] = '+';
        return buffer;
    }

    @memset(buffer[0 .. buffer.len - 1], '9');
    buffer[buffer.len - 1] = '+';
    return buffer;
}

fn sanitizeTerminalText(arena: std.mem.Allocator, value: []const u8) !terminal.SanitizedText {
    return terminal.sanitizeMaybeAlloc(arena, value, .{});
}

test "sanitizeTerminalText replaces UTF-8 encoded C1 controls" {
    const safe = try sanitizeTerminalText(std.testing.allocator, "safe\xc2\x9bcontrol\xc2\x85next");
    defer safe.deinit(std.testing.allocator);

    try std.testing.expect(safe.allocated);
    try std.testing.expectEqualStrings("safe control next", safe.value);
    try std.testing.expect(std.mem.indexOf(u8, safe.value, "\xc2\x9b") == null);
    try std.testing.expect(std.mem.indexOf(u8, safe.value, "\xc2\x85") == null);
}

test "printStatus honors requested display width" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try printStatus(std.testing.allocator, &out.writer, true, "queued", 8);
    try std.testing.expectEqualStrings("queued  ", out.writer.buffered());

    out.clearRetainingCapacity();
    try printStatus(std.testing.allocator, &out.writer, true, "in_progress", 4);
    try std.testing.expectEqualStrings("in_p", out.writer.buffered());
}

test "formatBoundedNumber keeps terminal columns fixed" {
    var count_buffer: [count_column_width]u8 = undefined;
    var work_number_buffer: [work_number_width]u8 = undefined;

    try std.testing.expectEqualStrings("42", formatBoundedNumber(count_buffer[0..], 42));
    try std.testing.expectEqualStrings("999999", formatBoundedNumber(count_buffer[0..], 999_999));
    try std.testing.expectEqualStrings("99999+", formatBoundedNumber(count_buffer[0..], 1_000_000));
    try std.testing.expectEqualStrings("9999+", formatBoundedNumber(work_number_buffer[0..], 100_000));
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

test "render caps numeric columns from external dashboard json" {
    const json =
        \\{
        \\  "items": [
        \\    {
        \\      "slug": "alpha",
        \\      "openIssues": 1000000,
        \\      "openPulls": 9007199254740991,
        \\      "issues": [{"repo": "alpha", "number": 100000, "title": "Large external number"}]
        \\    }
        \\  ]
        \\}
    ;
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try render(std.testing.allocator, &out.writer, json, true);
    const output = out.writer.buffered();

    try expectContains(output, "99999+ 99999+");
    try expectContains(output, "#9999+");
}

test "render sanitizes terminal control characters from external text" {
    const json =
        \\{
        \\  "items": [
        \\    {
        \\      "slug": "alpha\u001b[31mred\u001b[0m",
        \\      "status": "ok",
        \\      "openIssues": 1,
        \\      "openPulls": 0,
        \\      "stars": 3,
        \\      "latestRuns": {
        \\        "ci": {"status": "completed", "conclusion": "success\u001b[2K"}
        \\      },
        \\      "issues": [{"repo": "alpha\u001b[31mred\u001b[0m", "number": 7, "title": "Fix \u001b[31mred\u001b[0m\nnext\titem"}]
        \\    }
        \\  ],
        \\  "errors": [{"repo": "beta\u001b]0;title\u0007", "error": "rate limited\rnow"}]
        \\}
    ;
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try render(std.testing.allocator, &out.writer, json, true);
    const output = out.writer.buffered();

    try std.testing.expect(std.mem.indexOfScalar(u8, output, terminal.ascii_escape) == null);
    try expectContains(output, "alphared");
    try expectContains(output, "success");
    try expectContains(output, "Fix red next item");
    try expectContains(output, "rate limited now");
}

test "render rejects oversized dashboard json before parsing" {
    const json = try std.testing.allocator.alloc(u8, max_json_bytes + 1);
    defer std.testing.allocator.free(json);
    @memset(json, ' ');

    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try std.testing.expectError(error.DashboardJsonTooLarge, render(std.testing.allocator, &out.writer, json, true));
    try std.testing.expectEqual(@as(usize, 0), out.writer.buffered().len);
}

fn expectContains(haystack: []const u8, needle: []const u8) !void {
    try std.testing.expect(std.mem.indexOf(u8, haystack, needle) != null);
}
