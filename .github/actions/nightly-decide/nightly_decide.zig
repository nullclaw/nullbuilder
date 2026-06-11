const std = @import("std");

const action_args = @import("action_args");
const action_json = @import("action_json");
const action_paths = @import("action_paths");
const action_values = @import("action_values");

const JsonValue = action_json.JsonValue;
const JsonObject = action_json.JsonObject;

const MAX_RUNS_JSON_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_VALUE_BYTES = 4096;
const MAX_RUNS_JSON_VALUE_BYTES = MAX_OUTPUT_VALUE_BYTES;
const MAX_WORKFLOW_NAME_BYTES = 256;
const MAX_WORKFLOW_RUNS_TO_SCAN = 100;
const MAX_RUN_EVENT_BYTES = 64;
const MAX_RUN_CONCLUSION_BYTES = 64;
const MAX_RUN_HEAD_SHA_BYTES = 40;

const NIGHTLY_EVENTS = [_][]const u8{ "schedule", "workflow_dispatch" };
const TEST_HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const TEST_OTHER_HEAD_SHA = "89abcdef0123456789abcdef0123456789abcdef";

const Run = struct {
    id: u64 = 0,
    name: []const u8 = "",
    event: []const u8 = "",
    head_sha: []const u8 = "",
    conclusion: ?[]const u8 = null,
    html_url: []const u8 = "",
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
    InvalidWorkflowName,
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
    if (options.workflow_name.len > 0 and !action_values.isSafeActionOutputValue(options.workflow_name, MAX_WORKFLOW_NAME_BYTES)) {
        return error.InvalidWorkflowName;
    }
}

fn parseRunsPayload(allocator: std.mem.Allocator, json_bytes: []const u8) !std.json.Parsed(JsonValue) {
    return action_json.parseBoundedValue(allocator, json_bytes, .{
        .max_bytes = MAX_RUNS_JSON_BYTES,
        .max_value_bytes = MAX_RUNS_JSON_VALUE_BYTES,
    }) catch |err| switch (err) {
        error.JsonTooLarge => error.RunsJsonTooLarge,
        else => err,
    };
}

fn readRunsJsonBytes(
    io: std.Io,
    dir: std.Io.Dir,
    allocator: std.mem.Allocator,
    path: []const u8,
) ![]u8 {
    if (!action_paths.isSafeRelativePath(path)) return error.InvalidRunsJsonPath;

    const stat = try dir.statFile(io, path, .{});
    if (stat.kind != .file) return error.RunsJsonNotFile;
    if (stat.size > MAX_RUNS_JSON_BYTES) return error.RunsJsonTooLarge;

    return dir.readFileAlloc(
        io,
        path,
        allocator,
        .limited(MAX_RUNS_JSON_BYTES + 1),
    ) catch |err| switch (err) {
        error.StreamTooLong => error.RunsJsonTooLarge,
        else => err,
    };
}

fn decideShouldBuild(
    runs: []const Run,
    current_run_id: []const u8,
    head_sha: []const u8,
    workflow_name: []const u8,
    force: bool,
) Decision {
    if (force) return forcedDecision();

    const current_id = parseCurrentRunId(current_run_id);

    for (boundedWorkflowRuns(runs)) |run| {
        if (matchingSuccessfulRun(run, current_id, head_sha, workflow_name)) {
            return skipDecision(run);
        }
    }

    return .{ .should_build = true, .reason = "new-sha" };
}

fn decideShouldBuildFromPayload(
    payload: JsonValue,
    current_run_id: []const u8,
    head_sha: []const u8,
    workflow_name: []const u8,
    force: bool,
) Decision {
    if (force) return forcedDecision();

    const current_id = parseCurrentRunId(current_run_id);

    for (workflowRunValues(payload)) |value| {
        const run = runFromValue(value) orelse continue;
        if (matchingSuccessfulRun(run, current_id, head_sha, workflow_name)) {
            return skipDecision(run);
        }
    }

    return .{ .should_build = true, .reason = "new-sha" };
}

