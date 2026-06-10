const std = @import("std");

const terminal = @import("terminal.zig");

const default_stdout_limit = 16 * 1024 * 1024;
const default_stderr_limit = 4 * 1024 * 1024;
const max_stdout_limit = default_stdout_limit;
const max_stderr_limit = default_stderr_limit;
const max_child_output_display_bytes = 64 * 1024;

pub const OutputLimits = struct {
    stdout: usize = default_stdout_limit,
    stderr: usize = default_stderr_limit,
};

pub fn run(gpa: std.mem.Allocator, io: std.Io, argv: []const []const u8, limits: OutputLimits) !std.process.RunResult {
    const bounded_limits = normalizeOutputLimits(limits);

    return std.process.run(gpa, io, .{
        .argv = argv,
        .stdout_limit = std.Io.Limit.limited(bounded_limits.stdout),
        .stderr_limit = std.Io.Limit.limited(bounded_limits.stderr),
    });
}

pub fn freeResult(gpa: std.mem.Allocator, result: std.process.RunResult) void {
    gpa.free(result.stdout);
    gpa.free(result.stderr);
}

pub fn writeCaptured(out: *std.Io.Writer, result: std.process.RunResult) !void {
    if (result.stdout.len > 0) _ = try terminal.writeSafeBounded(out, result.stdout, max_child_output_display_bytes, .{ .preserve_newlines = true });
    if (result.stderr.len > 0) _ = try terminal.writeSafeBounded(out, result.stderr, max_child_output_display_bytes, .{ .preserve_newlines = true });
}

pub fn exitCodeForFailure(
    out: *std.Io.Writer,
    result: std.process.RunResult,
    allowed_exit_codes: []const u8,
) !?u8 {
    switch (result.term) {
        .exited => |code| {
            if (isAllowedExitCode(code, allowed_exit_codes)) {
                return null;
            }

            if (result.stderr.len > 0) _ = try terminal.writeSafeBounded(out, result.stderr, max_child_output_display_bytes, .{ .preserve_newlines = true });
            if (result.stdout.len > 0) _ = try terminal.writeSafeBounded(out, result.stdout, max_child_output_display_bytes, .{ .preserve_newlines = true });
            return code;
        },
        else => {
            if (result.stderr.len > 0) _ = try terminal.writeSafeBounded(out, result.stderr, max_child_output_display_bytes, .{ .preserve_newlines = true });
            return error.ChildProcessFailed;
        },
    }
}

fn isAllowedExitCode(code: u8, allowed_exit_codes: []const u8) bool {
    for (allowed_exit_codes) |allowed| {
        if (code == allowed) return true;
    }

    return false;
}

fn normalizeOutputLimits(limits: OutputLimits) OutputLimits {
    return .{
        .stdout = normalizeOutputLimit(limits.stdout, default_stdout_limit, max_stdout_limit),
        .stderr = normalizeOutputLimit(limits.stderr, default_stderr_limit, max_stderr_limit),
    };
}

fn normalizeOutputLimit(value: usize, fallback: usize, max_value: usize) usize {
    if (value == 0) return fallback;
    return @min(value, max_value);
}

test "output limits reject zero and cap oversized values" {
    const defaulted = normalizeOutputLimits(.{ .stdout = 0, .stderr = 0 });
    try std.testing.expectEqual(default_stdout_limit, defaulted.stdout);
    try std.testing.expectEqual(default_stderr_limit, defaulted.stderr);

    const custom = normalizeOutputLimits(.{ .stdout = 4096, .stderr = 2048 });
    try std.testing.expectEqual(@as(usize, 4096), custom.stdout);
    try std.testing.expectEqual(@as(usize, 2048), custom.stderr);

    const capped = normalizeOutputLimits(.{
        .stdout = std.math.maxInt(usize),
        .stderr = max_stderr_limit + 1,
    });
    try std.testing.expectEqual(max_stdout_limit, capped.stdout);
    try std.testing.expectEqual(max_stderr_limit, capped.stderr);
}

test "exit code allow-list accepts only configured codes" {
    try std.testing.expect(isAllowedExitCode(0, &.{0}));
    try std.testing.expect(isAllowedExitCode(2, &.{ 0, 2 }));
    try std.testing.expect(!isAllowedExitCode(1, &.{ 0, 2 }));
}
