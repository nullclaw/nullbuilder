const std = @import("std");

const dashboard_json = @import("dashboard_json.zig");

const JsonObject = dashboard_json.JsonObject;

const completed_status = "completed";
const error_status = "error";
const failure_conclusion = "failure";
const missing_status = "n/a";
const success_conclusion = "success";
const max_run_label_len = 64;

pub const RunLabel = enum {
    completed,
    queued,
    in_progress,
    requested,
    waiting,
    pending,
    success,
    failure,
    neutral,
    cancelled,
    skipped,
    timed_out,
    action_required,
    startup_failure,
    stale,
    missing,
    errored,

    pub fn text(self: RunLabel) []const u8 {
        return switch (self) {
            .completed => completed_status,
            .queued => "queued",
            .in_progress => "in_progress",
            .requested => "requested",
            .waiting => "waiting",
            .pending => "pending",
            .success => success_conclusion,
            .failure => failure_conclusion,
            .neutral => "neutral",
            .cancelled => "cancelled",
            .skipped => "skipped",
            .timed_out => "timed_out",
            .action_required => "action_required",
            .startup_failure => "startup_failure",
            .stale => "stale",
            .missing => missing_status,
            .errored => error_status,
        };
    }

    pub fn isSuccess(self: RunLabel) bool {
        return self == .success;
    }

    pub fn isRunning(self: RunLabel) bool {
        return switch (self) {
            .queued, .in_progress, .requested, .waiting, .pending => true,
            else => false,
        };
    }

    pub fn isMissing(self: RunLabel) bool {
        return self == .missing;
    }

    pub fn isFailure(self: RunLabel) bool {
        return switch (self) {
            .errored,
            .failure,
            .neutral,
            .cancelled,
            .skipped,
            .timed_out,
            .action_required,
            .startup_failure,
            .stale,
            => true,
            else => false,
        };
    }

    pub fn matches(self: RunLabel, value: []const u8) bool {
        return std.mem.eql(u8, value, self.text());
    }
};

const RunSlot = enum {
    ci,
    nightly,
    release,

    fn fieldName(self: RunSlot) []const u8 {
        return switch (self) {
            .ci => "ci",
            .nightly => "nightly",
            .release => "release",
        };
    }
};
const run_slots = [_]RunSlot{ .ci, .nightly, .release };
const workflow_status_labels = [_]RunLabel{
    .completed,
    .queued,
    .in_progress,
    .requested,
    .waiting,
    .pending,
};
const workflow_conclusion_labels = [_]RunLabel{
    .success,
    .failure,
    .neutral,
    .cancelled,
    .skipped,
    .timed_out,
    .action_required,
    .startup_failure,
    .stale,
};

pub const RunStatuses = struct {
    ci: RunLabel,
    nightly: RunLabel,
    release: RunLabel,

    fn fromLatest(latest_runs: JsonObject) RunStatuses {
        return .{
            .ci = runLabel(latest_runs, .ci),
            .nightly = runLabel(latest_runs, .nightly),
            .release = runLabel(latest_runs, .release),
        };
    }
};

pub const RepositoryRunState = enum {
    loaded,
    errored,
};

pub fn repositoryRunStatuses(repository_state: RepositoryRunState, latest: ?JsonObject) RunStatuses {
    return switch (repository_state) {
        .loaded => if (latest) |latest_runs| RunStatuses.fromLatest(latest_runs) else repeatedStatus(.missing),
        .errored => repeatedStatus(.errored),
    };
}

pub fn repositoryHasFailure(latest: ?JsonObject) bool {
    const latest_runs = latest orelse return false;
    for (run_slots) |slot| {
        if (isFailedRun(latest_runs, slot)) return true;
    }

    return false;
}

pub fn isSuccessLabel(label: RunLabel) bool {
    return label.isSuccess();
}

pub fn isRunningLabel(label: RunLabel) bool {
    return label.isRunning();
}

pub fn isMissingLabel(label: RunLabel) bool {
    return label.isMissing();
}

pub fn isFailureLabel(label: RunLabel) bool {
    return label.isFailure();
}

fn repeatedStatus(label: RunLabel) RunStatuses {
    return .{ .ci = label, .nightly = label, .release = label };
}

fn isFailedRun(latest: JsonObject, slot: RunSlot) bool {
    const run = dashboard_json.objectField(latest, slot.fieldName()) orelse return false;
    const status = runStatus(run);
    if (status != .completed) return false;
    return !runConclusion(run, .failure).isSuccess();
}

fn runLabel(latest: JsonObject, slot: RunSlot) RunLabel {
    const run = dashboard_json.objectField(latest, slot.fieldName()) orelse return .missing;
    const status = runStatus(run);
    if (status != .completed) return status;
    return runConclusion(run, .completed);
}

