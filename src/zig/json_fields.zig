const std = @import("std");

const json_safety = @import("json_safety");

pub const JsonValue = std.json.Value;
pub const JsonObject = std.json.ObjectMap;
pub const max_safe_json_integer: u64 = json_safety.max_safe_json_integer;
pub const max_supported_json_bytes: usize = 64 * 1024 * 1024;
pub const max_supported_json_value_bytes: usize = 1024 * 1024;
pub const max_supported_json_array_items: usize = 4096;

pub const ParseLimits = struct {
    max_bytes: usize,
    max_value_bytes: usize,

    fn normalized(self: ParseLimits) ?ValidatedParseLimits {
        if (self.max_bytes == 0 or self.max_bytes > max_supported_json_bytes) return null;
        if (self.max_value_bytes == 0 or self.max_value_bytes > max_supported_json_value_bytes) return null;
        if (self.max_value_bytes > self.max_bytes) return null;

        return .{
            .max_bytes = self.max_bytes,
            .max_value_bytes = self.max_value_bytes,
        };
    }
};

const ValidatedParseLimits = struct {
    max_bytes: usize,
    max_value_bytes: usize,

    fn acceptsPayload(self: ValidatedParseLimits, json_bytes: []const u8) bool {
        return json_bytes.len <= self.max_bytes;
    }
};

const empty_json_values = [_]JsonValue{};

pub fn emptyValues() []const JsonValue {
    return empty_json_values[0..];
}

pub fn parseBoundedValue(
    allocator: std.mem.Allocator,
    json_bytes: []const u8,
    limits: ParseLimits,
) !std.json.Parsed(JsonValue) {
    const safe_limits = limits.normalized() orelse return error.InvalidJsonParseLimits;
    if (!safe_limits.acceptsPayload(json_bytes)) return error.JsonTooLarge;
    return std.json.parseFromSlice(JsonValue, allocator, json_bytes, .{
        .max_value_len = safe_limits.max_value_bytes,
    });
}

pub fn objectValue(value: JsonValue) ?JsonObject {
    return switch (value) {
        .object => |object| object,
        else => null,
    };
}

pub fn arrayField(object: JsonObject, field_name: []const u8) ?[]const JsonValue {
    const value = object.get(field_name) orelse return null;
    return switch (value) {
        .array => |array| array.items,
        else => null,
    };
}

pub fn boundedArrayField(object: JsonObject, field_name: []const u8, max_items: usize) ?[]const JsonValue {
    const items = arrayField(object, field_name) orelse return null;
    const item_limit = normalizeArrayItemLimit(max_items);
    return items[0..@min(items.len, item_limit)];
}

pub fn boundedArrayFieldOrEmpty(object: JsonObject, field_name: []const u8, max_items: usize) []const JsonValue {
    return boundedArrayField(object, field_name, max_items) orelse emptyValues();
}

pub fn objectField(object: JsonObject, field_name: []const u8) ?JsonObject {
    const value = object.get(field_name) orelse return null;
    return objectValue(value);
}

pub fn safePositiveIntegerField(object: JsonObject, field_name: []const u8) u64 {
    const value = object.get(field_name) orelse return 0;
    return json_safety.safePositiveIntegerValue(value);
}

pub fn boundedPositiveIntegerField(object: JsonObject, field_name: []const u8, max_value: u64) u64 {
    const value = safePositiveIntegerField(object, field_name);
    return if (value <= max_value) value else 0;
}

pub fn safeTextField(
    object: JsonObject,
    field_name: []const u8,
    fallback: []const u8,
    max_len: usize,
    comptime isSafeText: fn ([]const u8, usize) bool,
) []const u8 {
    const value = object.get(field_name) orelse return fallback;
    return safeTextValue(value, max_len, isSafeText) orelse fallback;
}

pub fn optionalSafeTextField(
    object: JsonObject,
    field_name: []const u8,
    max_len: usize,
    comptime isSafeText: fn ([]const u8, usize) bool,
) ?[]const u8 {
    const value = object.get(field_name) orelse return null;
    return safeTextValue(value, max_len, isSafeText);
}

pub fn safeTextValue(
    value: JsonValue,
    max_len: usize,
    comptime isSafeText: fn ([]const u8, usize) bool,
) ?[]const u8 {
    return json_safety.safeTextValue(value, max_len, isSafeText);
}

fn normalizeArrayItemLimit(max_items: usize) usize {
    return @min(max_items, max_supported_json_array_items);
}

test "json fields expose typed values and bounded arrays" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "items": [1, 2, 3],
        \\  "child": {"name": "nullbuilder"},
        \\  "name": "not-array"
        \\}
    , .{});
    defer parsed.deinit();
    const object = objectValue(parsed.value).?;

    try std.testing.expectEqual(@as(usize, 0), emptyValues().len);
    try std.testing.expect(objectValue(parsed.value) != null);
    try std.testing.expectEqual(null, objectValue(parsed.value.object.get("items").?));
    try std.testing.expectEqual(@as(usize, 3), arrayField(object, "items").?.len);
    try std.testing.expectEqual(@as(usize, 2), boundedArrayField(object, "items", 2).?.len);
    try std.testing.expectEqual(@as(usize, 0), boundedArrayField(object, "items", 0).?.len);
    try std.testing.expectEqual(@as(usize, 0), boundedArrayFieldOrEmpty(object, "missing", 2).len);
    try std.testing.expect(objectField(object, "child") != null);
    try std.testing.expectEqual(null, objectField(object, "items"));
}