fn forcedDecision() Decision {
    return .{ .should_build = true, .reason = "forced" };
}

fn parseCurrentRunId(current_run_id: []const u8) ?u64 {
    return action_values.parseDecimalId(current_run_id);
}

fn matchingSuccessfulRun(run: Run, current_id: ?u64, head_sha: []const u8, workflow_name: []const u8) bool {
    if (run.id == 0) return false;
    if (current_id) |id| {
        if (run.id == id) return false;
    }
    if (workflow_name.len > 0 and !std.mem.eql(u8, run.name, workflow_name)) return false;
    if (!isNightlyEvent(run.event)) return false;
    if (!action_values.isFullHexSha(run.head_sha)) return false;
    if (!std.mem.eql(u8, run.head_sha, head_sha)) return false;
    const conclusion = run.conclusion orelse return false;
    if (!std.mem.eql(u8, conclusion, "success")) return false;
    return true;
}

fn skipDecision(run: Run) Decision {
    return .{
        .should_build = false,
        .reason = "successful-nightly-exists",
        .matched_run_id = run.id,
        .matched_run_url = safeMatchedRunUrl(run.html_url),
    };
}

fn safeMatchedRunUrl(value: []const u8) []const u8 {
    return if (action_values.isGitHubDotComActionsRunUrl(value, MAX_OUTPUT_VALUE_BYTES)) value else "";
}

fn boundedWorkflowRuns(runs: []const Run) []const Run {
    return runs[0..@min(runs.len, MAX_WORKFLOW_RUNS_TO_SCAN)];
}

fn workflowRunValues(payload: JsonValue) []const JsonValue {
    const root = action_json.objectValue(payload) orelse return action_json.emptyValues();
    return action_json.boundedArrayField(root, "workflow_runs", MAX_WORKFLOW_RUNS_TO_SCAN) orelse action_json.emptyValues();
}

fn runFromValue(value: JsonValue) ?Run {
    const object = action_json.objectValue(value) orelse return null;
    return runFromObject(object);
}

fn runFromObject(object: JsonObject) Run {
    return .{
        .id = action_json.safePositiveIntegerField(object, "id"),
        .name = action_json.safeTextField(object, "name", "", MAX_WORKFLOW_NAME_BYTES),
        .event = action_json.safeTextField(object, "event", "", MAX_RUN_EVENT_BYTES),
        .head_sha = safeHeadShaField(object),
        .conclusion = action_json.optionalSafeTextField(object, "conclusion", MAX_RUN_CONCLUSION_BYTES),
        .html_url = action_json.safeTextField(object, "html_url", "", MAX_OUTPUT_VALUE_BYTES),
    };
}

fn safeHeadShaField(object: JsonObject) []const u8 {
    const value = action_json.safeTextField(object, "head_sha", "", MAX_RUN_HEAD_SHA_BYTES);
    return if (action_values.isFullHexSha(value)) value else "";
}

fn validateActionOutputValue(value: []const u8) error{InvalidActionOutput}!void {
    if (!action_values.isSafeActionOutputValue(value, MAX_OUTPUT_VALUE_BYTES)) {
        return error.InvalidActionOutput;
    }
}

fn validateActionOutputUrl(value: []const u8) error{InvalidActionOutput}!void {
    if (!action_values.isGitHubDotComActionsRunUrl(value, MAX_OUTPUT_VALUE_BYTES)) {
        return error.InvalidActionOutput;
    }
}

