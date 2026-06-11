const std = @import("std");

const dashboard_model = @import("dashboard_model.zig");
const dashboard_json = @import("dashboard_json.zig");
const dashboard_runs = @import("dashboard_runs.zig");
const terminal = @import("terminal.zig");

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
const max_rendered_load_errors = 8;

pub const max_json_bytes = 16 * 1024 * 1024;
const max_json_value_bytes = 64 * 1024;

pub fn render(
    arena: std.mem.Allocator,
    out: *std.Io.Writer,
    json: []const u8,
    no_color: bool,
) !void {
    var parsed = try parseDashboardJson(arena, json);
    defer parsed.deinit();

    const root = dashboard_json.objectValue(parsed.value) orelse return error.InvalidDashboardJson;
    const dashboard = Dashboard.init(root);
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

    var repo_iter = dashboard.repositories();
    while (repo_iter.next()) |repo| {
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
        try printStatus(out, no_color, repo.runs.ci, status_column_width);
        try out.writeByte(' ');
        try printStatus(out, no_color, repo.runs.nightly, status_column_width);
        try out.writeByte(' ');
        try printStatus(out, no_color, repo.runs.release, status_column_width);
        try out.writeByte('\n');
    }

    try out.writeAll("\nRecent work\n");
    try out.writeAll("-----------\n");
    try printWorkItems(arena, out, dashboard, .issues);
    try printWorkItems(arena, out, dashboard, .pull_requests);

    try printLoadErrors(arena, out, dashboard);
}

fn parseDashboardJson(arena: std.mem.Allocator, json: []const u8) !std.json.Parsed(dashboard_json.JsonValue) {
    return dashboard_json.parseBoundedValue(arena, json, .{
        .max_bytes = max_json_bytes,
        .max_value_bytes = max_json_value_bytes,
    }) catch |err| switch (err) {
        error.JsonTooLarge => error.DashboardJsonTooLarge,
        else => err,
    };
}

fn printWorkItems(
    arena: std.mem.Allocator,
    out: *std.Io.Writer,
    dashboard: Dashboard,
    kind: WorkKind,
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
        try out.print("  no {s}\n", .{kind.emptyLabel()});
    }
}

fn printLoadErrors(arena: std.mem.Allocator, out: *std.Io.Writer, dashboard: Dashboard) !void {
    var errors = dashboard_model.LoadErrorIterator.init(dashboard);
    var printed: usize = 0;

    while (printed < max_rendered_load_errors) {
        const load_error = errors.next() orelse break;
        if (printed == 0) {
            try out.writeAll("\nLoad errors\n");
            try out.writeAll("-----------\n");
        }
        try printLoadError(arena, out, load_error);
        printed += 1;
    }

    if (printed > 0 and errors.next() != null) {
        try out.writeAll("  ... more load errors omitted\n");
    }
}

