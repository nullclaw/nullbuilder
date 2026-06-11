const std = @import("std");

const dashboard_json = @import("dashboard_json.zig");

const JsonObject = dashboard_json.JsonObject;

const completed_status = "completed";
const error_status = "error";
const failure_conclusion = "failure";
const missing_status = "n/a";
const success_conclusion = "success";
const max_run_label_len = 64;
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
const workflow_status_labels = [_][]const u8{
    completed_status,
    "queued",
    "in_progress",
    "requested",
    "waiting",
    "pending",
};
const workflow_conclusion_labels = [_][]const u8{
    success_conclusion,
    failure_conclusion,
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "startup_failure",
    "stale",
};

pub const RunStatuses = struct {
    ci: []const u8,
    nightly: []const u8,
    release: []const u8,

    fn fromLatest(latest_runs: JsonObject) RunStatuses {
        return .{
            .ci = runLabel(latest_runs, .ci),
            .nightly = runLabel(latest_runs, .nightly),
            .release = runLabel(latest_runs, .release),
        };
    }
};

pub fn repositoryRunStatuses(repository_status: []const u8, latest: ?JsonObject) RunStatuses {
    if (std.mem.eql(u8, repository_status, error_status)) {
        return repeatedStatus(error_status);
    }

    const latest_runs = latest orelse return repeatedStatus(missing_status);
    return RunStatuses.fromLatest(latest_runs);
}

pub fn repositoryHasFailure(latest: ?JsonObject) bool {
    const latest_runs = latest orelse return false;
    for (run_slots) |slot| {
        if (isFailedRun(latest_runs, slot)) return true;
    }

    return false;
}

pub fn isSuccessLabel(label: []const u8) bool {
    return std.mem.eql(u8, label, success_conclusion);
}

pub fn isRunningLabel(label: []const u8) bool {
    const status = canonicalStatus(label) orelse return false;
    return !std.mem.eql(u8, status, completed_status);
}

pub fn isMissingLabel(label: []const u8) bool {
    return std.mem.eql(u8, label, missing_status);
}

pub fn isFailureLabel(label: []const u8) bool {
    if (std.mem.eql(u8, label, error_status)) return true;
    const conclusion = canonicalConclusion(label) orelse return false;
    return !std.mem.eql(u8, conclusion, success_conclusion);
}

fn repeatedStatus(label: []const u8) RunStatuses {
    return .{ .ci = label, .nightly = label, .release = label };
}

fn isFailedRun(latest: JsonObject, slot: RunSlot) bool {
    const run = dashboard_json.objectField(latest, slot.fieldName()) orelse return false;
    const status = runStatus(run);
    if (!std.mem.eql(u8, status, completed_status)) return false;
    return !std.mem.eql(u8, runConclusion(run, ""), success_conclusion);
}

fn runLabel(latest: JsonObject, slot: RunSlot) []const u8 {
    const run = dashboard_json.objectField(latest, slot.fieldName()) orelse return missing_status;
    const status = runStatus(run);
    if (!std.mem.eql(u8, status, completed_status)) return status;
    return runConclusion(run, completed_status);
}

fn runStatus(run: JsonObject) []const u8 {
    const value = dashboard_json.requiredSafeTextField(run, "status", max_run_label_len) orelse return missing_status;
    return canonicalStatus(value) orelse missing_status;
}

fn runConclusion(run: JsonObject, fallback: []const u8) []const u8 {
    const value = dashboard_json.requiredSafeTextField(run, "conclusion", max_run_label_len) orelse return fallback;
    return canonicalConclusion(value) orelse failure_conclusion;
}

fn canonicalStatus(value: []const u8) ?[]const u8 {
    return canonicalLabel(value, &workflow_status_labels);
}

fn canonicalConclusion(value: []const u8) ?[]const u8 {
    return canonicalLabel(value, &workflow_conclusion_labels);
}