fn validateActionOutputRunId(value: u64) error{InvalidActionOutput}!void {
    if (value == 0) return error.InvalidActionOutput;
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
    if (decision.matched_run_id) |id| {
        try validateActionOutputRunId(id);
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
    var option_count: usize = 0;

    while (try action_args.nextOption(iterator, &option_count)) |arg| {
        if (std.mem.eql(u8, arg, "--runs-json")) {
            try action_args.takeValueOnce(iterator, allocator, &runs_json_path, arg);
        } else if (std.mem.eql(u8, arg, "--current-run-id")) {
            try action_args.takeValueOnce(iterator, allocator, &current_run_id, arg);
        } else if (std.mem.eql(u8, arg, "--head-sha")) {
            try action_args.takeValueOnce(iterator, allocator, &head_sha, arg);
        } else if (std.mem.eql(u8, arg, "--workflow-name")) {
            try action_args.takeValueOnce(iterator, allocator, &workflow_name, arg);
        } else if (std.mem.eql(u8, arg, "--force")) {
            try action_args.setFlagOnce(&force, arg);
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
        error.InvalidWorkflowName => {
            action_args.printDiagnostic("invalid workflow name: {s}\n", options.workflow_name);
            return error.InvalidArguments;
        },
    };

    const decision = try decideFromValidatedOptions(io, allocator, options);
    try printDecision(io, decision);
}

fn decideFromValidatedOptions(io: std.Io, allocator: std.mem.Allocator, options: DecideOptions) !Decision {
    if (options.force) return forcedDecision();

    const json_bytes = try readRunsJsonBytes(io, std.Io.Dir.cwd(), allocator, options.runs_json_path);
    defer allocator.free(json_bytes);

    var parsed = try parseRunsPayload(allocator, json_bytes);
    defer parsed.deinit();

    const decision = decideShouldBuildFromPayload(
        parsed.value,
        options.current_run_id,
        options.head_sha,
        options.workflow_name,
        false,
    );
    return decision;
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
    const decision = decideShouldBuild(&.{}, "10", TEST_HEAD_SHA, "Nightly", false);
    try std.testing.expect(decision.should_build);
    try std.testing.expectEqualStrings("new-sha", decision.reason);
}

test "nightly decide skips successful previous nightly for same sha and workflow" {
    // Regression: scheduled nightly builds should not rebuild unchanged main commits.
    const decision = decideShouldBuild(&.{.{
        .id = 9,
        .name = "Nightly",
        .event = "schedule",
        .head_sha = TEST_HEAD_SHA,
        .conclusion = "success",
        .html_url = "https://github.com/nullclaw/nullbuilder/actions/runs/9",
    }}, "10", TEST_HEAD_SHA, "Nightly", false);

    try std.testing.expect(!decision.should_build);
    try std.testing.expectEqualStrings("successful-nightly-exists", decision.reason);
    try std.testing.expectEqual(@as(?u64, 9), decision.matched_run_id);
    try std.testing.expectEqualStrings("https://github.com/nullclaw/nullbuilder/actions/runs/9", decision.matched_run_url);
}

test "nightly decide ignores other workflows current run failed runs and non nightly events" {
    const runs = [_]Run{
        .{
            .id = 10,
            .name = "Nightly",
            .event = "schedule",
            .head_sha = TEST_HEAD_SHA,
            .conclusion = "success",
        },
        .{
            .id = 8,
            .name = "Nightly",
            .event = "schedule",
            .head_sha = TEST_HEAD_SHA,
            .conclusion = "failure",
        },
        .{
            .id = 7,
            .name = "CI",
            .event = "schedule",
            .head_sha = TEST_HEAD_SHA,
            .conclusion = "success",
        },
        .{
            .id = 6,
            .name = "Nightly",
            .event = "push",
            .head_sha = TEST_HEAD_SHA,
            .conclusion = "success",
        },
        .{
            .id = 5,
            .name = "Nightly",
            .event = "schedule",
            .head_sha = TEST_HEAD_SHA,
        },
    };

    const decision = decideShouldBuild(&runs, "10", TEST_HEAD_SHA, "Nightly", false);
    try std.testing.expect(decision.should_build);
    try std.testing.expectEqualStrings("new-sha", decision.reason);
}

test "nightly decide force overrides existing success" {
    const decision = decideShouldBuild(&.{.{
        .id = 9,
        .name = "Nightly",
        .event = "workflow_dispatch",
        .head_sha = TEST_HEAD_SHA,
        .conclusion = "success",
    }}, "10", TEST_HEAD_SHA, "Nightly", true);

    try std.testing.expect(decision.should_build);
    try std.testing.expectEqualStrings("forced", decision.reason);
}

test "nightly decide force skips workflow run file reads" {
    const decision = try decideFromValidatedOptions(undefined, std.testing.allocator, .{
        .runs_json_path = "missing-previous-nightly-runs.json",
        .current_run_id = "10",
        .head_sha = TEST_HEAD_SHA,
        .workflow_name = "Nightly",
        .force = true,
    });

    try std.testing.expect(decision.should_build);
    try std.testing.expectEqualStrings("forced", decision.reason);
    try std.testing.expectEqual(@as(?u64, null), decision.matched_run_id);
    try std.testing.expectEqualStrings("", decision.matched_run_url);
}

test "nightly decide scans only bounded workflow history" {
    var runs = [_]Run{.{
        .id = 1,
        .name = "Nightly",
        .event = "schedule",
        .head_sha = TEST_OTHER_HEAD_SHA,
        .conclusion = "failure",
    }} ** (MAX_WORKFLOW_RUNS_TO_SCAN + 1);

    runs[MAX_WORKFLOW_RUNS_TO_SCAN] = .{
        .id = 200,
        .name = "Nightly",
        .event = "schedule",
        .head_sha = TEST_HEAD_SHA,
        .conclusion = "success",
    };

    var decision = decideShouldBuild(&runs, "999", TEST_HEAD_SHA, "Nightly", false);
    try std.testing.expect(decision.should_build);
    try std.testing.expectEqualStrings("new-sha", decision.reason);

    runs[MAX_WORKFLOW_RUNS_TO_SCAN - 1] = .{
        .id = 199,
        .name = "Nightly",
        .event = "schedule",
        .head_sha = TEST_HEAD_SHA,
        .conclusion = "success",
    };

    decision = decideShouldBuild(&runs, "999", TEST_HEAD_SHA, "Nightly", false);
    try std.testing.expect(!decision.should_build);
    try std.testing.expectEqual(@as(?u64, 199), decision.matched_run_id);
}

test "nightly decide ignores matching API runs without a positive id" {
    const decision = decideShouldBuild(&.{.{
        .id = 0,
        .name = "Nightly",
        .event = "schedule",
        .head_sha = TEST_HEAD_SHA,
        .conclusion = "success",
        .html_url = "https://github.com/nullclaw/nullbuilder/actions/runs/0",
    }}, "10", TEST_HEAD_SHA, "Nightly", false);

    try std.testing.expect(decision.should_build);
    try std.testing.expectEqualStrings("new-sha", decision.reason);
    try std.testing.expectEqual(@as(?u64, null), decision.matched_run_id);
    try std.testing.expectEqualStrings("", decision.matched_run_url);
}

test "nightly matched run URLs are limited to GitHub Actions runs" {
    try std.testing.expectEqualStrings(
        "https://github.com/nullclaw/nullbuilder/actions/runs/44",
        safeMatchedRunUrl("https://github.com/nullclaw/nullbuilder/actions/runs/44"),
    );

    for ([_][]const u8{
        "https://example.com/run/44",
        "https://github.com/nullclaw/nullbuilder/actions/runs/44/extra",
        "https://github.com/nullclaw/nullbuilder/actions/runs/0",
        "https://github.com/nullclaw/nullbuilder/actions/jobs/44",
        "https://github.com/null_claw/nullbuilder/actions/runs/44",
        "https://github.com/nullclaw/nullbuilder/actions/runs/44?check_suite_focus=true",
        "https://github.com/nullclaw/nullbuilder/actions/runs/44#summary",
    }) |url| {
        try std.testing.expectEqualStrings("", safeMatchedRunUrl(url));
    }
}

test "nightly decision output formats GitHub output lines" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try writeDecision(&out.writer, .{
        .should_build = false,
        .reason = "successful-nightly-exists",
        .matched_run_id = 9,
        .matched_run_url = "https://github.com/nullclaw/nullbuilder/actions/runs/9",
    });

    try std.testing.expectEqualStrings(
        \\should_build=false
        \\reason=successful-nightly-exists
        \\matched_run_id=9
        \\matched_run_url=https://github.com/nullclaw/nullbuilder/actions/runs/9
        \\
    , out.writer.buffered());
}

test "nightly decision output omits absent optional fields" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try writeDecision(&out.writer, .{
        .should_build = true,
        .reason = "new-sha",
    });

    try std.testing.expectEqualStrings(
        \\should_build=true
        \\reason=new-sha
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
        .matched_run_url = "https://github.com/nullclaw/nullbuilder/actions/runs/9\nshould_build=true",
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

test "nightly decision output rejects non-GitHub matched run URLs" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const decision = Decision{
        .should_build = false,
        .reason = "successful-nightly-exists",
        .matched_run_id = 9,
        .matched_run_url = "https://example.com/run/9",
    };

    try std.testing.expectError(error.InvalidActionOutput, writeDecision(&out.writer, decision));
    try std.testing.expectEqualStrings("", out.writer.buffered());
}

test "nightly decision output rejects zero matched run ids" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const decision = Decision{
        .should_build = false,
        .reason = "successful-nightly-exists",
        .matched_run_id = 0,
    };

    try std.testing.expectError(error.InvalidActionOutput, writeDecision(&out.writer, decision));
    try std.testing.expectEqualStrings("", out.writer.buffered());
}

