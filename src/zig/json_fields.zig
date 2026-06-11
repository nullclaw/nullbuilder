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
        if (classifyParseLimits(self) != .safe) return null;

        return .{
            .max_bytes = self.max_bytes,
            .max_value_bytes = self.max_value_bytes,
        };
    }
};

pub const ParseRequestValidation = enum {
    safe,
    zero_max_bytes,
    max_bytes_unsupported,
    zero_max_value_bytes,
    max_value_bytes_unsupported,
    value_limit_exceeds_payload_limit,
    payload_too_large,

    pub fn accepts(self: ParseRequestValidation) bool {
        return self == .safe;
    }
};

pub const PositiveIntegerField = union(enum) {
    safe: u64,
    missing,
    non_integer,
    non_positive,
    unsafe_integer,

    pub fn accepts(self: PositiveIntegerField) bool {
        return switch (self) {
            .safe => true,
            else => false,
        };
    }

    pub fn valueOrZero(self: PositiveIntegerField) u64 {
        return switch (self) {
            .safe => |value| value,
            else => 0,
        };
    }
};

pub const BoundedPositiveIntegerField = union(enum) {
    safe: u64,
    missing,
    non_integer,
    non_positive,
    unsafe_integer,
    above_bound,

    pub fn accepts(self: BoundedPositiveIntegerField) bool {
        return switch (self) {
            .safe => true,
            else => false,
        };
    }

    pub fn valueOrZero(self: BoundedPositiveIntegerField) u64 {
        return switch (self) {
            .safe => |value| value,
            else => 0,
        };
    }
};

const ValidatedParseLimits = struct {
    max_bytes: usize,
    max_value_bytes: usize,
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
    const validation = classifyParseRequest(json_bytes, limits);
    switch (validation) {
        .safe => {},
        .payload_too_large => return error.JsonTooLarge,
        else => return error.InvalidJsonParseLimits,
    }

    const safe_limits = limits.normalized().?;
    return std.json.parseFromSlice(JsonValue, allocator, json_bytes, .{
        .max_value_len = safe_limits.max_value_bytes,
    });
}

pub fn classifyParseRequest(json_bytes: []const u8, limits: ParseLimits) ParseRequestValidation {
    const limit_validation = classifyParseLimits(limits);
    if (limit_validation != .safe) return limit_validation;
    if (json_bytes.len > limits.max_bytes) return .payload_too_large;
    return .safe;
}

fn classifyParseLimits(limits: ParseLimits) ParseRequestValidation {
    if (limits.max_bytes == 0) return .zero_max_bytes;
    if (limits.max_bytes > max_supported_json_bytes) return .max_bytes_unsupported;
    if (limits.max_value_bytes == 0) return .zero_max_value_bytes;
    if (limits.max_value_bytes > max_supported_json_value_bytes) return .max_value_bytes_unsupported;
    if (limits.max_value_bytes > limits.max_bytes) return .value_limit_exceeds_payload_limit;
    return .safe;
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
    return classifyPositiveIntegerField(object, field_name).valueOrZero();
}

pub fn classifyPositiveIntegerField(object: JsonObject, field_name: []const u8) PositiveIntegerField {
    const value = object.get(field_name) orelse return .missing;
    return positiveIntegerFieldFromValue(json_safety.classifyPositiveIntegerValue(value));
}

pub fn boundedPositiveIntegerField(object: JsonObject, field_name: []const u8, max_value: u64) u64 {
    return classifyBoundedPositiveIntegerField(object, field_name, max_value).valueOrZero();
}

