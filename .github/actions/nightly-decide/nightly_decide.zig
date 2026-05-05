const std = @import("std");

const MAX_RUNS_JSON_BYTES = 2 * 1024 * 1024;

const NIGHTLY_EVENTS = [_][]const u8{ "schedule", "workflow_dispatch" };

const Run = struct {
    id: u64 = 0,
    name: []const u8 = "",
    event: []const u8 = "",
    head_sha: []const u8 = "",
    conclusion: ?[]const u8 = null,
    html_url: []const u8 = "",
};

const RunsPayload = struct {
    workflow_runs: []const Run = &.{},
};

const Decision = struct {
    should_build: bool,
    reason: []const u8,
    matched_run_id: ?u64 = null,
    matched_run_url: []const u8 = "",
};

const DecideOptions = struct {
    runs_json_path: []const u8,
    current_run_id: []const u8,
    head_sha: []const u8,
    workflow_name: []const u8,
    force: bool,
};

fn isNightlyEvent(event: []const u8) bool {
    for (NIGHTLY_EVENTS) |candidate| {
        if (std.mem.eql(u8, event, candidate)) return true;
    }
    return false;
}

fn parseRunsPayload(allocator: std.mem.Allocator, json_bytes: []const u8) !std.json.Parsed(RunsPayload) {
    return try std.json.parseFromSlice(RunsPayload, allocator, json_bytes, .{
        .ignore_unknown_fields = true,
    });
}

fn decideShouldBuild(
    runs: []const Run,
    current_run_id: []const u8,
    head_sha: []const u8,
    workflow_name: []const u8,
    force: bool,
) Decision {
    if (force) return .{ .should_build = true, .reason = "forced" };

    const current_id = std.fmt.parseUnsigned(u64, current_run_id, 10) catch null;

    for (runs) |run| {
        if (current_id) |id| {
            if (run.id == id) continue;
        }
        if (workflow_name.len > 0 and !std.mem.eql(u8, run.name, workflow_name)) continue;
        if (!isNightlyEvent(run.event)) continue;
        if (!std.mem.eql(u8, run.head_sha, head_sha)) continue;
        if (run.conclusion == null or !std.mem.eql(u8, run.conclusion.?, "success")) continue;
        return .{
            .should_build = false,
            .reason = "successful-nightly-exists",
            .matched_run_id = run.id,
            .matched_run_url = run.html_url,
        };
    }

    return .{ .should_build = true, .reason = "new-sha" };
}

fn printDecision(io: std.Io, decision: Decision) !void {
    var out_buf: [1024]u8 = undefined;
    var out = std.Io.File.stdout().writer(io, &out_buf);
    const w = &out.interface;
    try w.print("should_build={s}\n", .{if (decision.should_build) "true" else "false"});
    try w.print("reason={s}\n", .{decision.reason});
    if (decision.matched_run_id) |id| try w.print("matched_run_id={d}\n", .{id});
    if (decision.matched_run_url.len > 0) try w.print("matched_run_url={s}\n", .{decision.matched_run_url});
    try w.flush();
}

fn printUsage(io: std.Io) !u8 {
    var err_buf: [2048]u8 = undefined;
    var err = std.Io.File.stderr().writer(io, &err_buf);
    try err.interface.writeAll(
        \\usage:
        \\  zig run nightly_decide.zig -- --runs-json FILE --current-run-id ID --head-sha SHA --workflow-name NAME [--force]
        \\
    );
    try err.interface.flush();
    return 2;
}

fn takeValue(
    iterator: *std.process.Args.Iterator,
    allocator: std.mem.Allocator,
    flag: []const u8,
) ![]const u8 {
    const value = iterator.next() orelse {
        std.debug.print("missing value for {s}\n", .{flag});
        return error.InvalidArguments;
    };
    return try allocator.dupe(u8, value);
}

fn parseArgs(iterator: *std.process.Args.Iterator, allocator: std.mem.Allocator) !DecideOptions {
    var runs_json_path: ?[]const u8 = null;
    var current_run_id: ?[]const u8 = null;
    var head_sha: ?[]const u8 = null;
    var workflow_name: ?[]const u8 = null;
    var force = false;

    while (iterator.next()) |arg| {
        if (std.mem.eql(u8, arg, "--runs-json")) {
            runs_json_path = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--current-run-id")) {
            current_run_id = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--head-sha")) {
            head_sha = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--workflow-name")) {
            workflow_name = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--force")) {
            force = true;
        } else {
            std.debug.print("unknown option: {s}\n", .{arg});
            return error.InvalidArguments;
        }
    }

    return .{
        .runs_json_path = runs_json_path orelse return error.InvalidArguments,
        .current_run_id = current_run_id orelse return error.InvalidArguments,
        .head_sha = head_sha orelse return error.InvalidArguments,
        .workflow_name = workflow_name orelse "",
        .force = force,
    };
}

