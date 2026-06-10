const std = @import("std");

const MAX_DIAGNOSTIC_TOKEN_BYTES = 512;
const MAX_VALUE_TOKEN_BYTES = 4096;

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

pub fn printDiagnostic(comptime format: []const u8, value: []const u8) void {
    var buffer: [MAX_DIAGNOSTIC_TOKEN_BYTES]u8 = undefined;
    const token = sanitizeDiagnosticToken(value, &buffer);
    std.debug.print(format, .{token});
}

pub fn sanitizeDiagnosticToken(value: []const u8, buffer: []u8) []const u8 {
    var written: usize = 0;
    var index: usize = 0;
    while (index < value.len) {
        if (written >= buffer.len) break;
        const byte = value[index];
        if (isUtf8C1Control(value, index)) {
            buffer[written] = ' ';
            index += 2;
        } else {
            buffer[written] = if (isDiagnosticControlByte(byte)) ' ' else byte;
            index += 1;
        }
        written += 1;
    }

    return buffer[0..written];
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
}

fn isOptionLikeValue(value: []const u8) bool {
    return std.mem.startsWith(u8, value, "-");
}

fn isOversizedValueToken(value: []const u8) bool {
    return value.len > MAX_VALUE_TOKEN_BYTES;
}

fn isDiagnosticControlByte(byte: u8) bool {
    return byte < 0x20 or (byte >= 0x7f and byte <= 0x9f);
}

fn isUtf8C1Control(value: []const u8, index: usize) bool {
    return value[index] == 0xc2 and index + 1 < value.len and value[index + 1] >= 0x80 and value[index + 1] <= 0x9f;
}

test "required returns present values" {
    try std.testing.expectEqualStrings("value", try required("value", "--flag"));
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

test "diagnostic tokens replace controls and bound output" {
    var buffer: [16]u8 = undefined;
    try std.testing.expectEqualStrings(
        "bad  [31m value",
        sanitizeDiagnosticToken("bad\n\x1b[31m\tvalue", &buffer),
    );

    var c1_buffer: [32]u8 = undefined;
    try std.testing.expectEqualStrings(
        "bad next raw",
        sanitizeDiagnosticToken("bad\xc2\x85next\x85raw", &c1_buffer),
    );

    var short_buffer: [4]u8 = undefined;
    try std.testing.expectEqualStrings("abcd", sanitizeDiagnosticToken("abcdef", &short_buffer));
}
