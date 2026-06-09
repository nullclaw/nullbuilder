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

test "required returns present values" {
    try std.testing.expectEqualStrings("value", try required("value", "--flag"));
}
