const std = @import("std");

const action_values = @import("action_values");
const json_fields = @import("json_fields");

pub const JsonValue = json_fields.JsonValue;
pub const JsonObject = json_fields.JsonObject;
pub const ParseLimits = json_fields.ParseLimits;
pub const ParseRequestValidation = json_fields.ParseRequestValidation;
pub const PositiveIntegerField = json_fields.PositiveIntegerField;
pub const max_safe_json_integer: u64 = json_fields.max_safe_json_integer;
pub const max_supported_json_array_items: usize = json_fields.max_supported_json_array_items;

pub fn emptyValues() []const JsonValue {
    return json_fields.emptyValues();
}

pub fn parseBoundedValue(
    allocator: std.mem.Allocator,
    json_bytes: []const u8,
    limits: ParseLimits,
) !std.json.Parsed(JsonValue) {
    return json_fields.parseBoundedValue(allocator, json_bytes, limits);
}

pub fn classifyParseRequest(json_bytes: []const u8, limits: ParseLimits) ParseRequestValidation {
    return json_fields.classifyParseRequest(json_bytes, limits);
}

pub fn objectValue(value: JsonValue) ?JsonObject {
    return json_fields.objectValue(value);
}

pub fn boundedArrayField(object: JsonObject, field_name: []const u8, max_items: usize) ?[]const JsonValue {
    return json_fields.boundedArrayField(object, field_name, max_items);
}

pub fn safePositiveIntegerField(object: JsonObject, field_name: []const u8) u64 {
    return json_fields.safePositiveIntegerField(object, field_name);
}

pub fn classifyPositiveIntegerField(object: JsonObject, field_name: []const u8) PositiveIntegerField {
    return json_fields.classifyPositiveIntegerField(object, field_name);
}

pub fn optionalSafeTextField(object: JsonObject, field_name: []const u8, max_len: usize) ?[]const u8 {
    return json_fields.optionalSafeTextField(object, field_name, max_len, action_values.isSafeActionOutputValue);
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

test "action json exposes bounded parse request classification" {
    try expectParseRequestValidation(.safe, "{\"name\":\"ok\"}", .{
        .max_bytes = 64,
        .max_value_bytes = 16,
    });
    try expectParseRequestValidation(.payload_too_large, "{}", .{
        .max_bytes = 1,
        .max_value_bytes = 1,
    });
    try expectParseRequestValidation(.zero_max_bytes, "not-json", .{
        .max_bytes = 0,
        .max_value_bytes = 1,
    });
    try expectParseRequestValidation(.value_limit_exceeds_payload_limit, "not-json", .{
        .max_bytes = 16,
        .max_value_bytes = 17,
    });

    try std.testing.expect(ParseRequestValidation.safe.accepts());
    try std.testing.expect(!ParseRequestValidation.payload_too_large.accepts());
}

fn expectParseRequestValidation(
    expected: ParseRequestValidation,
    json_bytes: []const u8,
    limits: ParseLimits,
) !void {
    try std.testing.expectEqual(expected, classifyParseRequest(json_bytes, limits));
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

test "action json classifies positive integer fields" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"valid":42,"zero":0,"unsafe":9007199254740992,"string":"42"}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try expectPositiveIntegerFieldSafe(42, object, "valid");
    try expectPositiveIntegerFieldTag(.missing, object, "missing");
    try expectPositiveIntegerFieldTag(.non_positive, object, "zero");
    try expectPositiveIntegerFieldTag(.unsafe_integer, object, "unsafe");
    try expectPositiveIntegerFieldTag(.non_integer, object, "string");

    try std.testing.expect((PositiveIntegerField{ .safe = 1 }).accepts());
    try std.testing.expect(!(PositiveIntegerField{ .missing = {} }).accepts());
}

fn expectPositiveIntegerFieldSafe(expected: u64, object: JsonObject, field_name: []const u8) !void {
    switch (classifyPositiveIntegerField(object, field_name)) {
        .safe => |actual| try std.testing.expectEqual(expected, actual),
        else => return error.ExpectedPositiveIntegerField,
    }
}

fn expectPositiveIntegerFieldTag(
    expected: std.meta.Tag(PositiveIntegerField),
    object: JsonObject,
    field_name: []const u8,
) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyPositiveIntegerField(object, field_name)));
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

    try std.testing.expectEqualStrings("Nightly", optionalSafeTextField(object, "safe", 64).?);
    try std.testing.expectEqualStrings("repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82", optionalSafeTextField(object, "unicode", 64).?);
    try std.testing.expectEqual(null, optionalSafeTextField(object, "safe", 4));
    try std.testing.expectEqual(null, optionalSafeTextField(object, "empty", 64));
    try std.testing.expectEqual(null, optionalSafeTextField(object, "newline", 64));
    try std.testing.expectEqual(null, optionalSafeTextField(object, "escape", 64));
    try std.testing.expectEqual(null, optionalSafeTextField(object, "number", 64));
    try std.testing.expectEqual(null, optionalSafeTextField(object, "missing", 64));
    try std.testing.expectEqual(null, optionalSafeTextField(object, "empty", 64));
    try std.testing.expectEqualStrings("Nightly", optionalSafeTextField(object, "safe", 64).?);
}
