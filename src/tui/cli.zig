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
    try writeCapturedWithOrder(out, result, .stdout_first);
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

            try writeCapturedWithOrder(out, result, .stderr_first);
            return code;
        },
        else => {
            var budget = terminal.OutputBudget{ .remaining = max_child_output_display_bytes };
            try writeCapturedStream(out, result.stderr, &budget);
            return error.ChildProcessFailed;
        },
    }
}

const CapturedWriteOrder = enum {
    stdout_first,
    stderr_first,
};

fn writeCapturedWithOrder(out: *std.Io.Writer, result: std.process.RunResult, order: CapturedWriteOrder) !void {
    var budget = terminal.OutputBudget{ .remaining = max_child_output_display_bytes };
    switch (order) {
        .stdout_first => {
            try writeCapturedStream(out, result.stdout, &budget);
            try writeCapturedStream(out, result.stderr, &budget);
        },
        .stderr_first => {
            try writeCapturedStream(out, result.stderr, &budget);
            try writeCapturedStream(out, result.stdout, &budget);
        },
    }
}

fn writeCapturedStream(out: *std.Io.Writer, value: []const u8, budget: *terminal.OutputBudget) !void {
    if (value.len == 0 or budget.truncated) return;
    _ = try terminal.writeSafeBudgeted(out, value, budget, .{ .preserve_newlines = true });
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

test "captured child output shares one display budget across stdout and stderr" {
    const stdout = try std.testing.allocator.alloc(u8, max_child_output_display_bytes);
    defer std.testing.allocator.free(stdout);
    @memset(stdout, 'o');

    const stderr = try std.testing.allocator.dupe(u8, "stderr");
    defer std.testing.allocator.free(stderr);

    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try writeCaptured(&out.writer, .{
        .term = .{ .exited = 0 },
        .stdout = stdout,
        .stderr = stderr,
    });

    const output = out.writer.buffered();
    try std.testing.expectEqual(max_child_output_display_bytes + terminal.truncated_output_suffix.len, output.len);
    try std.testing.expect(std.mem.allEqual(u8, output[0..max_child_output_display_bytes], 'o'));
    try std.testing.expectEqualStrings(terminal.truncated_output_suffix, output[max_child_output_display_bytes..]);
    try std.testing.expect(std.mem.indexOf(u8, output, "stderr") == null);
}

test "failure output keeps stderr first while sharing the display budget" {
    const stdout = try std.testing.allocator.dupe(u8, "stdout");
    defer std.testing.allocator.free(stdout);

    const stderr = try std.testing.allocator.alloc(u8, max_child_output_display_bytes);
    defer std.testing.allocator.free(stderr);
    @memset(stderr, 'e');

    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const exit_code = try exitCodeForFailure(&out.writer, .{
        .term = .{ .exited = 1 },
        .stdout = stdout,
        .stderr = stderr,
    }, &.{0});

    const output = out.writer.buffered();
    try std.testing.expectEqual(@as(?u8, 1), exit_code);
    try std.testing.expectEqual(max_child_output_display_bytes + terminal.truncated_output_suffix.len, output.len);
    try std.testing.expect(std.mem.allEqual(u8, output[0..max_child_output_display_bytes], 'e'));
    try std.testing.expectEqualStrings(terminal.truncated_output_suffix, output[max_child_output_display_bytes..]);
    try std.testing.expect(std.mem.indexOf(u8, output, "stdout") == null);
}
