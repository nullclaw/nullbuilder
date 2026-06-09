const std = @import("std");

const JsonValue = std.json.Value;
const JsonObject = std.json.ObjectMap;

const green = "\x1b[32m";
const yellow = "\x1b[33m";
const red = "\x1b[31m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

pub fn main(init: std.process.Init.Minimal) !void {
    var debug_allocator: std.heap.DebugAllocator(.{}) = .init;
    defer std.debug.assert(debug_allocator.deinit() == .ok);
    const gpa = debug_allocator.allocator();

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var environ_map = try init.environ.createMap(gpa);
    defer environ_map.deinit();

    var threaded: std.Io.Threaded = .init(gpa, .{
        .argv0 = .init(init.args),
        .environ = init.environ,
    });
    defer threaded.deinit();
    const io = threaded.io();

    var stdout_buffer: [8192]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(io, &stdout_buffer);
    defer stdout_writer.interface.flush() catch {};
    const out = &stdout_writer.interface;

    const args = try init.args.toSlice(arena);
    const cli_path = environ_map.get("NULLBUILDER_NODE_CLI") orelse "./bin/nullbuilder.js";
    const no_color = environ_map.get("NO_COLOR") != null;

    if (args.len > 1 and (std.mem.eql(u8, args[1], "--help") or std.mem.eql(u8, args[1], "help"))) {
        try printHelp(out);
        return;
    }

    if (args.len > 1 and (std.mem.eql(u8, args[1], "build-pr") or std.mem.eql(u8, args[1], "release-tag"))) {
        try forwardTagCommand(gpa, arena, io, out, cli_path, args[1..]);
        return;
    }

    try renderDashboard(gpa, arena, io, out, cli_path, no_color);
}

fn printHelp(out: *std.Io.Writer) !void {
    try out.writeAll(
        \\nullbuilder-tui
        \\
        \\Usage:
        \\  zig build tui
        \\  zig build tui -- build-pr <repo> --pr <number> [--tag build-pr-*] [--confirm]
        \\  zig build tui -- release-tag <repo> --tag vX.Y.Z [--ref branch-or-sha] [--confirm]
        \\
        \\Environment:
        \\  NULLBUILDER_NODE_CLI  Path to bin/nullbuilder.js. Defaults to ./bin/nullbuilder.js
        \\  NULLBUILDER_GITHUB_TOKEN
        \\                       Token used by the underlying nullbuilder CLI
        \\
    );
}

