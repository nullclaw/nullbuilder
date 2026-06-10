const std = @import("std");

pub const JsonValue = std.json.Value;
pub const JsonObject = std.json.ObjectMap;
pub const max_safe_json_integer: u64 = 9_007_199_254_740_991;

pub fn arrayField(object: JsonObject, field_name: []const u8) ?[]const JsonValue {
    const value = object.get(field_name) orelse return null;
    return switch (value) {
        .array => |array| array.items,
        else => null,
    };
}

pub fn boundedArrayField(object: JsonObject, field_name: []const u8, max_items: usize) ?[]const JsonValue {
    const items = arrayField(object, field_name) orelse return null;
    return items[0..@min(items.len, max_items)];
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

pub fn boundedStringField(
    object: JsonObject,
    field_name: []const u8,
    fallback: []const u8,
    max_len: usize,
) []const u8 {
    const value = object.get(field_name) orelse return fallback;
    return switch (value) {
        .string => |string| if (string.len <= max_len) string else fallback,
        .null => fallback,
        else => fallback,
    };
}

pub fn intField(object: JsonObject, field_name: []const u8) u64 {
    const value = object.get(field_name) orelse return 0;
    return switch (value) {
        .integer => |integer| if (integer > 0) std.math.cast(u64, integer) orelse 0 else 0,
        .null => 0,
        else => 0,
    };
}

pub fn boundedIntField(object: JsonObject, field_name: []const u8, max_value: u64) u64 {
    const value = intField(object, field_name);
    return if (value <= max_value) value else 0;
}

pub fn safeIntegerField(object: JsonObject, field_name: []const u8) u64 {
    return boundedIntField(object, field_name, max_safe_json_integer);
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

test "boundedArrayField caps external arrays" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"items":[1,2,3],"name":"nullbuilder"}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(@as(usize, 2), boundedArrayField(object, "items", 2).?.len);
    try std.testing.expectEqual(@as(usize, 3), boundedArrayField(object, "items", 4).?.len);
    try std.testing.expectEqual(@as(usize, 0), boundedArrayField(object, "items", 0).?.len);
    try std.testing.expectEqual(null, boundedArrayField(object, "name", 2));
    try std.testing.expectEqual(null, boundedArrayField(object, "missing", 2));
}

test "boundedStringField rejects oversized strings" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"short":"repo","long":"xxxxxxxxxx","empty":null}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqualStrings("repo", boundedStringField(object, "short", "fallback", 4));
    try std.testing.expectEqualStrings("fallback", boundedStringField(object, "short", "fallback", 3));
    try std.testing.expectEqualStrings("fallback", boundedStringField(object, "long", "fallback", 4));
    try std.testing.expectEqualStrings("fallback", boundedStringField(object, "empty", "fallback", 4));
    try std.testing.expectEqualStrings("fallback", boundedStringField(object, "missing", "fallback", 4));
}

test "intField accepts only safe positive integers" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"positive":42,"floatInteger":4.0,"negative":-42,"fractional":4.8,"unsafe":18446744073709551616.0}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(@as(u64, 42), intField(object, "positive"));
    try std.testing.expectEqual(@as(u64, 0), intField(object, "floatInteger"));
    try std.testing.expectEqual(@as(u64, 0), intField(object, "negative"));
    try std.testing.expectEqual(@as(u64, 0), intField(object, "fractional"));
    try std.testing.expectEqual(@as(u64, 0), intField(object, "unsafe"));
    try std.testing.expectEqual(@as(u64, 0), intField(object, "missing"));
}

test "boundedIntField rejects positive integers above a domain limit" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"valid":999,"tooLarge":1000,"missing":null}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(@as(u64, 999), boundedIntField(object, "valid", 999));
    try std.testing.expectEqual(@as(u64, 0), boundedIntField(object, "tooLarge", 999));
    try std.testing.expectEqual(@as(u64, 0), boundedIntField(object, "missing", 999));
}

test "safeIntegerField matches the JSON producer safe integer domain" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"valid":9007199254740991,"tooLarge":9007199254740992,"negative":-1}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(max_safe_json_integer, safeIntegerField(object, "valid"));
    try std.testing.expectEqual(@as(u64, 0), safeIntegerField(object, "tooLarge"));
    try std.testing.expectEqual(@as(u64, 0), safeIntegerField(object, "negative"));
}