fn printLoadError(arena: std.mem.Allocator, out: *std.Io.Writer, load_error: dashboard_model.LoadError) !void {
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

fn printStatus(out: *std.Io.Writer, no_color: bool, status: dashboard_runs.RunLabel, width: usize) !void {
    try out.writeAll(statusColor(no_color, status));
    try out.print("{s:<[1]}", .{ terminal.clipUtf8(status.text(), width), width });
    try out.writeAll(color(no_color, reset));
}

fn statusColor(no_color: bool, status: dashboard_runs.RunLabel) []const u8 {
    if (no_color) return "";
    if (dashboard_runs.isSuccessLabel(status)) return green;
    if (dashboard_runs.isRunningLabel(status)) return yellow;
    if (dashboard_runs.isMissingLabel(status)) return dim;
    if (dashboard_runs.isFailureLabel(status)) return red;
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
    const safe = try sanitizeTerminalText(std.testing.allocator, "safe\xc2\x85control\xc2\x85next");
    defer safe.deinit(std.testing.allocator);

    try std.testing.expect(safe.allocated);
    try std.testing.expectEqualStrings("safe control next", safe.value);
    try std.testing.expect(std.mem.indexOf(u8, safe.value, "\xc2\x85") == null);
}

test "printStatus honors requested display width" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try printStatus(&out.writer, true, .queued, 8);
    try std.testing.expectEqualStrings("queued  ", out.writer.buffered());

    out.clearRetainingCapacity();
    try printStatus(&out.writer, true, .in_progress, 4);
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
        \\      "slug": "nullclaw/alpha",
        \\      "status": "ok",
        \\      "openIssues": 2,
        \\      "openPulls": 1,
        \\      "stars": 42,
        \\      "latestRuns": {
        \\        "ci": {"status": "completed", "conclusion": "success"},
        \\        "nightly": {"status": "queued"},
        \\        "release": {"status": "completed", "conclusion": "cancelled"}
        \\      },
        \\      "issues": [{"repo": "nullclaw/alpha", "number": 7, "title": "Fix build"}],
        \\      "pullRequests": [{"repo": "nullclaw/alpha", "number": 9, "title": "Ship release"}]
        \\    }
        \\  ],
        \\  "errors": [{"repo": "nullclaw/beta", "error": "rate limited"}]
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
        \\      "slug": "nullclaw/alpha",
        \\      "openIssues": 1000000,
        \\      "openPulls": 9007199254740991,
        \\      "issues": [{"repo": "nullclaw/alpha", "number": 100000, "title": "Large external number"}]
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

test "render falls back for empty external status labels" {
    const json =
        \\{
        \\  "items": [
        \\    {
        \\      "slug": "nullclaw/alpha",
        \\      "status": "ok",
        \\      "latestRuns": {
        \\        "ci": {"status": ""},
        \\        "nightly": {"status": "completed", "conclusion": ""},
        \\        "release": {"status": "completed", "conclusion": "success"}
        \\      }
        \\    }
        \\  ]
        \\}
    ;
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try render(std.testing.allocator, &out.writer, json, true);
    const output = out.writer.buffered();

    try expectContains(output, "n/a");
    try expectContains(output, "completed");
    try expectContains(output, "success");
    try expectContains(output, "1 failing");
}

test "render canonicalizes unknown workflow labels before terminal output" {
    const json =
        \\{
        \\  "items": [
        \\    {
        \\      "slug": "nullclaw/alpha",
        \\      "latestRuns": {
        \\        "ci": {"status": "deploying-secret"},
        \\        "nightly": {"status": "completed", "conclusion": "private-secret"},
        \\        "release": {"status": "completed", "conclusion": "action_required"}
        \\      }
        \\    }
        \\  ]
        \\}
    ;
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try render(std.testing.allocator, &out.writer, json, true);
    const output = out.writer.buffered();

    try expectContains(output, "n/a");
    try expectContains(output, "failure");
    try expectContains(output, "action_requi");
    try std.testing.expect(std.mem.indexOf(u8, output, "deploying-secret") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "private-secret") == null);
}

test "render treats malformed repository statuses as unloaded" {
    const json =
        \\{
        \\  "items": [
        \\    {
        \\      "slug": "nullclaw/unknown",
        \\      "status": "loaded-secret",
        \\      "openIssues": 99,
        \\      "openPulls": 99,
        \\      "stars": 99,
        \\      "latestRuns": {
        \\        "ci": {"status": "completed", "conclusion": "success"}
        \\      },
        \\      "issues": [{"number": 7, "title": "Hidden issue"}]
        \\    },
        \\    {
        \\      "slug": "nullclaw/loaded",
        \\      "status": "ok",
        \\      "openIssues": 2,
        \\      "openPulls": 1,
        \\      "stars": 3,
        \\      "issues": [{"number": 8, "title": "Visible issue"}]
        \\    }
        \\  ]
        \\}
    ;
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try render(std.testing.allocator, &out.writer, json, true);
    const output = out.writer.buffered();

    try expectContains(output, "2 repos  2 issues  1 PRs  3 stars  0 failing");
    try expectContains(output, "unknown");
    try expectContains(output, "error");
    try expectContains(output, "Visible issue");
    try std.testing.expect(std.mem.indexOf(u8, output, "loaded-secret") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "Hidden issue") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "99") == null);
}

