const std = @import("std");

const action_values = @import("action_values");

pub const JsonValue = std.json.Value;
pub const JsonObject = std.json.ObjectMap;
pub const max_safe_json_integer: u64 = 9_007_199_254_740_991;

const empty_json_values = [_]JsonValue{};

pub fn emptyValues() []const JsonValue {
    return empty_json_values[0..];
}

pub fn objectValue(value: JsonValue) ?JsonObject {
    return switch (value) {
        .object => |object| object,
        else => null,
    };
}

fn arrayField(object: JsonObject, field_name: []const u8) ?[]const JsonValue {
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

pub fn safePositiveIntegerField(object: JsonObject, field_name: []const u8) u64 {
    const value = object.get(field_name) orelse return 0;
    return safePositiveIntegerValue(value);
}

fn safePositiveIntegerValue(value: JsonValue) u64 {
    return switch (value) {
        .integer => |integer| safePositiveJsonInteger(integer),
        else => 0,
    };
}

fn safePositiveJsonInteger(integer: i64) u64 {
    if (integer <= 0) return 0;
    const unsigned = std.math.cast(u64, integer) orelse return 0;
    return if (unsigned <= max_safe_json_integer) unsigned else 0;
}

pub fn safeTextField(
    object: JsonObject,
    field_name: []const u8,
    fallback: []const u8,
    max_len: usize,
) []const u8 {
    const value = object.get(field_name) orelse return fallback;
    return safeTextValue(value, max_len) orelse fallback;
}

pub fn optionalSafeTextField(object: JsonObject, field_name: []const u8, max_len: usize) ?[]const u8 {
    const value = object.get(field_name) orelse return null;
    return safeTextValue(value, max_len);
}

fn safeTextValue(value: JsonValue, max_len: usize) ?[]const u8 {
    return switch (value) {
        .string => |string| if (action_values.isSafeActionOutputValue(string, max_len)) string else null,
        else => null,
    };
}

test "action json exposes typed objects arrays and empty slices" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"items":[1,2],"child":{"name":"Nightly"},"name":"not-an-array"}
    , .{});
    defer parsed.deinit();
    const object = objectValue(parsed.value).?;

    try std.testing.expect(objectValue(parsed.value) != null);
    try std.testing.expectEqual(@as(usize, 2), boundedArrayField(object, "items", 5).?.len);
    try std.testing.expectEqual(@as(usize, 1), boundedArrayField(object, "items", 1).?.len);
    try std.testing.expectEqual(null, boundedArrayField(object, "name", 5));
    try std.testing.expectEqual(null, objectValue(parsed.value.object.get("items").?));
    try std.testing.expectEqual(@as(usize, 0), emptyValues().len);
}

test "action json safe integer fields match JSON safe integer domain" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"valid":9007199254740991,"zero":0,"negative":-1,"unsafe":9007199254740992,"string":"42"}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(max_safe_json_integer, safePositiveIntegerField(object, "valid"));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerField(object, "zero"));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerField(object, "negative"));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerField(object, "unsafe"));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerField(object, "string"));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerField(object, "missing"));
}

test "action json safe text fields reject empty oversized and control text" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "safe": "Nightly",
        \\  "unicode": "repo-\u043f\u0440\u0438\u0432\u0435\u0442",
        \\  "empty": "",
        \\  "newline": "Nightly\nInjected",
        \\  "escape": "Nightly\u001b[31m",
        \\  "number": 42
        \\}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqualStrings("Nightly", safeTextField(object, "safe", "fallback", 64));
    try std.testing.expectEqualStrings("repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82", safeTextField(object, "unicode", "fallback", 64));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "safe", "fallback", 4));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "empty", "fallback", 64));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "newline", "fallback", 64));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "escape", "fallback", 64));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "number", "fallback", 64));
    try std.testing.expectEqual(null, optionalSafeTextField(object, "missing", 64));
    try std.testing.expectEqual(null, optionalSafeTextField(object, "empty", 64));
    try std.testing.expectEqualStrings("Nightly", optionalSafeTextField(object, "safe", 64).?);
}
