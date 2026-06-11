const std = @import("std");

const text_safety = @import("text_safety");

pub const max_safe_json_integer: u64 = 9_007_199_254_740_991;
pub const TextValidation = text_safety.NonEmptyTextValidation;

pub const PositiveIntegerValue = union(enum) {
    safe: u64,
    non_integer,
    non_positive,
    unsafe_integer,

    pub fn accepts(self: PositiveIntegerValue) bool {
        return switch (self) {
            .safe => true,
            else => false,
        };
    }

    pub fn valueOrZero(self: PositiveIntegerValue) u64 {
        return switch (self) {
            .safe => |value| value,
            else => 0,
        };
    }
};

pub const BoundedPositiveIntegerValue = union(enum) {
    safe: u64,
    non_integer,
    non_positive,
    unsafe_integer,
    above_bound,

    pub fn accepts(self: BoundedPositiveIntegerValue) bool {
        return switch (self) {
            .safe => true,
            else => false,
        };
    }

    pub fn valueOrZero(self: BoundedPositiveIntegerValue) u64 {
        return switch (self) {
            .safe => |value| value,
            else => 0,
        };
    }
};

pub const TextValue = union(enum) {
    safe: []const u8,
    non_string,
    empty,
    oversized,
    sanitizable_content: usize,

    pub fn accepts(self: TextValue) bool {
        return switch (self) {
            .safe => true,
            else => false,
        };
    }

    pub fn valueOrNull(self: TextValue) ?[]const u8 {
        return switch (self) {
            .safe => |value| value,
            else => null,
        };
    }
};

pub fn safePositiveIntegerValue(value: std.json.Value) u64 {
    return classifyPositiveIntegerValue(value).valueOrZero();
}

pub fn boundedPositiveIntegerValue(value: std.json.Value, max_value: u64) u64 {
    return classifyBoundedPositiveIntegerValue(value, max_value).valueOrZero();
}

pub fn classifyPositiveIntegerValue(value: std.json.Value) PositiveIntegerValue {
    return switch (value) {
        .integer => |integer| classifyPositiveInteger(integer),
        else => .non_integer,
    };
}

pub fn classifyBoundedPositiveIntegerValue(value: std.json.Value, max_value: u64) BoundedPositiveIntegerValue {
    return switch (classifyPositiveIntegerValue(value)) {
        .safe => |safe_value| if (safe_value <= max_value) .{ .safe = safe_value } else .above_bound,
        .non_integer => .non_integer,
        .non_positive => .non_positive,
        .unsafe_integer => .unsafe_integer,
    };
}

pub fn safeTextValue(
    value: std.json.Value,
    max_len: usize,
    comptime isSafeText: fn ([]const u8, usize) bool,
) ?[]const u8 {
    return switch (value) {
        .string => |string| if (isSafeText(string, max_len)) string else null,
        else => null,
    };
}

pub fn classifyTextValue(
    value: std.json.Value,
    max_len: usize,
    comptime classifyText: fn ([]const u8, usize) TextValidation,
) TextValue {
    return switch (value) {
        .string => |string| textValueFromValidation(string, classifyText(string, max_len)),
        else => .non_string,
    };
}

pub fn isNonEmptyTextWithoutControl(value: []const u8, max_len: usize) bool {
    return text_safety.isNonEmptyTextWithoutControl(value, max_len);
}

pub fn classifyNonEmptyTextWithoutControl(value: []const u8, max_len: usize) TextValidation {
    return text_safety.classifyNonEmptyTextWithoutControl(value, max_len);
}

pub fn classifyNonEmptyTextValue(value: std.json.Value, max_len: usize) TextValue {
    return classifyTextValue(value, max_len, classifyNonEmptyTextWithoutControl);
}

fn classifyPositiveInteger(integer: i64) PositiveIntegerValue {
    if (integer <= 0) return .non_positive;
    const unsigned = std.math.cast(u64, integer) orelse return .unsafe_integer;
    return if (unsigned <= max_safe_json_integer) .{ .safe = unsigned } else .unsafe_integer;
}

fn textValueFromValidation(value: []const u8, validation: TextValidation) TextValue {
    return switch (validation) {
        .safe => .{ .safe = value },
        .empty => .empty,
        .oversized => .oversized,
        .sanitizable_content => |index| .{ .sanitizable_content = index },
    };
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

test "json safety classifies positive integer values" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"valid":9007199254740991,"zero":0,"negative":-1,"unsafe":9007199254740992,"float":4.0,"string":"42"}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try expectPositiveIntegerSafe(max_safe_json_integer, object.get("valid").?);
    try expectPositiveIntegerTag(.non_positive, object.get("zero").?);
    try expectPositiveIntegerTag(.non_positive, object.get("negative").?);
    try expectPositiveIntegerTag(.unsafe_integer, object.get("unsafe").?);
    try expectPositiveIntegerTag(.non_integer, object.get("float").?);
    try expectPositiveIntegerTag(.non_integer, object.get("string").?);

    try std.testing.expect((PositiveIntegerValue{ .safe = 1 }).accepts());
    try std.testing.expect(!(PositiveIntegerValue{ .non_integer = {} }).accepts());
    try std.testing.expectEqual(@as(u64, 1), (PositiveIntegerValue{ .safe = 1 }).valueOrZero());
    try std.testing.expectEqual(@as(u64, 0), (PositiveIntegerValue{ .non_positive = {} }).valueOrZero());
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

