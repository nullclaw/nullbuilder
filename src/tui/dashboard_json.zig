const std = @import("std");

pub const JsonValue = std.json.Value;
pub const JsonObject = std.json.ObjectMap;

pub fn arrayField(object: JsonObject, field_name: []const u8) ?[]const JsonValue {
    const value = object.get(field_name) orelse return null;
    return switch (value) {
        .array => |array| array.items,
        else => null,
    };
}

pub fn objectField(object: JsonObject, field_name: []const u8) ?JsonObject {
    const value = object.get(field_name) orelse return null;
    return switch (value) {
        .object => |child| child,
        else => null,
    };
}

pub fn stringField(object: JsonObject, field_name: []const u8, fallback: []const u8) []const u8 {
    const value = object.get(field_name) orelse return fallback;
    return switch (value) {
        .string => |string| string,
        .null => fallback,
        else => fallback,
    };
}

pub fn intField(object: JsonObject, field_name: []const u8) u64 {
    const value = object.get(field_name) orelse return 0;
    return switch (value) {
        .integer => |integer| if (integer > 0) std.math.cast(u64, integer) orelse 0 else 0,
        .float => |float| positiveFloatToU64(float) orelse 0,
        .null => 0,
        else => 0,
    };
}

fn positiveFloatToU64(value: f64) ?u64 {
    const max_u64_float: f64 = @floatFromInt(std.math.maxInt(u64));
    if (!std.math.isFinite(value) or value <= 0 or value >= max_u64_float) {
        return null;
    }

    return @intFromFloat(value);
}

test "field helpers return typed values and fallbacks" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [1, 2],
        \\  "owner": {"login": "nullclaw"},
        \\  "name": "nullbuilder",
        \\  "empty": null
        \\}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(@as(usize, 2), arrayField(object, "items").?.len);
    try std.testing.expect(objectField(object, "owner") != null);
    try std.testing.expectEqualStrings("nullbuilder", stringField(object, "name", "fallback"));
    try std.testing.expectEqualStrings("fallback", stringField(object, "empty", "fallback"));
    try std.testing.expectEqual(null, arrayField(object, "name"));
    try std.testing.expectEqual(null, objectField(object, "items"));
}

test "intField clamps missing negative and fractional values" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"positive":42,"negative":-42,"fractional":4.8}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(@as(u64, 42), intField(object, "positive"));
    try std.testing.expectEqual(@as(u64, 0), intField(object, "negative"));
    try std.testing.expectEqual(@as(u64, 4), intField(object, "fractional"));
    try std.testing.expectEqual(@as(u64, 0), intField(object, "missing"));
}
