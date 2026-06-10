const std = @import("std");

const action_args = @import("action_args");
const action_paths = @import("action_paths");
const action_values = @import("action_values");

const MAX_RUNS_JSON_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_VALUE_BYTES = 4096;
const MAX_WORKFLOW_RUNS_TO_SCAN = 100;

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

const DecideValidationError = error{
    InvalidRunsJsonPath,
    InvalidCurrentRunId,
    InvalidHeadSha,
};

fn isNightlyEvent(event: []const u8) bool {
    for (NIGHTLY_EVENTS) |candidate| {
        if (std.mem.eql(u8, event, candidate)) return true;
    }
    return false;
}

fn validateDecideOptions(options: DecideOptions) DecideValidationError!void {
    if (!action_paths.isSafeRelativePath(options.runs_json_path)) return error.InvalidRunsJsonPath;
    if (!action_values.isDecimalId(options.current_run_id)) return error.InvalidCurrentRunId;
    if (!action_values.isFullHexSha(options.head_sha)) return error.InvalidHeadSha;
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

    for (boundedWorkflowRuns(runs)) |run| {
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

fn boundedWorkflowRuns(runs: []const Run) []const Run {
    return runs[0..@min(runs.len, MAX_WORKFLOW_RUNS_TO_SCAN)];
}

fn validateActionOutputValue(value: []const u8) error{InvalidActionOutput}!void {
    if (!action_values.isSafeActionOutputValue(value, MAX_OUTPUT_VALUE_BYTES)) {
        return error.InvalidActionOutput;
    }
}

fn validateActionOutputUrl(value: []const u8) error{InvalidActionOutput}!void {
    if (!action_values.isHttpUrl(value, MAX_OUTPUT_VALUE_BYTES)) {
        return error.InvalidActionOutput;
    }
}

fn writeOutputLine(out: *std.Io.Writer, key: []const u8, value: []const u8) !void {
    try out.print("{s}={s}\n", .{ key, value });
}

fn writeDecision(out: *std.Io.Writer, decision: Decision) !void {
    const should_build = if (decision.should_build) "true" else "false";
    try validateActionOutputValue(should_build);
    try validateActionOutputValue(decision.reason);
    if (decision.matched_run_url.len > 0) {
        try validateActionOutputUrl(decision.matched_run_url);
    }

    try writeOutputLine(out, "should_build", should_build);
    try writeOutputLine(out, "reason", decision.reason);
    if (decision.matched_run_id) |id| try out.print("matched_run_id={d}\n", .{id});
    if (decision.matched_run_url.len > 0) try writeOutputLine(out, "matched_run_url", decision.matched_run_url);
}

fn printDecision(io: std.Io, decision: Decision) !void {
    var out_buf: [1024]u8 = undefined;
    var out = std.Io.File.stdout().writer(io, &out_buf);
    const w = &out.interface;
    try writeDecision(w, decision);
    try w.flush();
}

fn printUsage(io: std.Io) !u8 {
    var err_buf: [2048]u8 = undefined;
    var err = std.Io.File.stderr().writer(io, &err_buf);
    try err.interface.writeAll(
        \\usage:
        \\  zig run nightly_decide.zig -- --runs-json FILE --current-run-id ID --head-sha FULL_SHA --workflow-name NAME [--force]
        \\
    );
    try err.interface.flush();
    return 2;
}

fn parseArgs(iterator: *std.process.Args.Iterator, allocator: std.mem.Allocator) !DecideOptions {
    var runs_json_path: ?[]const u8 = null;
    var current_run_id: ?[]const u8 = null;
    var head_sha: ?[]const u8 = null;
    var workflow_name: ?[]const u8 = null;
    var force = false;

    while (iterator.next()) |arg| {
        if (std.mem.eql(u8, arg, "--runs-json")) {
            runs_json_path = try action_args.takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--current-run-id")) {
            current_run_id = try action_args.takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--head-sha")) {
            head_sha = try action_args.takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--workflow-name")) {
            workflow_name = try action_args.takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--force")) {
            force = true;
        } else {
            return action_args.unexpectedOption(arg);
        }
    }

    return .{
        .runs_json_path = try action_args.required(runs_json_path, "--runs-json"),
        .current_run_id = try action_args.required(current_run_id, "--current-run-id"),
        .head_sha = try action_args.required(head_sha, "--head-sha"),
        .workflow_name = workflow_name orelse "",
        .force = force,
    };
}

fn runDecide(io: std.Io, allocator: std.mem.Allocator, options: DecideOptions) !void {
    validateDecideOptions(options) catch |err| switch (err) {
        error.InvalidRunsJsonPath => {
            action_args.printDiagnostic("invalid runs json path: {s}\n", options.runs_json_path);
            return error.InvalidArguments;
        },
        error.InvalidCurrentRunId => {
            action_args.printDiagnostic("invalid current run id: {s}\n", options.current_run_id);
            return error.InvalidArguments;
        },
        error.InvalidHeadSha => {
            action_args.printDiagnostic("invalid head sha: {s}\n", options.head_sha);
            return error.InvalidArguments;
        },
    };

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
    const options = parseArgs(&iterator, allocator) catch |err| switch (err) {
        error.InvalidArguments => return try printUsage(init.io),
        else => return err,
    };
    runDecide(init.io, allocator, options) catch |err| {
        if (action_args.invalidArgumentExitCode(err)) |exit_code| return exit_code;
        return err;
    };
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

test "nightly decide scans only bounded workflow history" {
    var runs = [_]Run{.{
        .id = 1,
        .name = "Nightly",
        .event = "schedule",
        .head_sha = "other",
        .conclusion = "failure",
    }} ** (MAX_WORKFLOW_RUNS_TO_SCAN + 1);

    runs[MAX_WORKFLOW_RUNS_TO_SCAN] = .{
        .id = 200,
        .name = "Nightly",
        .event = "schedule",
        .head_sha = "0123456789abcdef",
        .conclusion = "success",
    };

    var decision = decideShouldBuild(&runs, "999", "0123456789abcdef", "Nightly", false);
    try std.testing.expect(decision.should_build);
    try std.testing.expectEqualStrings("new-sha", decision.reason);

    runs[MAX_WORKFLOW_RUNS_TO_SCAN - 1] = .{
        .id = 199,
        .name = "Nightly",
        .event = "schedule",
        .head_sha = "0123456789abcdef",
        .conclusion = "success",
    };

    decision = decideShouldBuild(&runs, "999", "0123456789abcdef", "Nightly", false);
    try std.testing.expect(!decision.should_build);
    try std.testing.expectEqual(@as(?u64, 199), decision.matched_run_id);
}

test "nightly decision output formats GitHub output lines" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try writeDecision(&out.writer, .{
        .should_build = false,
        .reason = "successful-nightly-exists",
        .matched_run_id = 9,
        .matched_run_url = "https://example.com/run/9",
    });

    try std.testing.expectEqualStrings(
        \\should_build=false
        \\reason=successful-nightly-exists
        \\matched_run_id=9
        \\matched_run_url=https://example.com/run/9
        \\
    , out.writer.buffered());
}

test "nightly decision output rejects multiline values before writing" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const decision = Decision{
        .should_build = false,
        .reason = "successful-nightly-exists",
        .matched_run_id = 9,
        .matched_run_url = "https://example.com/run/9\nshould_build=true",
    };

    try std.testing.expectError(error.InvalidActionOutput, writeDecision(&out.writer, decision));
    try std.testing.expectEqualStrings("", out.writer.buffered());
}

test "nightly decision output rejects non-url matched run URLs" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const decision = Decision{
        .should_build = false,
        .reason = "successful-nightly-exists",
        .matched_run_id = 9,
        .matched_run_url = "not-a-url",
    };

    try std.testing.expectError(error.InvalidActionOutput, writeDecision(&out.writer, decision));
    try std.testing.expectEqualStrings("", out.writer.buffered());
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

test "nightly validates action options before reading runs json" {
    const valid_options = DecideOptions{
        .runs_json_path = "previous-nightly-runs.json",
        .current_run_id = "10",
        .head_sha = "0123456789abcdef0123456789abcdef01234567",
        .workflow_name = "Nightly",
        .force = false,
    };

    try validateDecideOptions(valid_options);

    var unsafe_path_options = valid_options;
    unsafe_path_options.runs_json_path = "../previous-nightly-runs.json";
    try std.testing.expectError(error.InvalidRunsJsonPath, validateDecideOptions(unsafe_path_options));

    var unsafe_run_options = valid_options;
    unsafe_run_options.current_run_id = "not-a-number";
    try std.testing.expectError(error.InvalidCurrentRunId, validateDecideOptions(unsafe_run_options));

    var unsafe_sha_options = valid_options;
    unsafe_sha_options.head_sha = "not-a-sha";
    try std.testing.expectError(error.InvalidHeadSha, validateDecideOptions(unsafe_sha_options));
}