test "nightly rejects duplicate options" {
    const argv = [_][*:0]const u8{
        "nightly_decide",
        "--runs-json",
        "previous-nightly-runs.json",
        "--runs-json",
        "other-nightly-runs.json",
    };
    var iterator = std.process.Args.Iterator.init(.{ .vector = &argv });
    _ = iterator.next();

    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();

    try std.testing.expectError(error.InvalidArguments, parseArgs(&iterator, arena_state.allocator()));
}

test "nightly rejects duplicate force flag" {
    const argv = [_][*:0]const u8{
        "nightly_decide",
        "--force",
        "--force",
    };
    var iterator = std.process.Args.Iterator.init(.{ .vector = &argv });
    _ = iterator.next();

    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();

    try std.testing.expectError(error.InvalidArguments, parseArgs(&iterator, arena_state.allocator()));
}

test "nightly parses workflow run API payload with unknown fields" {
    const json =
        \\{"total_count":1,"workflow_runs":[{"id":42,"name":"Nightly","event":"schedule","head_sha":"0123456789abcdef0123456789abcdef01234567","conclusion":"success","html_url":"https://github.com/nullclaw/nullbuilder/actions/runs/42","extra":true}]}
    ;
    var parsed = try parseRunsPayload(std.testing.allocator, json);
    defer parsed.deinit();

    const decision = decideShouldBuildFromPayload(parsed.value, "43", TEST_HEAD_SHA, "Nightly", false);
    try std.testing.expect(!decision.should_build);
    try std.testing.expectEqual(@as(?u64, 42), decision.matched_run_id);
}

