const std = @import("std");

pub const ascii_escape: u8 = 0x1b;

pub const SanitizeOptions = struct {
    preserve_newlines: bool = false,
};

const SanitizedSegment = union(enum) {
    keep: usize,
    replace: usize,
    skip: usize,
};

pub const NonEmptyTextValidation = union(enum) {
    safe,
    empty,
    oversized,
    sanitizable_content: usize,

    pub fn accepts(self: NonEmptyTextValidation) bool {
        return switch (self) {
            .safe => true,
            else => false,
        };
    }
};

pub fn hasControl(value: []const u8) bool {
    return firstSanitizableIndex(value, .{}) != null;
}

pub fn isNonEmptyTextWithoutControl(value: []const u8, max_len: usize) bool {
    return classifyNonEmptyTextWithoutControl(value, max_len).accepts();
}

pub fn classifyNonEmptyTextWithoutControl(value: []const u8, max_len: usize) NonEmptyTextValidation {
    if (value.len == 0) return .empty;
    if (value.len > max_len) return .oversized;
    if (firstSanitizableIndex(value, .{})) |index| return .{ .sanitizable_content = index };
    return .safe;
}

pub fn firstSanitizableIndex(value: []const u8, options: SanitizeOptions) ?usize {
    var index: usize = 0;
    while (index < value.len) {
        switch (nextSanitizedSegment(value, index, options)) {
            .keep => |sequence_len| index += sequence_len,
            .replace, .skip => return index,
        }
    }

    return null;
}

pub fn nextSanitizedSlice(
    value: []const u8,
    index: *usize,
    options: SanitizeOptions,
    buffer: *[4]u8,
) ?[]const u8 {
    if (index.* >= value.len) return null;

    const start = index.*;
    switch (nextSanitizedSegment(value, start, options)) {
        .keep => |sequence_len| {
            index.* = keepRunEnd(value, start + sequence_len, options);
            return value[start..index.*];
        },
        .replace => |sequence_len| {
            index.* += sequence_len;
            buffer[0] = ' ';
            return buffer[0..1];
        },
        .skip => |sequence_len| {
            index.* += sequence_len;
            return null;
        },
    }
}

fn keepRunEnd(value: []const u8, start: usize, options: SanitizeOptions) usize {
    var index = start;
    while (index < value.len) {
        switch (nextSanitizedSegment(value, index, options)) {
            .keep => |sequence_len| index += sequence_len,
            .replace, .skip => return index,
        }
    }

    return index;
}

fn nextSanitizedSegment(value: []const u8, index: usize, options: SanitizeOptions) SanitizedSegment {
    const byte = value[index];
    if (byte == ascii_escape) {
        return .{ .skip = skipAnsiEscape(value, index) - index };
    }

    if (isRawAnsiControlSequence(byte)) {
        return .{ .skip = skipAnsiControlSequence(value, index + 1) - index };
    }

    if (isUtf8AnsiControlSequence(value, index)) {
        return .{ .skip = skipAnsiControlSequence(value, index + 2) - index };
    }

    if (isRawAnsiStringControl(byte)) {
        return .{ .skip = skipAnsiStringControl(value, index + 1) - index };
    }

    if (isUtf8AnsiStringControl(value, index)) {
        return .{ .skip = skipAnsiStringControl(value, index + 2) - index };
    }

    if (isUtf8C1Control(value, index)) {
        return .{ .replace = 2 };
    }

    if (utf8BidiControlSequenceLength(value, index)) |sequence_len| {
        return .{ .replace = sequence_len };
    }

    if (isSanitizableControlByte(byte, options)) {
        return .{ .replace = 1 };
    }

    if (isInvalidUtf8SequenceStart(value, index)) {
        return .{ .replace = 1 };
    }

    return .{ .keep = utf8SequenceLength(value, index) };
}

pub fn sanitizeIntoBuffer(value: []const u8, buffer: []u8, options: SanitizeOptions) []const u8 {
    var written: usize = 0;
    var index: usize = 0;
    var slice_buffer: [4]u8 = undefined;

    while (index < value.len) {
        const slice = nextSanitizedSlice(value, &index, options, &slice_buffer) orelse continue;
        if (slice.len > buffer.len - written) {
            const prefix = clipUtf8(slice, buffer.len - written);
            @memcpy(buffer[written..][0..prefix.len], prefix);
            written += prefix.len;
            break;
        }

        @memcpy(buffer[written..][0..slice.len], slice);
        written += slice.len;
    }

    return buffer[0..written];
}