test "render treats malformed dashboard collections as empty" {
    const json =
        \\{
        \\  "items": "not-array",
        \\  "errors": {"repo": "alpha", "error": "hidden"}
        \\}
    ;
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try render(std.testing.allocator, &out.writer, json, true);
    const output = out.writer.buffered();

    try expectContains(output, "0 repos  0 issues  0 PRs  0 stars  0 failing");
    try expectContains(output, "no open issues");
    try expectContains(output, "no open pull requests");
    try std.testing.expect(std.mem.indexOf(u8, output, "Load errors") == null);
}

test "render bounds load error rows from external dashboard json" {
    var json: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer json.deinit();

    try json.writer.writeAll("{\"errors\":[");
    for (0..max_rendered_load_errors + 2) |index| {
        if (index > 0) try json.writer.writeByte(',');
        try json.writer.print("{{\"repo\":\"nullclaw/repo-{d}\",\"error\":\"error-{d}\"}}", .{ index, index });
    }
    try json.writer.writeAll("]}");

    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try render(std.testing.allocator, &out.writer, json.writer.buffered(), true);
    const output = out.writer.buffered();

    try expectContains(output, "Load errors");
    try expectContains(output, "repo-0");
    try expectContains(output, "error-0");
    try expectContains(output, "repo-7");
    try expectContains(output, "error-7");
    try expectContains(output, "more load errors omitted");
    try std.testing.expect(std.mem.indexOf(u8, output, "repo-8") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "error-8") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "repo-9") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "error-9") == null);
}

test "render does not echo terminal control characters from external text" {
    const json =
        \\{
        \\  "items": [
        \\    {
        \\      "slug": "nullclaw/alpha\u001b[31mred\u001b[0m",
        \\      "status": "ok",
        \\      "openIssues": 1,
        \\      "openPulls": 0,
        \\      "stars": 3,
        \\      "latestRuns": {
        \\        "ci": {"status": "completed", "conclusion": "success\u001b[2K"}
        \\      },
        \\      "issues": [{"repo": "nullclaw/alpha\u001b[31mred\u001b[0m", "number": 7, "title": "Fix \u001b[31mred\u001b[0m\nnext\titem"}]
        \\    }
        \\  ],
        \\  "errors": [{"repo": "nullclaw/beta\u001b]0;title\u0007", "error": "rate limited\rnow"}]
        \\}
    ;
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try render(std.testing.allocator, &out.writer, json, true);
    const output = out.writer.buffered();

    try std.testing.expect(std.mem.indexOfScalar(u8, output, terminal.ascii_escape) == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "alphared") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "success") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "Fix red next item") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "rate limited now") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "unknown") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "completed") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "Load errors") == null);
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

test "render rejects oversized json scalar values during parsing" {
    const oversized = [_]u8{'x'} ** (max_json_value_bytes + 1);
    const json = try std.fmt.allocPrint(std.testing.allocator,
        \\{{
        \\  "items": [
        \\    {{"slug": "nullclaw/alpha", "issues": [{{"number": 7, "title": "{s}"}}]}}
        \\  ]
        \\}}
    , .{oversized[0..]});
    defer std.testing.allocator.free(json);

    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try std.testing.expectError(error.ValueTooLong, render(std.testing.allocator, &out.writer, json, true));
    try std.testing.expectEqual(@as(usize, 0), out.writer.buffered().len);
}

fn expectContains(haystack: []const u8, needle: []const u8) !void {
    try std.testing.expect(std.mem.indexOf(u8, haystack, needle) != null);
}