pub fn classifyBoundedPositiveIntegerField(
    object: JsonObject,
    field_name: []const u8,
    max_value: u64,
) BoundedPositiveIntegerField {
    const value = object.get(field_name) orelse return .missing;
    return boundedPositiveIntegerFieldFromValue(json_safety.classifyBoundedPositiveIntegerValue(value, max_value));
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

fn positiveIntegerFieldFromValue(value: json_safety.PositiveIntegerValue) PositiveIntegerField {
    return switch (value) {
        .safe => |safe_value| .{ .safe = safe_value },
        .non_integer => .non_integer,
        .non_positive => .non_positive,
        .unsafe_integer => .unsafe_integer,
    };
}

fn boundedPositiveIntegerFieldFromValue(value: json_safety.BoundedPositiveIntegerValue) BoundedPositiveIntegerField {
    return switch (value) {
        .safe => |safe_value| .{ .safe = safe_value },
        .non_integer => .non_integer,
        .non_positive => .non_positive,
        .unsafe_integer => .unsafe_integer,
        .above_bound => .above_bound,
    };
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

test "json fields classify bounded parse requests" {
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
    try expectParseRequestValidation(.max_bytes_unsupported, "not-json", .{
        .max_bytes = max_supported_json_bytes + 1,
        .max_value_bytes = 1,
    });
    try expectParseRequestValidation(.zero_max_value_bytes, "not-json", .{
        .max_bytes = 64,
        .max_value_bytes = 0,
    });
    try expectParseRequestValidation(.max_value_bytes_unsupported, "not-json", .{
        .max_bytes = max_supported_json_bytes,
        .max_value_bytes = max_supported_json_value_bytes + 1,
    });
    try expectParseRequestValidation(.value_limit_exceeds_payload_limit, "not-json", .{
        .max_bytes = 16,
        .max_value_bytes = 17,
    });

    try std.testing.expect(ParseRequestValidation.safe.accepts());
    try std.testing.expect(!ParseRequestValidation.payload_too_large.accepts());
    try std.testing.expect(!ParseRequestValidation.zero_max_bytes.accepts());
}

fn expectParseRequestValidation(
    expected: ParseRequestValidation,
    json_bytes: []const u8,
    limits: ParseLimits,
) !void {
    try std.testing.expectEqual(expected, classifyParseRequest(json_bytes, limits));
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
        optionalSafeTextField(object, "safe", 64, json_safety.isNonEmptyTextWithoutControl).?,
    );
    try std.testing.expectEqual(null, optionalSafeTextField(object, "safe", 4, json_safety.isNonEmptyTextWithoutControl));
    try std.testing.expectEqual(null, optionalSafeTextField(object, "empty", 64, json_safety.isNonEmptyTextWithoutControl));
    try std.testing.expectEqual(null, optionalSafeTextField(object, "control", 64, json_safety.isNonEmptyTextWithoutControl));
}

test "json fields classify positive integer fields" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "valid": 42,
        \\  "zero": 0,
        \\  "negative": -1,
        \\  "unsafe": 9007199254740992,
        \\  "float": 4.0,
        \\  "string": "42"
        \\}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try expectPositiveIntegerFieldSafe(42, object, "valid");
    try expectPositiveIntegerFieldTag(.missing, object, "missing");
    try expectPositiveIntegerFieldTag(.non_integer, object, "float");
    try expectPositiveIntegerFieldTag(.non_integer, object, "string");
    try expectPositiveIntegerFieldTag(.non_positive, object, "zero");
    try expectPositiveIntegerFieldTag(.non_positive, object, "negative");
    try expectPositiveIntegerFieldTag(.unsafe_integer, object, "unsafe");

    try std.testing.expect((PositiveIntegerField{ .safe = 1 }).accepts());
    try std.testing.expect(!(PositiveIntegerField{ .missing = {} }).accepts());
    try std.testing.expectEqual(@as(u64, 1), (PositiveIntegerField{ .safe = 1 }).valueOrZero());
    try std.testing.expectEqual(@as(u64, 0), (PositiveIntegerField{ .unsafe_integer = {} }).valueOrZero());
}

test "json fields classify bounded positive integer fields" {
    var parsed = try std.json.parseFromSlice(JsonValue, std.testing.allocator,
        \\{
        \\  "valid": 42,
        \\  "tooLarge": 1000,
        \\  "unsafe": 9007199254740992,
        \\  "zero": 0,
        \\  "string": "42"
        \\}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try expectBoundedPositiveIntegerFieldSafe(42, object, "valid", 999);
    try expectBoundedPositiveIntegerFieldTag(.above_bound, object, "tooLarge", 999);
    try expectBoundedPositiveIntegerFieldTag(.missing, object, "missing", 999);
    try expectBoundedPositiveIntegerFieldTag(.unsafe_integer, object, "unsafe", max_safe_json_integer + 100);
    try expectBoundedPositiveIntegerFieldTag(.non_positive, object, "zero", 999);
    try expectBoundedPositiveIntegerFieldTag(.non_integer, object, "string", 999);

    try std.testing.expect((BoundedPositiveIntegerField{ .safe = 1 }).accepts());
    try std.testing.expect(!(BoundedPositiveIntegerField{ .above_bound = {} }).accepts());
    try std.testing.expectEqual(@as(u64, 1), (BoundedPositiveIntegerField{ .safe = 1 }).valueOrZero());
    try std.testing.expectEqual(@as(u64, 0), (BoundedPositiveIntegerField{ .missing = {} }).valueOrZero());
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

fn expectBoundedPositiveIntegerFieldSafe(
    expected: u64,
    object: JsonObject,
    field_name: []const u8,
    max_value: u64,
) !void {
    switch (classifyBoundedPositiveIntegerField(object, field_name, max_value)) {
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
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyBoundedPositiveIntegerField(object, field_name, max_value)));
}