test "json fields cap array limits to a supported shared maximum" {
    var json: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer json.deinit();

    try json.writer.writeAll("{\"items\":[");
    for (0..max_supported_json_array_items + 1) |index| {
        if (index > 0) try json.writer.writeByte(',');
        try json.writer.writeByte('0');
    }
    try json.writer.writeAll("]}");

    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator, json.writer.buffered(), .{});
    defer parsed.deinit();
    const object = objectValue(parsed.value).?;

    try std.testing.expectEqual(max_supported_json_array_items, boundedArrayField(object, "items", std.math.maxInt(usize)).?.len);
    try std.testing.expectEqual(max_supported_json_array_items, boundedArrayFieldOrEmpty(object, "items", std.math.maxInt(usize)).len);
}

test "json fields parse helper bounds payloads and scalar values" {
    var parsed = try parseBoundedValue(std.testing.allocator, "{\"name\":\"ok\"}", .{
        .max_bytes = 64,
        .max_value_bytes = 16,
    });
    defer parsed.deinit();

    try std.testing.expect(objectValue(parsed.value) != null);
    try std.testing.expectError(error.JsonTooLarge, parseBoundedValue(std.testing.allocator, "{}", .{
        .max_bytes = 1,
        .max_value_bytes = 1,
    }));
    try std.testing.expectError(error.JsonTooLarge, parseBoundedValue(std.testing.allocator, "not-json", .{
        .max_bytes = 1,
        .max_value_bytes = 1,
    }));

    try std.testing.expectError(error.ValueTooLong, parseBoundedValue(std.testing.allocator, "{\"name\":\"toolong\"}", .{
        .max_bytes = 64,
        .max_value_bytes = 4,
    }));
}

test "json fields reject unsafe parse limit policies before parsing" {
    try std.testing.expectError(error.InvalidJsonParseLimits, parseBoundedValue(std.testing.allocator, "not-json", .{
        .max_bytes = 0,
        .max_value_bytes = 1,
    }));
    try std.testing.expectError(error.InvalidJsonParseLimits, parseBoundedValue(std.testing.allocator, "not-json", .{
        .max_bytes = 64,
        .max_value_bytes = 0,
    }));
    try std.testing.expectError(error.InvalidJsonParseLimits, parseBoundedValue(std.testing.allocator, "not-json", .{
        .max_bytes = 16,
        .max_value_bytes = 17,
    }));
    try std.testing.expectError(error.InvalidJsonParseLimits, parseBoundedValue(std.testing.allocator, "not-json", .{
        .max_bytes = max_supported_json_bytes + 1,
        .max_value_bytes = 1,
    }));
    try std.testing.expectError(error.InvalidJsonParseLimits, parseBoundedValue(std.testing.allocator, "not-json", .{
        .max_bytes = max_supported_json_bytes,
        .max_value_bytes = max_supported_json_value_bytes + 1,
    }));
    try std.testing.expectError(error.InvalidJsonParseLimits, parseBoundedValue(std.testing.allocator, "not-json", .{
        .max_bytes = std.math.maxInt(usize),
        .max_value_bytes = std.math.maxInt(usize),
    }));
}

test "json fields validate safe integer domains and caller text policy" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "valid": 42,
        \\  "tooLarge": 1000,
        \\  "unsafe": 9007199254740992,
        \\  "negative": -1,
        \\  "safe": "repo-\u043f\u0440\u0438\u0432\u0435\u0442",
        \\  "empty": "",
        \\  "control": "repo\u001b[31m"
        \\}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqual(@as(u64, 42), safePositiveIntegerField(object, "valid"));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerField(object, "unsafe"));
    try std.testing.expectEqual(@as(u64, 0), safePositiveIntegerField(object, "negative"));
    try std.testing.expectEqual(@as(u64, 42), boundedPositiveIntegerField(object, "valid", 999));
    try std.testing.expectEqual(@as(u64, 0), boundedPositiveIntegerField(object, "tooLarge", 999));

    try std.testing.expectEqualStrings(
        "repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82",
        safeTextField(object, "safe", "fallback", 64, json_safety.isNonEmptyTextWithoutControl),
    );
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "safe", "fallback", 4, json_safety.isNonEmptyTextWithoutControl));
    try std.testing.expectEqualStrings("fallback", safeTextField(object, "empty", "fallback", 64, json_safety.isNonEmptyTextWithoutControl));
    try std.testing.expectEqual(null, optionalSafeTextField(object, "control", 64, json_safety.isNonEmptyTextWithoutControl));
}
