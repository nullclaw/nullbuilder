const std = @import("std");

const stdout_limit = 16 * 1024 * 1024;
const stderr_limit = 4 * 1024 * 1024;
const ascii_escape: u8 = 0x1b;

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
    if (result.stdout.len > 0) try writeTerminalSafe(out, result.stdout);
    if (result.stderr.len > 0) try writeTerminalSafe(out, result.stderr);
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

            if (result.stderr.len > 0) try writeTerminalSafe(out, result.stderr);
            if (result.stdout.len > 0) try writeTerminalSafe(out, result.stdout);
            return code;
        },
        else => {
            if (result.stderr.len > 0) try writeTerminalSafe(out, result.stderr);
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

fn writeTerminalSafe(out: *std.Io.Writer, value: []const u8) !void {
    var index: usize = 0;
    while (index < value.len) {
        const byte = value[index];
        if (byte == ascii_escape) {
            index = skipAnsiEscape(value, index);
        } else if (isUtf8C1Control(value, index)) {
            try out.writeByte(' ');
            index += 2;
        } else {
            try out.writeByte(if (isUnsafeTerminalControlByte(byte)) ' ' else byte);
            index += 1;
        }
    }
}

fn skipAnsiEscape(value: []const u8, start: usize) usize {
    var index = start + 1;
    if (index >= value.len) return index;

    const introducer = value[index];
    if (introducer == '[') {
        index += 1;
        while (index < value.len) {
            const byte = value[index];
            index += 1;
            if (byte >= 0x40 and byte <= 0x7e) return index;
        }
        return index;
    }

    if (introducer == ']') {
        index += 1;
        while (index < value.len) {
            if (value[index] == 0x07) return index + 1;
            if (value[index] == ascii_escape and index + 1 < value.len and value[index + 1] == '\\') return index + 2;
            index += 1;
        }
        return index;
    }

    return index + 1;
}

fn isUnsafeTerminalControlByte(byte: u8) bool {
    return (byte < 0x20 and byte != '\n') or (byte >= 0x7f and byte <= 0x9f);
}

fn isUtf8C1Control(value: []const u8, index: usize) bool {
    return value[index] == 0xc2 and index + 1 < value.len and value[index + 1] >= 0x80 and value[index + 1] <= 0x9f;
}

test "exit code allow-list accepts only configured codes" {
    try std.testing.expect(isAllowedExitCode(0, &.{0}));
    try std.testing.expect(isAllowedExitCode(2, &.{ 0, 2 }));
    try std.testing.expect(!isAllowedExitCode(1, &.{ 0, 2 }));
}

test "terminal output strips escape sequences and unsafe controls" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try writeTerminalSafe(&out.writer, "ok\nbad\x1b[31mred\x1b[0m\ttext\xc2\x85next\x85raw\x1b]0;title\x07done");

    try std.testing.expectEqualStrings("ok\nbadred text next rawdone", out.writer.buffered());
    try std.testing.expect(std.mem.indexOfScalar(u8, out.writer.buffered(), ascii_escape) == null);
}