test "nightly skips malformed workflow run API entries" {
    const json =
        \\{
        \\  "workflow_runs": [
        \\    null,
        \\    "not-a-run",
        \\    {"id":"42","name":"Nightly","event":"schedule","head_sha":"0123456789abcdef0123456789abcdef01234567","conclusion":"success","html_url":"https://github.com/nullclaw/nullbuilder/actions/runs/42"},
        \\    {"id":43,"name":null,"event":"schedule","head_sha":"0123456789abcdef0123456789abcdef01234567","conclusion":"success","html_url":"https://github.com/nullclaw/nullbuilder/actions/runs/43"},
        \\    {"id":44,"name":"Nightly","event":"schedule","head_sha":"0123456789abcdef0123456789abcdef01234567","conclusion":"success","html_url":"https://github.com/nullclaw/nullbuilder/actions/runs/44"}
        \\  ]
        \\}
    ;
    var parsed = try parseRunsPayload(std.testing.allocator, json);
    defer parsed.deinit();

    const decision = decideShouldBuildFromPayload(parsed.value, "45", TEST_HEAD_SHA, "Nightly", false);
    try std.testing.expect(!decision.should_build);
    try std.testing.expectEqual(@as(?u64, 44), decision.matched_run_id);
    try std.testing.expectEqualStrings("https://github.com/nullclaw/nullbuilder/actions/runs/44", decision.matched_run_url);
}