fn renderDashboard(
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    io: std.Io,
    out: *std.Io.Writer,
    cli_path: []const u8,
    no_color: bool,
) !void {
    const result = try runCli(gpa, io, &.{ "node", cli_path, "repos", "--json" });
    defer {
        gpa.free(result.stdout);
        gpa.free(result.stderr);
    }
    try ensureDashboardSuccess(out, result);

    var parsed = try std.json.parseFromSlice(JsonValue, arena, result.stdout, .{});
    defer parsed.deinit();

    const root = switch (parsed.value) {
        .object => |object| object,
        else => return error.InvalidDashboardJson,
    };
    const items_value = root.get("items") orelse return error.InvalidDashboardJson;
    const items = switch (items_value) {
        .array => |array| array.items,
        else => return error.InvalidDashboardJson,
    };

    var totals = Totals{};
    for (items) |item| {
        if (item != .object) continue;
        const repo = item.object;
        totals.repositories += 1;
        totals.issues += intField(repo, "openIssues");
        totals.pull_requests += intField(repo, "openPulls");
        totals.stars += intField(repo, "stars");
        if (repoHasFailure(repo)) totals.failing += 1;
    }

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
        const slug = stringField(repo, "slug", "unknown");
        const status = stringField(repo, "status", "ok");
        const latest = objectField(repo, "latestRuns");
        const ci = if (std.mem.eql(u8, status, "error")) "error" else if (latest) |latest_runs| runLabel(latest_runs, "ci") else "n/a";
        const nightly = if (std.mem.eql(u8, status, "error")) "error" else if (latest) |latest_runs| runLabel(latest_runs, "nightly") else "n/a";
        const release = if (std.mem.eql(u8, status, "error")) "error" else if (latest) |latest_runs| runLabel(latest_runs, "release") else "n/a";

        try out.print("{s:<28} {d:>6} {d:>6} ", .{
            short(slug, 28),
            intField(repo, "openIssues"),
            intField(repo, "openPulls"),
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

    if (root.get("errors")) |errors_value| {
        if (errors_value == .array and errors_value.array.items.len > 0) {
            try out.writeAll("\nLoad errors\n");
            try out.writeAll("-----------\n");
            for (errors_value.array.items) |error_item| {
                if (error_item != .object) continue;
                const load_error = error_item.object;
                try out.print("  {s:<28} {s}\n", .{
                    short(stringField(load_error, "repo", ""), 28),
                    short(stringField(load_error, "error", ""), 90),
                });
            }
        }
    }
}

fn forwardTagCommand(
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    io: std.Io,
    out: *std.Io.Writer,
    cli_path: []const u8,
    args: []const []const u8,
) !void {
    var argv = std.array_list.Managed([]const u8).init(arena);
    try argv.append("node");
    try argv.append(cli_path);
    for (args) |arg| {
        try argv.append(arg);
    }

    const result = try runCli(gpa, io, argv.items);
    defer {
        gpa.free(result.stdout);
        gpa.free(result.stderr);
    }
    try ensureSuccess(out, result);
    if (result.stdout.len > 0) try out.writeAll(result.stdout);
    if (result.stderr.len > 0) try out.writeAll(result.stderr);
}

fn runCli(gpa: std.mem.Allocator, io: std.Io, argv: []const []const u8) !std.process.RunResult {
    return std.process.run(gpa, io, .{
        .argv = argv,
        .stdout_limit = std.Io.Limit.limited(16 * 1024 * 1024),
        .stderr_limit = std.Io.Limit.limited(4 * 1024 * 1024),
    });
}

fn ensureSuccess(out: *std.Io.Writer, result: std.process.RunResult) !void {
    switch (result.term) {
        .exited => |code| {
            if (code == 0) return;
            if (result.stderr.len > 0) try out.writeAll(result.stderr);
            if (result.stdout.len > 0) try out.writeAll(result.stdout);
            std.process.exit(code);
        },
        else => {
            if (result.stderr.len > 0) try out.writeAll(result.stderr);
            return error.ChildProcessFailed;
        },
    }
}

fn ensureDashboardSuccess(out: *std.Io.Writer, result: std.process.RunResult) !void {
    switch (result.term) {
        .exited => |code| {
            if (code == 0 or code == 2) return;
            if (result.stderr.len > 0) try out.writeAll(result.stderr);
            if (result.stdout.len > 0) try out.writeAll(result.stdout);
            std.process.exit(code);
        },
        else => {
            if (result.stderr.len > 0) try out.writeAll(result.stderr);
            return error.ChildProcessFailed;
        },
    }
}

fn printWorkItems(out: *std.Io.Writer, repos: []const JsonValue, field_name: []const u8, label: []const u8) !void {
    var printed: usize = 0;

    for (repos) |item| {
        if (printed >= 8) break;
        if (item != .object) continue;
        const repo = item.object;
        const list_value = repo.get(field_name) orelse continue;
        if (list_value != .array) continue;

        for (list_value.array.items) |work_item| {
            if (printed >= 8) break;
            if (work_item != .object) continue;
            const work = work_item.object;
            try out.print("  {s:<28} #{d:<5} {s}\n", .{
                short(stringField(work, "repo", ""), 28),
                intField(work, "number"),
                short(stringField(work, "title", ""), 74),
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
    try out.print("{s:<12}", .{short(status, width)});
    try out.writeAll(color(no_color, reset));
}

fn repoHasFailure(repo: JsonObject) bool {
    const latest = objectField(repo, "latestRuns") orelse return false;
    return isFailedRun(latest, "ci") or isFailedRun(latest, "nightly") or isFailedRun(latest, "release");
}

fn isFailedRun(latest: JsonObject, field_name: []const u8) bool {
    const run = objectField(latest, field_name) orelse return false;
    const status = stringField(run, "status", "");
    if (!std.mem.eql(u8, status, "completed")) return false;
    return !std.mem.eql(u8, stringField(run, "conclusion", ""), "success");
}

fn runLabel(latest: JsonObject, field_name: []const u8) []const u8 {
    const run = objectField(latest, field_name) orelse return "n/a";
    const status = stringField(run, "status", "");
    if (!std.mem.eql(u8, status, "completed")) return status;
    return stringField(run, "conclusion", "completed");
}

fn objectField(object: JsonObject, field_name: []const u8) ?JsonObject {
    const value = object.get(field_name) orelse return null;
    return switch (value) {
        .object => |child| child,
        else => null,
    };
}

fn stringField(object: JsonObject, field_name: []const u8, fallback: []const u8) []const u8 {
    const value = object.get(field_name) orelse return fallback;
    return switch (value) {
        .string => |string| string,
        .null => fallback,
        else => fallback,
    };
}

fn intField(object: JsonObject, field_name: []const u8) u64 {
    const value = object.get(field_name) orelse return 0;
    return switch (value) {
        .integer => |integer| if (integer > 0) @intCast(integer) else 0,
        .float => |float| if (float > 0) @intFromFloat(float) else 0,
        .null => 0,
        else => 0,
    };
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

fn short(value: []const u8, max_len: usize) []const u8 {
    if (value.len <= max_len) return value;
    return value[0..max_len];
}

const Totals = struct {
    repositories: u64 = 0,
    issues: u64 = 0,
    pull_requests: u64 = 0,
    stars: u64 = 0,
    failing: u64 = 0,
};
