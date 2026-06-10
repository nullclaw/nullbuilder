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
        if (!fitsTotalByteBudget(total_bytes, arg.len, policy.max_total_bytes)) return false;
        if (has_unsafe_text(arg)) return false;
        total_bytes += arg.len;
    }

    return true;
}

fn fitsTotalByteBudget(used_bytes: usize, next_bytes: usize, max_total_bytes: usize) bool {
    if (used_bytes > max_total_bytes) return false;
    return next_bytes <= max_total_bytes - used_bytes;
}

fn testHasUnsafeText(value: []const u8) bool {
    return std.mem.indexOfAny(u8, value, "\n\r\x1b") != null;
}

fn testHasNoUnsafeText(_: []const u8) bool {
    return false;
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

test "arg safety accounts total bytes without underflow" {
    const policy = ArgVectorPolicy{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = 0,
    };

    try std.testing.expect(isSafeArgVector(&.{}, policy, testHasNoUnsafeText));
    try std.testing.expect(isSafeArgVector(&.{""}, policy, testHasNoUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"x"}, policy, testHasNoUnsafeText));
    try std.testing.expect(fitsTotalByteBudget(std.math.maxInt(usize), 0, std.math.maxInt(usize)));
    try std.testing.expect(!fitsTotalByteBudget(std.math.maxInt(usize), 1, std.math.maxInt(usize)));
    try std.testing.expect(!fitsTotalByteBudget(2, 0, 1));
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
