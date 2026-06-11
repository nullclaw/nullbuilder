const std = @import("std");

const json_fields = @import("json_fields");
const json_safety = @import("json_safety");

pub const JsonValue = json_fields.JsonValue;
pub const JsonObject = json_fields.JsonObject;
pub const ParseLimits = json_fields.ParseLimits;
pub const ParseRequestValidation = json_fields.ParseRequestValidation;
pub const PositiveIntegerField = json_fields.PositiveIntegerField;
pub const BoundedPositiveIntegerField = json_fields.BoundedPositiveIntegerField;
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

pub fn boundedArrayFieldOrEmpty(object: JsonObject, field_name: []const u8, max_items: usize) []const JsonValue {
    return json_fields.boundedArrayFieldOrEmpty(object, field_name, max_items);
}

pub fn objectField(object: JsonObject, field_name: []const u8) ?JsonObject {
    return json_fields.objectField(object, field_name);
}

pub fn requiredSafeTextField(
    object: JsonObject,
    field_name: []const u8,
    max_len: usize,
) ?[]const u8 {
    return json_fields.optionalSafeTextField(object, field_name, max_len, json_safety.isNonEmptyTextWithoutControl);
}

pub fn boundedIntField(object: JsonObject, field_name: []const u8, max_value: u64) u64 {
    return json_fields.boundedPositiveIntegerField(object, field_name, max_value);
}

pub fn classifyBoundedIntField(
    object: JsonObject,
    field_name: []const u8,
    max_value: u64,
) BoundedPositiveIntegerField {
    return json_fields.classifyBoundedPositiveIntegerField(object, field_name, max_value);
}

pub fn safeIntegerField(object: JsonObject, field_name: []const u8) u64 {
    return boundedIntField(object, field_name, max_safe_json_integer);
}

pub fn classifySafeIntegerField(object: JsonObject, field_name: []const u8) PositiveIntegerField {
    return json_fields.classifyPositiveIntegerField(object, field_name);
}

test "field helpers return typed values" {
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
    try std.testing.expectEqual(@as(usize, 2), boundedArrayField(object, "items", 99).?.len);
    try std.testing.expect(objectField(object, "owner") != null);
    try std.testing.expectEqualStrings("nullbuilder", requiredSafeTextField(object, "name", 64).?);
    try std.testing.expectEqual(null, boundedArrayField(object, "name", 2));
    try std.testing.expectEqual(null, objectField(object, "items"));
}

test "dashboard json exposes bounded parse request classification" {
    try expectParseRequestValidation(.safe, "{\"items\":[]}", .{
        .max_bytes = 64,
        .max_value_bytes = 16,
    });
    try expectParseRequestValidation(.payload_too_large, "{}", .{
        .max_bytes = 1,
        .max_value_bytes = 1,
    });
    try expectParseRequestValidation(.zero_max_value_bytes, "not-json", .{
        .max_bytes = 64,
        .max_value_bytes = 0,
    });
    try expectParseRequestValidation(.max_value_bytes_unsupported, "not-json", .{
        .max_bytes = json_fields.max_supported_json_bytes,
        .max_value_bytes = json_fields.max_supported_json_value_bytes + 1,
    });

    try std.testing.expect(ParseRequestValidation.safe.accepts());
    try std.testing.expect(!ParseRequestValidation.zero_max_value_bytes.accepts());
}

