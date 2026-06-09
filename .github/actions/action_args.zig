const std = @import("std");

pub fn takeValue(
    iterator: *std.process.Args.Iterator,
    allocator: std.mem.Allocator,
    flag: []const u8,
) ![]const u8 {
    const value = iterator.next() orelse {
        std.debug.print("missing value for {s}\n", .{flag});
        return error.InvalidArguments;
    };
    try validateValueToken(flag, value);
    return try allocator.dupe(u8, value);
}

pub fn required(value: ?[]const u8, flag: []const u8) ![]const u8 {
    return value orelse {
        std.debug.print("missing required option: {s}\n", .{flag});
        return error.InvalidArguments;
    };
}

pub fn unexpectedOption(arg: []const u8) error{InvalidArguments} {
    std.debug.print("unknown option: {s}\n", .{arg});
    return error.InvalidArguments;
}

fn validateValueToken(flag: []const u8, value: []const u8) error{InvalidArguments}!void {
    if (isOptionLikeValue(value)) {
        std.debug.print("missing value for {s}\n", .{flag});
        return error.InvalidArguments;
    }
}

fn isOptionLikeValue(value: []const u8) bool {
    return std.mem.startsWith(u8, value, "-");
}

test "required returns present values" {
    try std.testing.expectEqualStrings("value", try required("value", "--flag"));
}

test "value tokens reject option-looking arguments" {
    try std.testing.expect(!isOptionLikeValue("value"));
    try std.testing.expect(isOptionLikeValue("--other"));
    try std.testing.expect(isOptionLikeValue("-x"));
}
