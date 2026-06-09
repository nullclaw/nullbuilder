const std = @import("std");

const stdout_limit = 16 * 1024 * 1024;
const stderr_limit = 4 * 1024 * 1024;

pub fn run(gpa: std.mem.Allocator, io: std.Io, argv: []const []const u8) !std.process.RunResult {
    return std.process.run(gpa, io, .{
        .argv = argv,
        .stdout_limit = std.Io.Limit.limited(stdout_limit),
        .stderr_limit = std.Io.Limit.limited(stderr_limit),
    });
}

pub fn freeResult(gpa: std.mem.Allocator, result: std.process.RunResult) void {
    gpa.free(result.stdout);
    gpa.free(result.stderr);
}

pub fn writeCaptured(out: *std.Io.Writer, result: std.process.RunResult) !void {
    if (result.stdout.len > 0) try out.writeAll(result.stdout);
    if (result.stderr.len > 0) try out.writeAll(result.stderr);
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

            if (result.stderr.len > 0) try out.writeAll(result.stderr);
            if (result.stdout.len > 0) try out.writeAll(result.stdout);
            return code;
        },
        else => {
            if (result.stderr.len > 0) try out.writeAll(result.stderr);
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
