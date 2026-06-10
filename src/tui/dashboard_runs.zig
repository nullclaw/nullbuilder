const std = @import("std");

const dashboard_json = @import("dashboard_json.zig");

const JsonObject = dashboard_json.JsonObject;

const completed_status = "completed";
const error_status = "error";
const missing_status = "n/a";
const success_conclusion = "success";
const max_run_label_len = 64;

pub const RunStatuses = struct {
    ci: []const u8,
    nightly: []const u8,
    release: []const u8,
};

pub fn repositoryRunStatuses(repository_status: []const u8, latest: ?JsonObject) RunStatuses {
    if (std.mem.eql(u8, repository_status, error_status)) {
        return repeatedStatus(error_status);
    }

    const latest_runs = latest orelse return repeatedStatus(missing_status);
    return .{
        .ci = runLabel(latest_runs, "ci"),
        .nightly = runLabel(latest_runs, "nightly"),
        .release = runLabel(latest_runs, "release"),
    };
}

pub fn repositoryHasFailure(latest: ?JsonObject) bool {
    const latest_runs = latest orelse return false;
    return isFailedRun(latest_runs, "ci") or
        isFailedRun(latest_runs, "nightly") or
        isFailedRun(latest_runs, "release");
}

fn repeatedStatus(label: []const u8) RunStatuses {
    return .{ .ci = label, .nightly = label, .release = label };
}

fn isFailedRun(latest: JsonObject, field_name: []const u8) bool {
    const run = dashboard_json.objectField(latest, field_name) orelse return false;
    const status = dashboard_json.safeTextField(run, "status", missing_status, max_run_label_len);
    if (!std.mem.eql(u8, status, completed_status)) return false;
    return !std.mem.eql(u8, dashboard_json.safeTextField(run, "conclusion", "", max_run_label_len), success_conclusion);
}

fn runLabel(latest: JsonObject, field_name: []const u8) []const u8 {
    const run = dashboard_json.objectField(latest, field_name) orelse return missing_status;
    const status = dashboard_json.safeTextField(run, "status", missing_status, max_run_label_len);
    if (!std.mem.eql(u8, status, completed_status)) return status;
    return dashboard_json.safeTextField(run, "conclusion", completed_status, max_run_label_len);
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
