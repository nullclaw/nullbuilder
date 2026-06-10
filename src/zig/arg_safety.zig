const std = @import("std");

pub const ArgVectorPolicy = struct {
    max_count: usize,
    max_arg_bytes: usize,
    max_total_bytes: usize,
    allow_empty: bool = true,
};

pub fn isSafeArgVector(
    args: []const []const u8,
    policy: ArgVectorPolicy,
    has_unsafe_text: *const fn ([]const u8) bool,
) bool {
    if (!policy.allow_empty and args.len == 0) return false;
    if (args.len > policy.max_count) return false;

    var total_bytes: usize = 0;
    for (args) |arg| {
        if (arg.len > policy.max_arg_bytes) return false;
        if (arg.len > policy.max_total_bytes - total_bytes) return false;
        if (has_unsafe_text(arg)) return false;
        total_bytes += arg.len;
    }

    return true;
}

fn testHasUnsafeText(value: []const u8) bool {
    return std.mem.indexOfAny(u8, value, "\n\r\x1b") != null;
}

test "arg safety bounds vector count and bytes" {
    const policy = ArgVectorPolicy{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = 8,
    };

    try std.testing.expect(isSafeArgVector(&.{}, policy, testHasUnsafeText));
    try std.testing.expect(isSafeArgVector(&.{ "run", "test" }, policy, testHasUnsafeText));
    try std.testing.expect(isSafeArgVector(&.{ "abcd", "efgh" }, policy, testHasUnsafeText));

    try std.testing.expect(!isSafeArgVector(&.{ "one", "two", "three", "four" }, policy, testHasUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"abcde"}, policy, testHasUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{ "abcd", "efgh", "i" }, policy, testHasUnsafeText));
}

test "arg safety rejects empty vectors when required" {
    const policy = ArgVectorPolicy{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = 8,
        .allow_empty = false,
    };

    try std.testing.expect(!isSafeArgVector(&.{}, policy, testHasUnsafeText));
    try std.testing.expect(isSafeArgVector(&.{"run"}, policy, testHasUnsafeText));
}

test "arg safety delegates unsafe text detection" {
    const policy = ArgVectorPolicy{
        .max_count = 3,
        .max_arg_bytes = 64,
        .max_total_bytes = 128,
    };

    try std.testing.expect(isSafeArgVector(&.{"release-\xd0\xbf\xd1\x83\xd1\x82\xd1\x8c"}, policy, testHasUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"bad\narg"}, policy, testHasUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"bad\x1b[31marg"}, policy, testHasUnsafeText));
}