fn runStatus(run: JsonObject) RunLabel {
    const value = dashboard_json.requiredSafeTextField(run, "status", max_run_label_len) orelse return .missing;
    return canonicalStatus(value) orelse .missing;
}

fn runConclusion(run: JsonObject, fallback: RunLabel) RunLabel {
    const value = dashboard_json.requiredSafeTextField(run, "conclusion", max_run_label_len) orelse return fallback;
    return canonicalConclusion(value) orelse .failure;
}

fn canonicalStatus(value: []const u8) ?RunLabel {
    return canonicalLabel(value, &workflow_status_labels);
}

fn canonicalConclusion(value: []const u8) ?RunLabel {
    return canonicalLabel(value, &workflow_conclusion_labels);
}

fn canonicalLabel(value: []const u8, labels: []const RunLabel) ?RunLabel {
    for (labels) |label| {
        if (label.matches(value)) return label;
    }

    return null;
}

test "repositoryRunStatuses maps active completed missing and error runs" {
    var parsed = try std.json.parseFromSlice(dashboard_json.JsonValue, std.testing.allocator,
        \\{
        \\  "ci": {"status": "completed", "conclusion": "success"},
        \\  "nightly": {"status": "in_progress"},
        \\  "release": {"status": "completed", "conclusion": null}
        \\}
    , .{});
    defer parsed.deinit();

    const statuses = repositoryRunStatuses(.loaded, parsed.value.object);
    try std.testing.expectEqual(RunLabel.success, statuses.ci);
    try std.testing.expectEqual(RunLabel.in_progress, statuses.nightly);
    try std.testing.expectEqual(RunLabel.completed, statuses.release);

    const missing = repositoryRunStatuses(.loaded, null);
    try std.testing.expectEqual(RunLabel.missing, missing.ci);
    try std.testing.expectEqual(RunLabel.missing, missing.nightly);
    try std.testing.expectEqual(RunLabel.missing, missing.release);

    const errored = repositoryRunStatuses(.errored, null);
    try std.testing.expectEqual(RunLabel.errored, errored.ci);
    try std.testing.expectEqual(RunLabel.errored, errored.nightly);
    try std.testing.expectEqual(RunLabel.errored, errored.release);
}

test "workflow run slots define the dashboard JSON field contract" {
    try std.testing.expectEqual(@as(usize, 3), run_slots.len);
    try std.testing.expectEqualStrings("ci", run_slots[0].fieldName());
    try std.testing.expectEqualStrings("nightly", run_slots[1].fieldName());
    try std.testing.expectEqualStrings("release", run_slots[2].fieldName());
}

test "repositoryRunStatuses rejects oversized run labels" {
    const oversized = [_]u8{'x'} ** 128;
    const json = try std.fmt.allocPrint(std.testing.allocator,
        \\{{
        \\  "ci": {{"status": "{s}"}},
        \\  "nightly": {{"status": "completed", "conclusion": "{s}"}}
        \\}}
    , .{ oversized[0..], oversized[0..] });
    defer std.testing.allocator.free(json);

    var parsed = try std.json.parseFromSlice(dashboard_json.JsonValue, std.testing.allocator, json, .{});
    defer parsed.deinit();

    const statuses = repositoryRunStatuses(.loaded, parsed.value.object);
    try std.testing.expectEqual(RunLabel.missing, statuses.ci);
    try std.testing.expectEqual(RunLabel.completed, statuses.nightly);
}

test "repositoryRunStatuses rejects control-bearing run labels" {
    var parsed = try std.json.parseFromSlice(dashboard_json.JsonValue, std.testing.allocator,
        \\{
        \\  "ci": {"status": "queued\n"},
        \\  "nightly": {"status": "completed", "conclusion": "failure\u001b[31m"},
        \\  "release": {"status": "completed", "conclusion": "success"}
        \\}
    , .{});
    defer parsed.deinit();

    const statuses = repositoryRunStatuses(.loaded, parsed.value.object);
    try std.testing.expectEqual(RunLabel.missing, statuses.ci);
    try std.testing.expectEqual(RunLabel.completed, statuses.nightly);
    try std.testing.expectEqual(RunLabel.success, statuses.release);
    try std.testing.expect(repositoryHasFailure(parsed.value.object));
}