pub fn clipUtf8(value: []const u8, max_len: usize) []const u8 {
    if (max_len == 0) return "";

    const limit = @min(value.len, max_len);
    var end: usize = 0;
    while (end < limit) {
        const sequence_len = utf8SequenceLength(value, end);
        if (sequence_len == 1 and value[end] >= 0x80) break;
        if (sequence_len > limit - end) break;
        end += sequence_len;
    }

    return value[0..end];
}

pub fn isControlByte(byte: u8) bool {
    return byte < 0x20 or (byte >= 0x7f and byte <= 0x9f);
}

pub fn isAsciiControlOrSpace(byte: u8) bool {
    return byte <= ' ' or byte == 0x7f;
}

pub fn eqlAsciiIgnoreCase(left: []const u8, right: []const u8) bool {
    if (left.len != right.len) return false;

    for (left, right) |left_byte, right_byte| {
        if (std.ascii.toLower(left_byte) != std.ascii.toLower(right_byte)) return false;
    }

    return true;
}

pub fn endsWithAsciiIgnoreCase(value: []const u8, suffix: []const u8) bool {
    if (value.len < suffix.len) return false;

    return eqlAsciiIgnoreCase(value[value.len - suffix.len ..], suffix);
}

pub fn isUtf8C1Control(value: []const u8, index: usize) bool {
    return value[index] == 0xc2 and index + 1 < value.len and value[index + 1] >= 0x80 and value[index + 1] <= 0x9f;
}

pub fn utf8BidiControlSequenceLength(value: []const u8, index: usize) ?usize {
    if (index + 1 < value.len and value[index] == 0xd8 and value[index + 1] == 0x9c) return 2;
    if (index + 2 >= value.len or value[index] != 0xe2) return null;

    if (value[index + 1] == 0x80) {
        const marker = value[index + 2];
        if (marker == 0x8e or marker == 0x8f or (marker >= 0xaa and marker <= 0xae)) return 3;
    }
    if (value[index + 1] == 0x81) {
        const marker = value[index + 2];
        if (marker >= 0xa6 and marker <= 0xa9) return 3;
    }

    return null;
}

pub fn utf8SequenceLength(value: []const u8, index: usize) usize {
    const byte = value[index];
    if (byte < 0x80) return 1;

    const expected_len: usize = if (byte >= 0xc2 and byte <= 0xdf)
        2
    else if (byte >= 0xe0 and byte <= 0xef)
        3
    else if (byte >= 0xf0 and byte <= 0xf4)
        4
    else
        return 1;

    if (index + expected_len > value.len) return 1;
    for (value[index + 1 .. index + expected_len]) |continuation| {
        if (!isUtf8ContinuationByte(continuation)) return 1;
    }
    if (!hasValidUtf8ScalarRange(value[index..][0..expected_len])) return 1;
    return expected_len;
}

pub fn isUtf8ContinuationByte(byte: u8) bool {
    return byte & 0b1100_0000 == 0b1000_0000;
}

pub fn isInvalidUtf8SequenceStart(value: []const u8, index: usize) bool {
    return value[index] >= 0x80 and utf8SequenceLength(value, index) == 1;
}

pub fn isAnsiStringControlIntroducer(byte: u8) bool {
    return byte == ']' or byte == 'P' or byte == 'X' or byte == '^' or byte == '_';
}

pub fn isRawAnsiControlSequence(byte: u8) bool {
    return byte == 0x9b;
}

pub fn isUtf8AnsiControlSequence(value: []const u8, index: usize) bool {
    return value[index] == 0xc2 and index + 1 < value.len and value[index + 1] == 0x9b;
}

pub fn isRawAnsiStringControl(byte: u8) bool {
    return byte == 0x90 or byte == 0x98 or byte == 0x9d or byte == 0x9e or byte == 0x9f;
}

pub fn isUtf8AnsiStringControl(value: []const u8, index: usize) bool {
    return value[index] == 0xc2 and index + 1 < value.len and isRawAnsiStringControl(value[index + 1]);
}

pub fn skipAnsiStringControl(value: []const u8, start: usize) usize {
    var index = start;
    while (index < value.len) {
        if (value[index] == 0x07) return index + 1;
        if (value[index] == 0x9c) return index + 1;
        if (value[index] == 0xc2 and index + 1 < value.len and value[index + 1] == 0x9c) return index + 2;
        if (value[index] == ascii_escape and index + 1 < value.len and value[index + 1] == '\\') return index + 2;
        index += 1;
    }
    return index;
}