test "json safety classifies bounded positive integer values" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"valid":999,"tooLarge":1000,"unsafe":9007199254740992,"zero":0,"string":"42"}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try expectBoundedPositiveIntegerSafe(@as(u64, 999), object.get("valid").?, 999);
    try expectBoundedPositiveIntegerTag(.above_bound, object.get("tooLarge").?, 999);
    try expectBoundedPositiveIntegerTag(.unsafe_integer, object.get("unsafe").?, max_safe_json_integer + 100);
    try expectBoundedPositiveIntegerTag(.non_positive, object.get("zero").?, 999);
    try expectBoundedPositiveIntegerTag(.non_integer, object.get("string").?, 999);

    try std.testing.expect((BoundedPositiveIntegerValue{ .safe = 1 }).accepts());
    try std.testing.expect(!(BoundedPositiveIntegerValue{ .above_bound = {} }).accepts());
    try std.testing.expectEqual(@as(u64, 1), (BoundedPositiveIntegerValue{ .safe = 1 }).valueOrZero());
    try std.testing.expectEqual(@as(u64, 0), (BoundedPositiveIntegerValue{ .above_bound = {} }).valueOrZero());
}

fn expectPositiveIntegerSafe(expected: u64, value: std.json.Value) !void {
    switch (classifyPositiveIntegerValue(value)) {
        .safe => |actual| try std.testing.expectEqual(expected, actual),
        else => return error.ExpectedPositiveInteger,
    }
}

fn expectPositiveIntegerTag(expected: std.meta.Tag(PositiveIntegerValue), value: std.json.Value) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyPositiveIntegerValue(value)));
}

fn expectBoundedPositiveIntegerSafe(expected: u64, value: std.json.Value, max_value: u64) !void {
    switch (classifyBoundedPositiveIntegerValue(value, max_value)) {
        .safe => |actual| try std.testing.expectEqual(expected, actual),
        else => return error.ExpectedPositiveInteger,
    }
}

fn expectBoundedPositiveIntegerTag(
    expected: std.meta.Tag(BoundedPositiveIntegerValue),
    value: std.json.Value,
    max_value: u64,
) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyBoundedPositiveIntegerValue(value, max_value)));
}

test "json safety accepts text only through the caller validator" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"safe":"repo-\u043f\u0440\u0438\u0432\u0435\u0442","empty":"","newline":"bad\ntext","number":42}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try std.testing.expectEqualStrings("repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82", safeTextValue(
        object.get("safe").?,
        64,
        isNonEmptyTextWithoutControl,
    ).?);
    try std.testing.expectEqual(null, safeTextValue(object.get("safe").?, 4, isNonEmptyTextWithoutControl));
    try std.testing.expectEqual(null, safeTextValue(object.get("empty").?, 64, isNonEmptyTextWithoutControl));
    try std.testing.expectEqual(null, safeTextValue(object.get("newline").?, 64, isNonEmptyTextWithoutControl));
    try std.testing.expectEqual(null, safeTextValue(object.get("number").?, 64, isNonEmptyTextWithoutControl));
}

test "json safety classifies text values through the caller validator" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"safe":"repo-\u043f\u0440\u0438\u0432\u0435\u0442","empty":"","newline":"bad\ntext","number":42}
    , .{});
    defer parsed.deinit();
    const object = parsed.value.object;

    try expectTextValueSafe("repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82", object.get("safe").?, 64);
    try expectTextValueTag(.oversized, object.get("safe").?, 4);
    try expectTextValueTag(.empty, object.get("empty").?, 64);
    try expectTextValueIndex(.sanitizable_content, object.get("newline").?, 64, 3);
    try expectTextValueTag(.non_string, object.get("number").?, 64);

    try std.testing.expect((TextValue{ .safe = "ok" }).accepts());
    try std.testing.expect(!(TextValue{ .non_string = {} }).accepts());
    try std.testing.expectEqualStrings("ok", (TextValue{ .safe = "ok" }).valueOrNull().?);
    try std.testing.expectEqual(@as(?[]const u8, null), (TextValue{ .empty = {} }).valueOrNull());
}

fn expectTextValueSafe(expected: []const u8, value: std.json.Value, max_len: usize) !void {
    switch (classifyNonEmptyTextValue(value, max_len)) {
        .safe => |actual| try std.testing.expectEqualStrings(expected, actual),
        else => return error.ExpectedTextValue,
    }
}

fn expectTextValueTag(expected: std.meta.Tag(TextValue), value: std.json.Value, max_len: usize) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyNonEmptyTextValue(value, max_len)));
}

fn expectTextValueIndex(
    expected: std.meta.Tag(TextValue),
    value: std.json.Value,
    max_len: usize,
    expected_index: usize,
) !void {
    const actual = classifyNonEmptyTextValue(value, max_len);
    try std.testing.expectEqual(expected, std.meta.activeTag(actual));
    const actual_index = switch (actual) {
        .sanitizable_content => |index| index,
        else => return error.ExpectedTextValueIndex,
    };
    try std.testing.expectEqual(expected_index, actual_index);
}
