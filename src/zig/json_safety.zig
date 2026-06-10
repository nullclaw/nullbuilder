const std = @import("std");

pub const max_safe_json_integer: u64 = 9_007_199_254_740_991;

pub fn safePositiveIntegerValue(value: std.json.Value) u64 {
    return switch (value) {
        .integer => |integer| safePositiveInteger(integer),
        else => 0,
    };
}

pub fn boundedPositiveIntegerValue(value: std.json.Value, max_value: u64) u64 {
    const safe_value = safePositiveIntegerValue(value);
    return if (safe_value <= max_value) safe_value else 0;
}

fn safePositiveInteger(integer: i64) u64 {
    if (integer <= 0) return 0;
    const unsigned = std.math.cast(u64, integer) orelse return 0;
    return if (unsigned <= max_safe_json_integer) unsigned else 0;
}

test "json safety accepts only positive integers in the producer safe domain" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"valid":9007199254740991,"zero":0,"negative":-1,"unsafe":9007199254740992,"float":4.0,"string":"42"}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(max_safe_json_integer, safePositiveIntegerValue(object.get("valid").?));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerValue(object.get("zero").?));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerValue(object.get("negative").?));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerValue(object.get("unsafe").?));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerValue(object.get("float").?));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerValue(object.get("string").?));
}

test "json safety applies domain bounds after safe integer validation" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"valid":999,"tooLarge":1000,"unsafe":9007199254740992}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(@as(u64, 999), boundedPositiveIntegerValue(object.get("valid").?, 999));
    try std.testing.expectEqual(@as(u64, 0), boundedPositiveIntegerValue(object.get("tooLarge").?, 999));
    try std.testing.expectEqual(@as(u64, 0), boundedPositiveIntegerValue(object.get("unsafe").?, max_safe_json_integer + 100));
}