pub fn skipAnsiControlSequence(value: []const u8, start: usize) usize {
    var index = start;
    while (index < value.len) {
        const byte = value[index];
        index += 1;
        if (byte >= 0x40 and byte <= 0x7e) return index;
    }
    return index;
}

pub fn skipAnsiEscape(value: []const u8, start: usize) usize {
    const index = start + 1;
    if (index >= value.len) return index;

    const introducer = value[index];
    if (introducer == '[') {
        return skipAnsiControlSequence(value, index + 1);
    }

    if (isAnsiStringControlIntroducer(introducer)) {
        return skipAnsiStringControl(value, index + 1);
    }

    return index + 1;
}

fn hasValidUtf8ScalarRange(sequence: []const u8) bool {
    return switch (sequence.len) {
        2 => true,
        3 => switch (sequence[0]) {
            0xe0 => sequence[1] >= 0xa0,
            0xed => sequence[1] <= 0x9f,
            else => true,
        },
        4 => switch (sequence[0]) {
            0xf0 => sequence[1] >= 0x90,
            0xf4 => sequence[1] <= 0x8f,
            else => true,
        },
        else => false,
    };
}

fn isSanitizableControlByte(byte: u8, options: SanitizeOptions) bool {
    if (options.preserve_newlines and byte == '\n') return false;
    return isControlByte(byte);
}

test "text safety detects ASCII and UTF-8 encoded control characters" {
    try std.testing.expect(!hasControl("safe value"));
    try std.testing.expect(!hasControl("repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb5\xd1\x82-\xf0\x9f\x99\x82"));

    try std.testing.expect(hasControl("line\nbreak"));
    try std.testing.expect(hasControl("escape\x1b[31m"));
    try std.testing.expect(hasControl("raw\x85control"));
    try std.testing.expect(hasControl("c1\xc2\x85control"));
    try std.testing.expect(hasControl("overlong\xc0\x85control"));
    try std.testing.expect(hasControl("truncated\xe2\x82"));
    try std.testing.expect(hasControl("surrogate\xed\xa0\x80"));
    try std.testing.expect(hasControl("too-large\xf4\x90\x80\x80"));
    try std.testing.expect(hasControl("bidi\xe2\x80\xaecontrol"));
    try std.testing.expect(hasControl("bidi\xe2\x81\xa6control"));
    try std.testing.expect(hasControl("bidi\xd8\x9ccontrol"));
}

test "text safety validates bounded non-empty text without controls" {
    try std.testing.expect(isNonEmptyTextWithoutControl("safe", 4));
    try std.testing.expect(isNonEmptyTextWithoutControl("repo-\xd0\xbf\xd1\x83\xd1\x82\xd1\x8c", 64));

    try std.testing.expect(!isNonEmptyTextWithoutControl("", 64));
    try std.testing.expect(!isNonEmptyTextWithoutControl("too-long", 3));
    try std.testing.expect(!isNonEmptyTextWithoutControl("line\nbreak", 64));
    try std.testing.expect(!isNonEmptyTextWithoutControl("escape\x1b[31m", 64));
}

test "text safety classifies bounded non-empty text without controls" {
    try expectNonEmptyTextValidation(.safe, "safe", 4);
    try expectNonEmptyTextValidation(.empty, "", 64);
    try expectNonEmptyTextValidation(.oversized, "too-long", 3);

    switch (classifyNonEmptyTextWithoutControl("line\nbreak", 64)) {
        .sanitizable_content => |index| try std.testing.expectEqual(@as(usize, 4), index),
        else => return error.ExpectedSanitizableContent,
    }
    switch (classifyNonEmptyTextWithoutControl("escape\x1b[31m", 64)) {
        .sanitizable_content => |index| try std.testing.expectEqual(@as(usize, 6), index),
        else => return error.ExpectedSanitizableContent,
    }

    try std.testing.expect((NonEmptyTextValidation{ .safe = {} }).accepts());
    try std.testing.expect(!(NonEmptyTextValidation{ .empty = {} }).accepts());
    try std.testing.expect(!(NonEmptyTextValidation{ .sanitizable_content = 0 }).accepts());
}

fn expectNonEmptyTextValidation(
    expected: std.meta.Tag(NonEmptyTextValidation),
    value: []const u8,
    max_len: usize,
) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyNonEmptyTextWithoutControl(value, max_len)));
}

test "text safety identifies ASCII controls and spaces" {
    try std.testing.expect(isAsciiControlOrSpace(' '));
    try std.testing.expect(isAsciiControlOrSpace('\n'));
    try std.testing.expect(isAsciiControlOrSpace(0x7f));
    try std.testing.expect(!isAsciiControlOrSpace('a'));
}

