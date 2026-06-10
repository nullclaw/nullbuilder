const std = @import("std");

const terminal = @import("terminal.zig");

const default_stdout_limit = 16 * 1024 * 1024;
const default_stderr_limit = 4 * 1024 * 1024;

pub const OutputLimits = struct {
    stdout: usize = default_stdout_limit,
    stderr: usize = default_stderr_limit,
};

pub fn run(gpa: std.mem.Allocator, io: std.Io, argv: []const []const u8, limits: OutputLimits) !std.process.RunResult {
    return std.process.run(gpa, io, .{
        .argv = argv,
        .stdout_limit = std.Io.Limit.limited(limits.stdout),
        .stderr_limit = std.Io.Limit.limited(limits.stderr),
    });
}

pub fn freeResult(gpa: std.mem.Allocator, result: std.process.RunResult) void {
    gpa.free(result.stdout);
    gpa.free(result.stderr);
}

pub fn writeCaptured(out: *std.Io.Writer, result: std.process.RunResult) !void {
    if (result.stdout.len > 0) try terminal.writeSafe(out, result.stdout, .{ .preserve_newlines = true });
    if (result.stderr.len > 0) try terminal.writeSafe(out, result.stderr, .{ .preserve_newlines = true });
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

            if (result.stderr.len > 0) try terminal.writeSafe(out, result.stderr, .{ .preserve_newlines = true });
            if (result.stdout.len > 0) try terminal.writeSafe(out, result.stdout, .{ .preserve_newlines = true });
            return code;
        },
        else => {
            if (result.stderr.len > 0) try terminal.writeSafe(out, result.stderr, .{ .preserve_newlines = true });
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

test "exit code allow-list accepts only configured codes" {
    try std.testing.expect(isAllowedExitCode(0, &.{0}));
    try std.testing.expect(isAllowedExitCode(2, &.{ 0, 2 }));
    try std.testing.expect(!isAllowedExitCode(1, &.{ 0, 2 }));
}