fn expectParseRequestValidation(
    expected: ParseRequestValidation,
    json_bytes: []const u8,
    limits: ParseLimits,
) !void {
    try std.testing.expectEqual(expected, classifyParseRequest(json_bytes, limits));
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

test "requiredSafeTextField rejects oversized and control-bearing strings" {
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

    try std.testing.expectEqualStrings("repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82", requiredSafeTextField(object, "safe", 64).?);
    try std.testing.expectEqual(null, requiredSafeTextField(object, "safe", 4));
    try std.testing.expectEqual(null, requiredSafeTextField(object, "blank", 64));
    try std.testing.expectEqual(null, requiredSafeTextField(object, "newline", 64));
    try std.testing.expectEqual(null, requiredSafeTextField(object, "escape", 64));
    try std.testing.expectEqual(null, requiredSafeTextField(object, "c1", 64));
    try std.testing.expectEqual(null, requiredSafeTextField(object, "empty", 64));
    try std.testing.expectEqual(null, requiredSafeTextField(object, "missing", 64));
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

test "safeIntegerField accepts only safe positive integers" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"positive":42,"floatInteger":4.0,"negative":-42,"fractional":4.8,"unsafe":18446744073709551616.0}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(@as(u64, 42), safeIntegerField(object, "positive"));
    try std.testing.expectEqual(@as(u64, 0), safeIntegerField(object, "floatInteger"));
    try std.testing.expectEqual(@as(u64, 0), safeIntegerField(object, "negative"));
    try std.testing.expectEqual(@as(u64, 0), safeIntegerField(object, "fractional"));
    try std.testing.expectEqual(@as(u64, 0), safeIntegerField(object, "unsafe"));
    try std.testing.expectEqual(@as(u64, 0), safeIntegerField(object, "missing"));
}

test "safeIntegerField classifies missing and unsafe integer fields" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"positive":42,"zero":0,"unsafe":9007199254740992,"string":"42"}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try expectPositiveIntegerFieldSafe(42, object, "positive");
    try expectPositiveIntegerFieldTag(.missing, object, "missing");
    try expectPositiveIntegerFieldTag(.non_positive, object, "zero");
    try expectPositiveIntegerFieldTag(.unsafe_integer, object, "unsafe");
    try expectPositiveIntegerFieldTag(.non_integer, object, "string");

    try std.testing.expect((PositiveIntegerField{ .safe = 1 }).accepts());
    try std.testing.expect(!(PositiveIntegerField{ .missing = {} }).accepts());
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

test "boundedIntField classifies domain limits separately" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{"valid":999,"tooLarge":1000,"unsafe":9007199254740992,"zero":0}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try expectBoundedPositiveIntegerFieldSafe(999, object, "valid", 999);
    try expectBoundedPositiveIntegerFieldTag(.above_bound, object, "tooLarge", 999);
    try expectBoundedPositiveIntegerFieldTag(.missing, object, "missing", 999);
    try expectBoundedPositiveIntegerFieldTag(.unsafe_integer, object, "unsafe", max_safe_json_integer + 100);
    try expectBoundedPositiveIntegerFieldTag(.non_positive, object, "zero", 999);

    try std.testing.expect((BoundedPositiveIntegerField{ .safe = 1 }).accepts());
    try std.testing.expect(!(BoundedPositiveIntegerField{ .above_bound = {} }).accepts());
}

fn expectPositiveIntegerFieldSafe(expected: u64, object: JsonObject, field_name: []const u8) !void {
    switch (classifySafeIntegerField(object, field_name)) {
        .safe => |actual| try std.testing.expectEqual(expected, actual),
        else => return error.ExpectedPositiveIntegerField,
    }
}

fn expectPositiveIntegerFieldTag(
    expected: std.meta.Tag(PositiveIntegerField),
    object: JsonObject,
    field_name: []const u8,
) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifySafeIntegerField(object, field_name)));
}

fn expectBoundedPositiveIntegerFieldSafe(
    expected: u64,
    object: JsonObject,
    field_name: []const u8,
    max_value: u64,
) !void {
    switch (classifyBoundedIntField(object, field_name, max_value)) {
        .safe => |actual| try std.testing.expectEqual(expected, actual),
        else => return error.ExpectedBoundedPositiveIntegerField,
    }
}

fn expectBoundedPositiveIntegerFieldTag(
    expected: std.meta.Tag(BoundedPositiveIntegerField),
    object: JsonObject,
    field_name: []const u8,
    max_value: u64,
) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyBoundedIntField(object, field_name, max_value)));
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