fn canonicalLabel(value: []const u8, labels: []const []const u8) ?[]const u8 {
    for (labels) |label| {
        if (std.mem.eql(u8, value, label)) return label;
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

    const statuses = repositoryRunStatuses("ok", parsed.value.object);
    try std.testing.expectEqualStrings(success_conclusion, statuses.ci);
    try std.testing.expectEqualStrings("in_progress", statuses.nightly);
    try std.testing.expectEqualStrings(completed_status, statuses.release);

    const missing = repositoryRunStatuses("ok", null);
    try std.testing.expectEqualStrings(missing_status, missing.ci);
    try std.testing.expectEqualStrings(missing_status, missing.nightly);
    try std.testing.expectEqualStrings(missing_status, missing.release);

    const errored = repositoryRunStatuses(error_status, null);
    try std.testing.expectEqualStrings(error_status, errored.ci);
    try std.testing.expectEqualStrings(error_status, errored.nightly);
    try std.testing.expectEqualStrings(error_status, errored.release);
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

    const statuses = repositoryRunStatuses("ok", parsed.value.object);
    try std.testing.expectEqualStrings(missing_status, statuses.ci);
    try std.testing.expectEqualStrings(completed_status, statuses.nightly);
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

    const statuses = repositoryRunStatuses("ok", parsed.value.object);
    try std.testing.expectEqualStrings(missing_status, statuses.ci);
    try std.testing.expectEqualStrings(completed_status, statuses.nightly);
    try std.testing.expectEqualStrings(success_conclusion, statuses.release);
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

    const statuses = repositoryRunStatuses("ok", parsed.value.object);
    try std.testing.expectEqualStrings(missing_status, statuses.ci);
    try std.testing.expectEqualStrings(failure_conclusion, statuses.nightly);
    try std.testing.expectEqualStrings("action_required", statuses.release);
    try std.testing.expect(repositoryHasFailure(parsed.value.object));
}

test "run label classifiers share the workflow display policy" {
    try std.testing.expect(isSuccessLabel("success"));
    try std.testing.expect(isRunningLabel("queued"));
    try std.testing.expect(isRunningLabel("in_progress"));
    try std.testing.expect(isRunningLabel("requested"));
    try std.testing.expect(isRunningLabel("waiting"));
    try std.testing.expect(isRunningLabel("pending"));
    try std.testing.expect(isMissingLabel("n/a"));
    try std.testing.expect(isFailureLabel("failure"));
    try std.testing.expect(isFailureLabel("neutral"));
    try std.testing.expect(isFailureLabel("cancelled"));
    try std.testing.expect(isFailureLabel("skipped"));
    try std.testing.expect(isFailureLabel("timed_out"));
    try std.testing.expect(isFailureLabel("action_required"));
    try std.testing.expect(isFailureLabel("startup_failure"));
    try std.testing.expect(isFailureLabel("stale"));
    try std.testing.expect(isFailureLabel("error"));

    try std.testing.expect(!isRunningLabel("completed"));
    try std.testing.expect(!isFailureLabel("success"));
    try std.testing.expect(!isFailureLabel("private-secret"));
    try std.testing.expect(!isRunningLabel("deploying-secret"));
}

test "workflow label registries accept only canonical labels" {
    for (workflow_status_labels) |label| {
        try std.testing.expectEqualStrings(label, canonicalStatus(label).?);
        try std.testing.expectEqual(@as(?[]const u8, null), canonicalConclusion(label));
    }

    for (workflow_conclusion_labels) |label| {
        try std.testing.expectEqualStrings(label, canonicalConclusion(label).?);
        try std.testing.expectEqual(@as(?[]const u8, null), canonicalStatus(label));
    }

    try std.testing.expectEqual(@as(?[]const u8, null), canonicalStatus(""));
    try std.testing.expectEqual(@as(?[]const u8, null), canonicalStatus("deploying-secret"));
    try std.testing.expectEqual(@as(?[]const u8, null), canonicalStatus("completed\n"));
    try std.testing.expectEqual(@as(?[]const u8, null), canonicalConclusion(""));
    try std.testing.expectEqual(@as(?[]const u8, null), canonicalConclusion("private-secret"));
    try std.testing.expectEqual(@as(?[]const u8, null), canonicalConclusion("success\n"));
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

    const statuses = repositoryRunStatuses("", parsed.value.object);
    try std.testing.expectEqualStrings(missing_status, statuses.ci);
    try std.testing.expectEqualStrings(completed_status, statuses.nightly);
    try std.testing.expectEqualStrings(success_conclusion, statuses.release);
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
