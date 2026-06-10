const std = @import("std");
const action_text = @import("action_text");

const MAX_DIAGNOSTIC_TOKEN_BYTES = 512;
const MAX_VALUE_TOKEN_BYTES = 4096;
pub const invalid_arguments_exit_code: u8 = 2;

pub fn takeValue(
    iterator: *std.process.Args.Iterator,
    allocator: std.mem.Allocator,
    flag: []const u8,
) ![]const u8 {
    const value = iterator.next() orelse {
        printDiagnostic("missing value for {s}\n", flag);
        return error.InvalidArguments;
    };
    try validateValueToken(flag, value);
    return try allocator.dupe(u8, value);
}

pub fn required(value: ?[]const u8, flag: []const u8) ![]const u8 {
    return value orelse {
        printDiagnostic("missing required option: {s}\n", flag);
        return error.InvalidArguments;
    };
}

pub fn unexpectedOption(arg: []const u8) error{InvalidArguments} {
    printDiagnostic("unknown option: {s}\n", arg);
    return error.InvalidArguments;
}

pub fn invalidArgumentExitCode(err: anyerror) ?u8 {
    return switch (err) {
        error.InvalidArguments => invalid_arguments_exit_code,
        else => null,
    };
}

pub fn printDiagnostic(comptime format: []const u8, value: []const u8) void {
    var buffer: [MAX_DIAGNOSTIC_TOKEN_BYTES]u8 = undefined;
    const token = sanitizeDiagnosticToken(value, &buffer);
    std.debug.print(format, .{token});
}

pub fn sanitizeDiagnosticToken(value: []const u8, buffer: []u8) []const u8 {
    return action_text.sanitizeDiagnosticToken(value, buffer);
}

fn validateValueToken(flag: []const u8, value: []const u8) error{InvalidArguments}!void {
    if (isOptionLikeValue(value)) {
        printDiagnostic("missing value for {s}\n", flag);
        return error.InvalidArguments;
    }

    if (isOversizedValueToken(value)) {
        printDiagnostic("invalid value for {s}\n", flag);
        return error.InvalidArguments;
    }

    if (hasUnsafeValueControl(value)) {
        printDiagnostic("invalid value for {s}\n", flag);
        return error.InvalidArguments;
    }
}

fn isOptionLikeValue(value: []const u8) bool {
    return std.mem.startsWith(u8, value, "-");
}

fn isOversizedValueToken(value: []const u8) bool {
    return value.len > MAX_VALUE_TOKEN_BYTES;
}

fn hasUnsafeValueControl(value: []const u8) bool {
    return action_text.hasControl(value);
}

test "required returns present values" {
    try std.testing.expectEqualStrings("value", try required("value", "--flag"));
}

test "invalid argument errors map to usage exit code only" {
    try std.testing.expectEqual(@as(?u8, 2), invalidArgumentExitCode(error.InvalidArguments));
    try std.testing.expectEqual(@as(?u8, null), invalidArgumentExitCode(error.OutOfMemory));
}

test "value tokens reject option-looking arguments" {
    try std.testing.expect(!isOptionLikeValue("value"));
    try std.testing.expect(isOptionLikeValue("--other"));
    try std.testing.expect(isOptionLikeValue("-x"));
}

test "value tokens are bounded before duplication" {
    const max_value = [_]u8{'a'} ** MAX_VALUE_TOKEN_BYTES;
    const oversized_value = [_]u8{'a'} ** (MAX_VALUE_TOKEN_BYTES + 1);

    try validateValueToken("--flag", max_value[0..]);
    try std.testing.expect(!isOversizedValueToken(max_value[0..]));
    try std.testing.expect(isOversizedValueToken(oversized_value[0..]));
}

test "value tokens reject terminal controls before duplication" {
    try validateValueToken("--flag", "value with spaces");

    try std.testing.expect(hasUnsafeValueControl("bad\nvalue"));
    try std.testing.expect(hasUnsafeValueControl("bad\x1b[31mvalue"));
    try std.testing.expect(hasUnsafeValueControl("bad\xc2\x85value"));
    try std.testing.expect(hasUnsafeValueControl("bad\x85value"));
}

test "diagnostic tokens replace controls and bound output" {
    var buffer: [16]u8 = undefined;
    try std.testing.expectEqualStrings(
        "bad  value",
        sanitizeDiagnosticToken("bad\n\x1b[31m\tvalue", &buffer),
    );

    var title_buffer: [32]u8 = undefined;
    try std.testing.expectEqualStrings(
        "baddone",
        sanitizeDiagnosticToken("bad\x1b]0;title\x07done", &title_buffer),
    );

    var c1_buffer: [32]u8 = undefined;
    try std.testing.expectEqualStrings(
        "bad next raw",
        sanitizeDiagnosticToken("bad\xc2\x85next\x85raw", &c1_buffer),
    );

    var short_buffer: [4]u8 = undefined;
    try std.testing.expectEqualStrings("abcd", sanitizeDiagnosticToken("abcdef", &short_buffer));
}