fn runDecide(io: std.Io, allocator: std.mem.Allocator, options: DecideOptions) !void {
    const json_bytes = try std.Io.Dir.cwd().readFileAlloc(
        io,
        options.runs_json_path,
        allocator,
        .limited(MAX_RUNS_JSON_BYTES),
    );
    defer allocator.free(json_bytes);

    var parsed = try parseRunsPayload(allocator, json_bytes);
    defer parsed.deinit();

    const decision = decideShouldBuild(
        parsed.value.workflow_runs,
        options.current_run_id,
        options.head_sha,
        options.workflow_name,
        options.force,
    );
    try printDecision(io, decision);
}

pub fn main(init: std.process.Init) !u8 {
    const allocator = init.arena.allocator();
    var iterator = try std.process.Args.Iterator.initAllocator(init.minimal.args, init.gpa);
    defer iterator.deinit();

    _ = iterator.next();
    const options = parseArgs(&iterator, allocator) catch return try printUsage(init.io);
    try runDecide(init.io, allocator, options);
    return 0;
}

test "nightly decide builds when history is empty" {
    const decision = decideShouldBuild(&.{}, "10", "0123456789abcdef", "Nightly", false);
    try std.testing.expect(decision.should_build);
    try std.testing.expectEqualStrings("new-sha", decision.reason);
}

test "nightly decide skips successful previous nightly for same sha and workflow" {
    // Regression: scheduled nightly builds should not rebuild unchanged main commits.
    const decision = decideShouldBuild(&.{.{
        .id = 9,
        .name = "Nightly",
        .event = "schedule",
        .head_sha = "0123456789abcdef",
        .conclusion = "success",
        .html_url = "https://example.com/run/9",
    }}, "10", "0123456789abcdef", "Nightly", false);

    try std.testing.expect(!decision.should_build);
    try std.testing.expectEqualStrings("successful-nightly-exists", decision.reason);
    try std.testing.expectEqual(@as(?u64, 9), decision.matched_run_id);
    try std.testing.expectEqualStrings("https://example.com/run/9", decision.matched_run_url);
}

test "nightly decide ignores other workflows current run failed runs and non nightly events" {
    const runs = [_]Run{
        .{
            .id = 10,
            .name = "Nightly",
            .event = "schedule",
            .head_sha = "0123456789abcdef",
            .conclusion = "success",
        },
        .{
            .id = 8,
            .name = "Nightly",
            .event = "schedule",
            .head_sha = "0123456789abcdef",
            .conclusion = "failure",
        },
        .{
            .id = 7,
            .name = "CI",
            .event = "schedule",
            .head_sha = "0123456789abcdef",
            .conclusion = "success",
        },
        .{
            .id = 6,
            .name = "Nightly",
            .event = "push",
            .head_sha = "0123456789abcdef",
            .conclusion = "success",
        },
    };

    const decision = decideShouldBuild(&runs, "10", "0123456789abcdef", "Nightly", false);
    try std.testing.expect(decision.should_build);
    try std.testing.expectEqualStrings("new-sha", decision.reason);
}

test "nightly decide force overrides existing success" {
    const decision = decideShouldBuild(&.{.{
        .id = 9,
        .name = "Nightly",
        .event = "workflow_dispatch",
        .head_sha = "0123456789abcdef",
        .conclusion = "success",
    }}, "10", "0123456789abcdef", "Nightly", true);

    try std.testing.expect(decision.should_build);
    try std.testing.expectEqualStrings("forced", decision.reason);
}

test "nightly parses workflow run API payload with unknown fields" {
    const json =
        \\{"total_count":1,"workflow_runs":[{"id":42,"name":"Nightly","event":"schedule","head_sha":"abc","conclusion":"success","html_url":"https://example.com/run/42","extra":true}]}
    ;
    var parsed = try parseRunsPayload(std.testing.allocator, json);
    defer parsed.deinit();

    const decision = decideShouldBuild(parsed.value.workflow_runs, "43", "abc", "Nightly", false);
    try std.testing.expect(!decision.should_build);
    try std.testing.expectEqual(@as(?u64, 42), decision.matched_run_id);
}