test "repositoryRunStatuses rejects unknown run labels without echoing them" {
    var parsed = try std.json.parseFromSlice(dashboard_json.JsonValue, std.testing.allocator,
        \\{
        \\  "ci": {"status": "deploying-secret"},
        \\  "nightly": {"status": "completed", "conclusion": "private-secret"},
        \\  "release": {"status": "completed", "conclusion": "action_required"}
        \\}
    , .{});
    defer parsed.deinit();

    const statuses = repositoryRunStatuses(.loaded, parsed.value.object);
    try std.testing.expectEqual(RunLabel.missing, statuses.ci);
    try std.testing.expectEqual(RunLabel.failure, statuses.nightly);
    try std.testing.expectEqual(RunLabel.action_required, statuses.release);
    try std.testing.expect(repositoryHasFailure(parsed.value.object));
}

test "run label classifiers share the workflow display policy" {
    try std.testing.expect(isSuccessLabel(.success));
    try std.testing.expect(isRunningLabel(.queued));
    try std.testing.expect(isRunningLabel(.in_progress));
    try std.testing.expect(isRunningLabel(.requested));
    try std.testing.expect(isRunningLabel(.waiting));
    try std.testing.expect(isRunningLabel(.pending));
    try std.testing.expect(isMissingLabel(.missing));
    try std.testing.expect(isFailureLabel(.failure));
    try std.testing.expect(isFailureLabel(.neutral));
    try std.testing.expect(isFailureLabel(.cancelled));
    try std.testing.expect(isFailureLabel(.skipped));
    try std.testing.expect(isFailureLabel(.timed_out));
    try std.testing.expect(isFailureLabel(.action_required));
    try std.testing.expect(isFailureLabel(.startup_failure));
    try std.testing.expect(isFailureLabel(.stale));
    try std.testing.expect(isFailureLabel(.errored));

    try std.testing.expect(!isRunningLabel(.completed));
    try std.testing.expect(!isFailureLabel(.success));
    try std.testing.expect(!isFailureLabel(.completed));
    try std.testing.expect(!isRunningLabel(.failure));
}

test "workflow label registries accept only canonical labels" {
    for (workflow_status_labels) |label| {
        try std.testing.expectEqual(label, canonicalStatus(label.text()).?);
        try std.testing.expectEqual(@as(?RunLabel, null), canonicalConclusion(label.text()));
        try std.testing.expect(label.matches(label.text()));
        try std.testing.expect(!label.matches(""));
    }

    for (workflow_conclusion_labels) |label| {
        try std.testing.expectEqual(label, canonicalConclusion(label.text()).?);
        try std.testing.expectEqual(@as(?RunLabel, null), canonicalStatus(label.text()));
        try std.testing.expect(label.matches(label.text()));
        try std.testing.expect(!label.matches(""));
    }

    try std.testing.expectEqual(@as(?RunLabel, null), canonicalStatus(""));
    try std.testing.expectEqual(@as(?RunLabel, null), canonicalStatus("deploying-secret"));
    try std.testing.expectEqual(@as(?RunLabel, null), canonicalStatus("completed\n"));
    try std.testing.expectEqual(@as(?RunLabel, null), canonicalConclusion(""));
    try std.testing.expectEqual(@as(?RunLabel, null), canonicalConclusion("private-secret"));
    try std.testing.expectEqual(@as(?RunLabel, null), canonicalConclusion("success\n"));
}

test "repositoryRunStatuses falls back for empty run labels" {
    var parsed = try std.json.parseFromSlice(dashboard_json.JsonValue, std.testing.allocator,
        \\{
        \\  "ci": {"status": ""},
        \\  "nightly": {"status": "completed", "conclusion": ""},
        \\  "release": {"status": "completed", "conclusion": "success"}
        \\}
    , .{});
    defer parsed.deinit();

    const statuses = repositoryRunStatuses(.loaded, parsed.value.object);
    try std.testing.expectEqual(RunLabel.missing, statuses.ci);
    try std.testing.expectEqual(RunLabel.completed, statuses.nightly);
    try std.testing.expectEqual(RunLabel.success, statuses.release);
    try std.testing.expect(repositoryHasFailure(parsed.value.object));
}

test "repositoryHasFailure counts only completed non-success runs" {
    var parsed = try std.json.parseFromSlice(dashboard_json.JsonValue, std.testing.allocator,
        \\{
        \\  "ci": {"status": "completed", "conclusion": "failure"},
        \\  "nightly": {"status": "queued", "conclusion": "failure"},
        \\  "release": {"status": "completed", "conclusion": "success"}
        \\}
    , .{});
    defer parsed.deinit();

    try std.testing.expect(repositoryHasFailure(parsed.value.object));

    var passing = try std.json.parseFromSlice(dashboard_json.JsonValue, std.testing.allocator,
        \\{
        \\  "ci": {"status": "completed", "conclusion": "success"},
        \\  "nightly": {"status": "queued"},
        \\  "release": {}
        \\}
    , .{});
    defer passing.deinit();

    try std.testing.expect(!repositoryHasFailure(passing.value.object));
}