test "nightly skips workflow runs with unsafe JSON integer ids" {
    const json =
        \\{
        \\  "workflow_runs": [
        \\    {"id":9007199254740992,"name":"Nightly","event":"schedule","head_sha":"0123456789abcdef0123456789abcdef01234567","conclusion":"success","html_url":"https://github.com/nullclaw/nullbuilder/actions/runs/unsafe"},
        \\    {"id":44,"name":"Nightly","event":"schedule","head_sha":"0123456789abcdef0123456789abcdef01234567","conclusion":"success","html_url":"https://github.com/nullclaw/nullbuilder/actions/runs/44"}
        \\  ]
        \\}
    ;
    var parsed = try parseRunsPayload(std.testing.allocator, json);
    defer parsed.deinit();

    const decision = decideShouldBuildFromPayload(parsed.value, "45", TEST_HEAD_SHA, "Nightly", false);
    try std.testing.expect(!decision.should_build);
    try std.testing.expectEqual(@as(?u64, 44), decision.matched_run_id);
    try std.testing.expectEqualStrings("https://github.com/nullclaw/nullbuilder/actions/runs/44", decision.matched_run_url);
}

test "nightly skips workflow runs with malformed head shas" {
    const json =
        \\{
        \\  "workflow_runs": [
        \\    {"id":42,"name":"Nightly","event":"schedule","head_sha":"not-a-full-sha","conclusion":"success","html_url":"https://github.com/nullclaw/nullbuilder/actions/runs/42"},
        \\    {"id":44,"name":"Nightly","event":"schedule","head_sha":"0123456789abcdef0123456789abcdef01234567","conclusion":"success","html_url":"https://github.com/nullclaw/nullbuilder/actions/runs/44"}
        \\  ]
        \\}
    ;
    var parsed = try parseRunsPayload(std.testing.allocator, json);
    defer parsed.deinit();

    const decision = decideShouldBuildFromPayload(parsed.value, "45", TEST_HEAD_SHA, "Nightly", false);
    try std.testing.expect(!decision.should_build);
    try std.testing.expectEqual(@as(?u64, 44), decision.matched_run_id);
    try std.testing.expectEqualStrings("https://github.com/nullclaw/nullbuilder/actions/runs/44", decision.matched_run_url);
}

test "nightly treats malformed workflow run collections as empty history" {
    for ([_][]const u8{
        "null",
        "{\"workflow_runs\":null}",
        "{\"workflow_runs\":{\"id\":42}}",
        "{\"workflow_runs\":\"not-an-array\"}",
    }) |json| {
        var parsed = try parseRunsPayload(std.testing.allocator, json);
        defer parsed.deinit();

        const decision = decideShouldBuildFromPayload(parsed.value, "43", TEST_HEAD_SHA, "Nightly", false);
        try std.testing.expect(decision.should_build);
        try std.testing.expectEqualStrings("new-sha", decision.reason);
        try std.testing.expectEqual(@as(?u64, null), decision.matched_run_id);
    }
}

test "nightly rejects oversized runs payloads at the parser boundary" {
    const json = try std.testing.allocator.alloc(u8, MAX_RUNS_JSON_BYTES + 1);
    defer std.testing.allocator.free(json);
    @memset(json, ' ');

    try std.testing.expectError(error.RunsJsonTooLarge, parseRunsPayload(std.testing.allocator, json));
}

test "nightly rejects oversized runs files before allocation" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var file = try tmp.dir.createFile(std.testing.io, "runs.json", .{});
    try file.writePositionalAll(std.testing.io, "x", MAX_RUNS_JSON_BYTES);
    file.close(std.testing.io);

    try std.testing.expectError(
        error.RunsJsonTooLarge,
        readRunsJsonBytes(std.testing.io, tmp.dir, std.testing.failing_allocator, "runs.json"),
    );
}

