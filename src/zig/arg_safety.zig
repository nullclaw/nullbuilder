const std = @import("std");

pub const max_supported_arg_count: usize = 1024;
pub const max_supported_arg_bytes: usize = 64 * 1024;
pub const max_supported_args_total_bytes: usize = 1024 * 1024;

pub const ArgVectorPolicy = struct {
    max_count: usize,
    max_arg_bytes: usize,
    max_total_bytes: usize,
    allow_empty_vector: bool = true,
    allow_empty_args: bool = false,

    fn normalized(self: ArgVectorPolicy) ?ValidatedArgVectorPolicy {
        if (self.max_count == 0 or self.max_count > max_supported_arg_count) return null;
        if (self.max_arg_bytes == 0 or self.max_arg_bytes > max_supported_arg_bytes) return null;
        if (self.max_total_bytes == 0 or self.max_total_bytes > max_supported_args_total_bytes) return null;
        if (self.max_arg_bytes > self.max_total_bytes) return null;

        return .{
            .max_count = self.max_count,
            .max_arg_bytes = self.max_arg_bytes,
            .max_total_bytes = self.max_total_bytes,
            .allow_empty_vector = self.allow_empty_vector,
            .allow_empty_args = self.allow_empty_args,
        };
    }
};

const ValidatedArgVectorPolicy = struct {
    max_count: usize,
    max_arg_bytes: usize,
    max_total_bytes: usize,
    allow_empty_vector: bool,
    allow_empty_args: bool,

    fn acceptsVectorLength(self: ValidatedArgVectorPolicy, length: usize) bool {
        if (!self.allow_empty_vector and length == 0) return false;
        return length <= self.max_count;
    }

    fn acceptsArg(self: ValidatedArgVectorPolicy, arg: []const u8) bool {
        if (!self.allow_empty_args and arg.len == 0) return false;
        return arg.len <= self.max_arg_bytes;
    }

    fn fitsTotalByteBudget(self: ValidatedArgVectorPolicy, used_bytes: usize, next_bytes: usize) bool {
        return argFitsTotalByteBudget(used_bytes, next_bytes, self.max_total_bytes);
    }
};

pub fn isSafeArgVector(
    args: []const []const u8,
    policy: ArgVectorPolicy,
    comptime has_unsafe_text: fn ([]const u8) bool,
) bool {
    const safe_policy = policy.normalized() orelse return false;
    if (!safe_policy.acceptsVectorLength(args.len)) return false;

    var total_bytes: usize = 0;
    for (args) |arg| {
        if (!safe_policy.acceptsArg(arg)) return false;
        if (!safe_policy.fitsTotalByteBudget(total_bytes, arg.len)) return false;
        if (has_unsafe_text(arg)) return false;
        total_bytes += arg.len;
    }

    return true;
}

fn fitsTotalByteBudget(used_bytes: usize, next_bytes: usize, max_total_bytes: usize) bool {
    return argFitsTotalByteBudget(used_bytes, next_bytes, max_total_bytes);
}

fn argFitsTotalByteBudget(used_bytes: usize, next_bytes: usize, max_total_bytes: usize) bool {
    if (used_bytes > max_total_bytes) return false;
    return next_bytes <= max_total_bytes - used_bytes;
}

fn testHasUnsafeText(value: []const u8) bool {
    return std.mem.indexOfAny(u8, value, "\n\r\x1b") != null;
}

fn testHasNoUnsafeText(_: []const u8) bool {
    return false;
}

fn testUnexpectedUnsafeText(_: []const u8) bool {
    @panic("unsafe text callback should not run for invalid policies");
}

var test_counted_unsafe_text_calls: usize = 0;

fn testCountedNoUnsafeText(_: []const u8) bool {
    test_counted_unsafe_text_calls += 1;
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
        .max_arg_bytes = 1,
        .max_total_bytes = 1,
        .allow_empty_args = true,
    };

    try std.testing.expect(isSafeArgVector(&.{}, policy, testHasNoUnsafeText));
    try std.testing.expect(isSafeArgVector(&.{""}, policy, testHasNoUnsafeText));
    try std.testing.expect(isSafeArgVector(&.{"x"}, policy, testHasNoUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{ "x", "y" }, policy, testHasNoUnsafeText));
    try std.testing.expect(fitsTotalByteBudget(std.math.maxInt(usize), 0, std.math.maxInt(usize)));
    try std.testing.expect(!fitsTotalByteBudget(std.math.maxInt(usize), 1, std.math.maxInt(usize)));
    try std.testing.expect(!fitsTotalByteBudget(2, 0, 1));
}

test "arg safety rejects unsafe policies before scanning arguments" {
    try std.testing.expect(!isSafeArgVector(&.{"run"}, .{
        .max_count = 0,
        .max_arg_bytes = 4,
        .max_total_bytes = 8,
    }, testUnexpectedUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"run"}, .{
        .max_count = 3,
        .max_arg_bytes = 0,
        .max_total_bytes = 8,
    }, testUnexpectedUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"run"}, .{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = 0,
    }, testUnexpectedUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"run"}, .{
        .max_count = max_supported_arg_count + 1,
        .max_arg_bytes = 4,
        .max_total_bytes = 8,
    }, testUnexpectedUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"run"}, .{
        .max_count = 3,
        .max_arg_bytes = max_supported_arg_bytes + 1,
        .max_total_bytes = max_supported_arg_bytes + 1,
    }, testUnexpectedUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"run"}, .{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = max_supported_args_total_bytes + 1,
    }, testUnexpectedUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"run"}, .{
        .max_count = 3,
        .max_arg_bytes = 9,
        .max_total_bytes = 8,
    }, testUnexpectedUnsafeText));
}

test "arg safety rejects invalid vector shape before scanning argument text" {
    try std.testing.expect(!isSafeArgVector(&.{}, .{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = 8,
        .allow_empty_vector = false,
    }, testUnexpectedUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"run"}, .{
        .max_count = 0,
        .max_arg_bytes = 4,
        .max_total_bytes = 8,
    }, testUnexpectedUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{ "one", "two", "three", "four" }, .{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = 16,
    }, testUnexpectedUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{""}, .{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = 8,
    }, testUnexpectedUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{"abcde"}, .{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = 8,
    }, testUnexpectedUnsafeText));
}

test "arg safety rejects total byte overflow before scanning the overflowing argument" {
    test_counted_unsafe_text_calls = 0;

    try std.testing.expect(!isSafeArgVector(&.{ "abcd", "efgh", "i" }, .{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = 8,
    }, testCountedNoUnsafeText));
    try std.testing.expectEqual(@as(usize, 2), test_counted_unsafe_text_calls);
}

test "arg safety rejects empty vectors and empty arguments when required" {
    const policy = ArgVectorPolicy{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = 8,
        .allow_empty_vector = false,
    };

    try std.testing.expect(!isSafeArgVector(&.{}, policy, testHasUnsafeText));
    try std.testing.expect(!isSafeArgVector(&.{""}, policy, testHasUnsafeText));
    try std.testing.expect(isSafeArgVector(&.{"run"}, policy, testHasUnsafeText));

    const permissive_arg_policy = ArgVectorPolicy{
        .max_count = 3,
        .max_arg_bytes = 4,
        .max_total_bytes = 8,
        .allow_empty_vector = false,
        .allow_empty_args = true,
    };

    try std.testing.expect(isSafeArgVector(&.{""}, permissive_arg_policy, testHasUnsafeText));
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