test "text safety counts only complete UTF-8 sequences" {
    const text = "repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb5\xd1\x82";

    try std.testing.expectEqual(@as(usize, 1), utf8SequenceLength(text, 0));
    try std.testing.expectEqual(@as(usize, 2), utf8SequenceLength(text, 5));
    try std.testing.expectEqual(@as(usize, 1), utf8SequenceLength(text[0..6], 5));
    try std.testing.expect(isUtf8ContinuationByte(text[6]));

    try std.testing.expectEqual(@as(usize, 1), utf8SequenceLength("\xc0\x85", 0));
    try std.testing.expectEqual(@as(usize, 1), utf8SequenceLength("\xe2\x82", 0));
    try std.testing.expectEqual(@as(usize, 1), utf8SequenceLength("\xed\xa0\x80", 0));
    try std.testing.expectEqual(@as(usize, 1), utf8SequenceLength("\xf4\x90\x80\x80", 0));
    try std.testing.expect(isInvalidUtf8SequenceStart("\xc0\x85", 0));
}

test "text safety compares ASCII text without case sensitivity" {
    try std.testing.expect(eqlAsciiIgnoreCase("localhost", "LOCALHOST"));
    try std.testing.expect(eqlAsciiIgnoreCase("Com1", "com1"));
    try std.testing.expect(!eqlAsciiIgnoreCase("host", "hosts"));
    try std.testing.expect(!eqlAsciiIgnoreCase("local-host", "local_host"));

    try std.testing.expect(endsWithAsciiIgnoreCase("nullbuilder.GIT", ".git"));
    try std.testing.expect(endsWithAsciiIgnoreCase(".git", ".git"));
    try std.testing.expect(!endsWithAsciiIgnoreCase("git", ".git"));
    try std.testing.expect(!endsWithAsciiIgnoreCase("nullbuilder.zip", ".git"));
}

test "text safety identifies ANSI string control boundaries" {
    try std.testing.expect(isAnsiStringControlIntroducer(']'));
    try std.testing.expect(isAnsiStringControlIntroducer('P'));
    try std.testing.expect(isAnsiStringControlIntroducer('X'));
    try std.testing.expect(isAnsiStringControlIntroducer('^'));
    try std.testing.expect(isAnsiStringControlIntroducer('_'));
    try std.testing.expect(!isAnsiStringControlIntroducer('['));

    try std.testing.expect(isRawAnsiStringControl(0x90));
    try std.testing.expect(isRawAnsiStringControl(0x98));
    try std.testing.expect(isRawAnsiStringControl(0x9d));
    try std.testing.expect(isRawAnsiStringControl(0x9e));
    try std.testing.expect(isRawAnsiStringControl(0x9f));
    try std.testing.expect(!isRawAnsiStringControl(0x85));
    try std.testing.expect(isUtf8AnsiStringControl("\xc2\x90private", 0));
    try std.testing.expect(isUtf8AnsiStringControl("\xc2\x98private", 0));
    try std.testing.expect(isUtf8AnsiStringControl("\xc2\x9dprivate", 0));
    try std.testing.expect(isUtf8AnsiStringControl("\xc2\x9eprivate", 0));
    try std.testing.expect(isUtf8AnsiStringControl("\xc2\x9fprivate", 0));
    try std.testing.expect(!isUtf8AnsiStringControl("\xc2\x85", 0));
    try std.testing.expect(isRawAnsiControlSequence(0x9b));
    try std.testing.expect(!isRawAnsiControlSequence(0x9d));
    try std.testing.expect(isUtf8AnsiControlSequence("\xc2\x9b31m", 0));
    try std.testing.expect(!isUtf8AnsiControlSequence("\xc2\x85", 0));

    try std.testing.expectEqual(@as(usize, 4), skipAnsiStringControl("abc\x07tail", 0));
    try std.testing.expectEqual(@as(usize, 4), skipAnsiStringControl("abc\x9ctail", 0));
    try std.testing.expectEqual(@as(usize, 5), skipAnsiStringControl("abc\xc2\x9ctail", 0));
    try std.testing.expectEqual(@as(usize, 5), skipAnsiStringControl("abc\x1b\\tail", 0));
    try std.testing.expectEqual(@as(usize, 3), skipAnsiStringControl("abc", 0));
    try std.testing.expectEqual(@as(usize, 3), skipAnsiControlSequence("31mred", 0));
    try std.testing.expectEqual(@as(usize, 2), skipAnsiControlSequence("31", 0));
}

