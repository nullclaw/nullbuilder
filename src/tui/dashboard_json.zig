const std = @import("std");

const json_safety = @import("json_safety");
const text_safety = @import("text_safety");

pub const JsonValue = std.json.Value;
pub const JsonObject = std.json.ObjectMap;
pub const max_safe_json_integer: u64 = json_safety.max_safe_json_integer;

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

pub fn boundedArrayFieldOrEmpty(object: JsonObject, field_name: []const u8, max_items: usize) []const JsonValue {
    return boundedArrayField(object, field_name, max_items) orelse emptyValues();
}

pub fn objectField(object: JsonObject, field_name: []const u8) ?JsonObject {
    const value = object.get(field_name) orelse return null;
    return switch (value) {
        .object => |child| child,
        else => null,
    };
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

pub fn requiredSafeTextField(
    object: JsonObject,
    field_name: []const u8,
    max_len: usize,
) ?[]const u8 {
    const value = object.get(field_name) orelse return null;
    return safeTextValue(value, max_len);
}

fn intField(object: JsonObject, field_name: []const u8) u64 {
    const value = object.get(field_name) orelse return 0;
    return json_safety.safePositiveIntegerValue(value);
}

pub fn boundedIntField(object: JsonObject, field_name: []const u8, max_value: u64) u64 {
    const value = intField(object, field_name);
    return if (value <= max_value) value else 0;
}

pub fn safeIntegerField(object: JsonObject, field_name: []const u8) u64 {
    return boundedIntField(object, field_name, max_safe_json_integer);
}

fn safeTextValue(value: JsonValue, max_len: usize) ?[]const u8 {
    return switch (value) {
        .string => |string| if (string.len > 0 and string.len <= max_len and !text_safety.hasControl(string)) string else null,
        else => null,
    };
}

test "field helpers return typed values and fallbacks" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [1, 2],
        \\  "owner": {"login": "nullclaw"},
        \\  "name": "nullbuilder"
        \\}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expect(objectValue(parsed.value) != null);
    try std.testing.expectEqual(null, objectValue(parsed.value.object.get("items").?));
    try std.testing.expectEqual(@as(usize, 0), emptyValues().len);
    try std.testing.expectEqual(@as(usize, 2), arrayField(object, "items").?.len);
    try std.testing.expect(objectField(object, "owner") != null);
    try std.testing.expectEqualStrings("nullbuilder", safeTextField(object, "name", "fallback", 64));
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

test "boundedArrayFieldOrEmpty returns empty slices for missing and malformed arrays" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"items":[1,2,3],"name":"nullbuilder"}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(@as(usize, 2), boundedArrayFieldOrEmpty(object, "items", 2).len);
    try std.testing.expectEqual(@as(usize, 0), boundedArrayFieldOrEmpty(object, "name", 2).len);
    try std.testing.expectEqual(@as(usize, 0), boundedArrayFieldOrEmpty(object, "missing", 2).len);
}

test "safeTextField rejects oversized and control-bearing strings" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "safe": "repo-\u043f\u0440\u0438\u0432\u0435\u0442",
        \\  "blank": "",
        \\  "newline": "repo\nname",
        \\  "escape": "repo\u001b[31m",
        \\  "c1": "repo\u0085name",
        \\  "empty": null
        \\}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqualStrings("repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82", safeTextField(object, "safe", "fallback", 64));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "safe", "fallback", 4));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "blank", "fallback", 64));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "newline", "fallback", 64));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "escape", "fallback", 64));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "c1", "fallback", 64));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "empty", "fallback", 64));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "missing", "fallback", 64));
}

test "requiredSafeTextField rejects missing empty and unsafe strings" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "safe": "repo-\u043f\u0440\u0438\u0432\u0435\u0442",
        \\  "empty": "",
        \\  "null": null,
        \\  "oversized": "xxxxxxxxxx",
        \\  "control": "repo\u001b[31m"
        \\}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqualStrings("repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82", requiredSafeTextField(object, "safe", 64).?);
    try std.testing.expectEqual(null, requiredSafeTextField(object, "safe", 4));
    try std.testing.expectEqual(null, requiredSafeTextField(object, "empty", 64));
    try std.testing.expectEqual(null, requiredSafeTextField(object, "null", 64));
    try std.testing.expectEqual(null, requiredSafeTextField(object, "missing", 64));
    try std.testing.expectEqual(null, requiredSafeTextField(object, "oversized", 4));
    try std.testing.expectEqual(null, requiredSafeTextField(object, "control", 64));
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
        \\{"valid":999,"tooLarge":1000,"unsafe":9007199254740992,"missing":null}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(@as(u64, 999), boundedIntField(object, "valid", 999));
    try std.testing.expectEqual(@as(u64, 0), boundedIntField(object, "tooLarge", 999));
    try std.testing.expectEqual(@as(u64, 0), boundedIntField(object, "unsafe", max_safe_json_integer + 100));
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