test "nightly rejects unsafe runs file paths at read boundary" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    for ([_][]const u8{
        "../runs.json",
        "/tmp/runs.json",
        "nightly-artifacts//runs.json",
        "C:\\temp\\runs.json",
    }) |path| {
        try std.testing.expectError(
            error.InvalidRunsJsonPath,
            readRunsJsonBytes(std.testing.io, tmp.dir, std.testing.failing_allocator, path),
        );
    }
}

test "nightly rejects oversized scalar values during runs payload parsing" {
    const oversized = [_]u8{'x'} ** (MAX_RUNS_JSON_VALUE_BYTES + 1);
    const json = try std.fmt.allocPrint(std.testing.allocator,
        \\{{"workflow_runs":[{{"id":42,"name":"Nightly","event":"schedule","head_sha":"0123456789abcdef0123456789abcdef01234567","conclusion":"success","html_url":"{s}"}}]}}
    , .{oversized[0..]});
    defer std.testing.allocator.free(json);

    try std.testing.expectError(error.ValueTooLong, parseRunsPayload(std.testing.allocator, json));
}

test "nightly omits unsafe matched run URLs from API payload" {
    const json =
        \\{"workflow_runs":[{"id":42,"name":"Nightly","event":"schedule","head_sha":"0123456789abcdef0123456789abcdef01234567","conclusion":"success","html_url":"https://github.com/nullclaw/nullbuilder/actions/runs/42%zz"}]}
    ;
    var parsed = try parseRunsPayload(std.testing.allocator, json);
    defer parsed.deinit();

    const decision = decideShouldBuildFromPayload(parsed.value, "43", TEST_HEAD_SHA, "Nightly", false);
    try std.testing.expect(!decision.should_build);
    try std.testing.expectEqual(@as(?u64, 42), decision.matched_run_id);
    try std.testing.expectEqualStrings("", decision.matched_run_url);

    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeDecision(&out.writer, decision);
    try std.testing.expectEqualStrings(
        \\should_build=false
        \\reason=successful-nightly-exists
        \\matched_run_id=42
        \\
    , out.writer.buffered());
}

test "nightly omits encoded-control matched run URLs from API payload" {
    const json =
        \\{"workflow_runs":[{"id":42,"name":"Nightly","event":"schedule","head_sha":"0123456789abcdef0123456789abcdef01234567","conclusion":"success","html_url":"https://github.com/nullclaw/nullbuilder/actions/runs/42%0aoutput=true"}]}
    ;
    var parsed = try parseRunsPayload(std.testing.allocator, json);
    defer parsed.deinit();

    const decision = decideShouldBuildFromPayload(parsed.value, "43", TEST_HEAD_SHA, "Nightly", false);
    try std.testing.expect(!decision.should_build);
    try std.testing.expectEqual(@as(?u64, 42), decision.matched_run_id);
    try std.testing.expectEqualStrings("", decision.matched_run_url);
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
    unsafe_run_options.current_run_id = "01";
    try std.testing.expectError(error.InvalidCurrentRunId, validateDecideOptions(unsafe_run_options));

    var unsafe_sha_options = valid_options;
    unsafe_sha_options.head_sha = "not-a-sha";
    try std.testing.expectError(error.InvalidHeadSha, validateDecideOptions(unsafe_sha_options));

    var unsafe_workflow_options = valid_options;
    unsafe_workflow_options.workflow_name = "Nightly\ninjected";
    try std.testing.expectError(error.InvalidWorkflowName, validateDecideOptions(unsafe_workflow_options));

    const oversized_workflow_name = [_]u8{'n'} ** (MAX_WORKFLOW_NAME_BYTES + 1);
    unsafe_workflow_options.workflow_name = oversized_workflow_name[0..];
    try std.testing.expectError(error.InvalidWorkflowName, validateDecideOptions(unsafe_workflow_options));
}