test "text safety skips ANSI escape sequences" {
    try std.testing.expectEqual(@as(usize, 5), skipAnsiEscape("\x1b[31mred", 0));
    try std.testing.expectEqual(@as(usize, 10), skipAnsiEscape("\x1b]0;title\x07done", 0));
    try std.testing.expectEqual(@as(usize, 15), skipAnsiEscape("\x1bPprivate-dcs\x1b\\done", 0));
    try std.testing.expectEqual(@as(usize, 1), skipAnsiEscape("\x1b", 0));
    try std.testing.expectEqual(@as(usize, 2), skipAnsiEscape("\x1bc", 0));
    try std.testing.expectEqual(@as(usize, 4), skipAnsiEscape("\x1b[31", 0));
}

test "text safety emits sanitized slices from one shared scanner" {
    var buffer: [4]u8 = undefined;
    var index: usize = 0;
    const value = "ok\nbad\x1b[31mred\x1b[0m\xc2\x85raw\x85done";

    try std.testing.expectEqualStrings("ok", nextSanitizedSlice(value, &index, .{}, &buffer).?);
    try std.testing.expectEqualStrings(" ", nextSanitizedSlice(value, &index, .{}, &buffer).?);
    try std.testing.expectEqualStrings("bad", nextSanitizedSlice(value, &index, .{}, &buffer).?);
    try std.testing.expect(nextSanitizedSlice(value, &index, .{}, &buffer) == null);
    try std.testing.expectEqualStrings("red", nextSanitizedSlice(value, &index, .{}, &buffer).?);
    try std.testing.expect(nextSanitizedSlice(value, &index, .{}, &buffer) == null);
    try std.testing.expectEqualStrings(" ", nextSanitizedSlice(value, &index, .{}, &buffer).?);
    try std.testing.expectEqualStrings("raw", nextSanitizedSlice(value, &index, .{}, &buffer).?);
    try std.testing.expectEqualStrings(" ", nextSanitizedSlice(value, &index, .{}, &buffer).?);
    try std.testing.expectEqualStrings("done", nextSanitizedSlice(value, &index, .{}, &buffer).?);
    try std.testing.expectEqual(value.len, index);
}

test "text safety shared scanner can preserve newlines" {
    try std.testing.expectEqual(@as(?usize, 2), firstSanitizableIndex("ok\nbad", .{}));
    try std.testing.expectEqual(@as(?usize, null), firstSanitizableIndex("ok\nbad", .{ .preserve_newlines = true }));

    var buffer: [4]u8 = undefined;
    var index: usize = 2;
    try std.testing.expectEqualStrings("\nbad", nextSanitizedSlice("ok\nbad", &index, .{ .preserve_newlines = true }, &buffer).?);
    try std.testing.expectEqual(@as(usize, 6), index);
}

test "text safety shared scanner flags skipped control sequences" {
    try std.testing.expectEqual(@as(?usize, 2), firstSanitizableIndex("ok\x1b[31mred", .{}));
    try std.testing.expectEqual(@as(?usize, 2), firstSanitizableIndex("ok\x9b31mred", .{}));
    try std.testing.expectEqual(@as(?usize, 2), firstSanitizableIndex("ok\xc2\x9b31mred", .{}));
    try std.testing.expectEqual(@as(?usize, 2), firstSanitizableIndex("ok\x1b]0;title\x07done", .{}));
    try std.testing.expectEqual(@as(?usize, 2), firstSanitizableIndex("ok\x9d0;title\x9cdone", .{}));
    try std.testing.expectEqual(@as(?usize, 2), firstSanitizableIndex("ok\xc2\x9d0;title\xc2\x9cdone", .{}));
}

test "text safety sanitizes into caller buffers without splitting UTF-8" {
    var token_buffer: [16]u8 = undefined;
    try std.testing.expectEqualStrings(
        "bad  value",
        sanitizeIntoBuffer("bad\n\x1b[31m\tvalue", &token_buffer, .{}),
    );

    const text = "repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82";
    var partial_buffer: [6]u8 = undefined;
    try std.testing.expectEqualStrings("repo-", sanitizeIntoBuffer(text, &partial_buffer, .{}));

    var complete_buffer: [7]u8 = undefined;
    try std.testing.expectEqualStrings("repo-\xd0\xbf", sanitizeIntoBuffer(text, &complete_buffer, .{}));

    var empty_buffer: [0]u8 = .{};
    try std.testing.expectEqualStrings("", sanitizeIntoBuffer("value", &empty_buffer, .{}));
}
