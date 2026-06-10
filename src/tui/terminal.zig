const std = @import("std");

pub const ascii_escape: u8 = 0x1b;
pub const truncated_output_suffix = "\n[output truncated]\n";

pub const SanitizeOptions = struct {
    preserve_newlines: bool = false,
};

pub const SanitizedText = struct {
    value: []const u8,
    allocated: bool = false,

    pub fn deinit(self: SanitizedText, allocator: std.mem.Allocator) void {
        if (self.allocated) allocator.free(self.value);
    }
};

pub fn sanitizeMaybeAlloc(allocator: std.mem.Allocator, value: []const u8, options: SanitizeOptions) !SanitizedText {
    if (isSafe(value, options)) {
        return .{ .value = value };
    }

    return .{
        .value = try sanitizeAlloc(allocator, value, options),
        .allocated = true,
    };
}

pub fn sanitizeAlloc(allocator: std.mem.Allocator, value: []const u8, options: SanitizeOptions) ![]u8 {
    var sanitized = std.array_list.Managed(u8).init(allocator);
    errdefer sanitized.deinit();

    var index: usize = 0;
    var buffer: [4]u8 = undefined;
    while (index < value.len) {
        if (nextSanitizedSlice(value, &index, options, &buffer)) |slice| {
            try sanitized.appendSlice(slice);
        }
    }

    return sanitized.toOwnedSlice();
}

pub fn writeSafe(out: *std.Io.Writer, value: []const u8, options: SanitizeOptions) !void {
    var index: usize = 0;
    var buffer: [4]u8 = undefined;
    while (index < value.len) {
        if (nextSanitizedSlice(value, &index, options, &buffer)) |slice| {
            try out.writeAll(slice);
        }
    }
}

pub fn writeSafeBounded(out: *std.Io.Writer, value: []const u8, max_bytes: usize, options: SanitizeOptions) !bool {
    var index: usize = 0;
    var written: usize = 0;
    var buffer: [4]u8 = undefined;

    while (index < value.len) {
        if (nextSanitizedSlice(value, &index, options, &buffer)) |slice| {
            if (slice.len > max_bytes - written) {
                try out.writeAll(truncated_output_suffix);
                return true;
            }

            try out.writeAll(slice);
            written += slice.len;
        }
    }

    return false;
}

pub fn clipUtf8(value: []const u8, max_len: usize) []const u8 {
    if (value.len <= max_len) return value;
    if (max_len == 0) return "";

    var end = max_len;
    while (end > 0 and isUtf8ContinuationByte(value[end])) {
        end -= 1;
    }

    return value[0..end];
}

pub fn hasUnsafeControl(value: []const u8, options: SanitizeOptions) bool {
    var index: usize = 0;
    while (index < value.len) {
        const byte = value[index];
        if (byte == ascii_escape or isUtf8C1Control(value, index) or isUnsafeTerminalControlByte(byte, options)) {
            return true;
        }
        index += utf8SequenceLength(value, index);
    }

    return false;
}

fn isSafe(value: []const u8, options: SanitizeOptions) bool {
    return !hasUnsafeControl(value, options);
}

fn nextSanitizedSlice(value: []const u8, index: *usize, options: SanitizeOptions, buffer: *[4]u8) ?[]const u8 {
    const byte = value[index.*];
    if (byte == ascii_escape) {
        index.* = skipAnsiEscape(value, index.*);
        return null;
    }

    if (isUtf8C1Control(value, index.*)) {
        index.* += 2;
        buffer[0] = ' ';
        return buffer[0..1];
    }

    if (isUnsafeTerminalControlByte(byte, options)) {
        index.* += 1;
        buffer[0] = ' ';
        return buffer[0..1];
    }

    const start = index.*;
    const sequence_len = utf8SequenceLength(value, start);
    index.* += sequence_len;
    return value[start..index.*];
}

fn skipAnsiEscape(value: []const u8, start: usize) usize {
    var index = start + 1;
    if (index >= value.len) return index;

    const introducer = value[index];
    if (introducer == '[') {
        index += 1;
        while (index < value.len) {
            const byte = value[index];
            index += 1;
            if (byte >= 0x40 and byte <= 0x7e) return index;
        }
        return index;
    }

    if (introducer == ']') {
        index += 1;
        while (index < value.len) {
            if (value[index] == 0x07) return index + 1;
            if (value[index] == ascii_escape and index + 1 < value.len and value[index + 1] == '\\') return index + 2;
            index += 1;
        }
        return index;
    }

    return index + 1;
}

fn isUnsafeTerminalControlByte(byte: u8, options: SanitizeOptions) bool {
    if (options.preserve_newlines and byte == '\n') return false;
    return byte < 0x20 or (byte >= 0x7f and byte <= 0x9f);
}

fn isUtf8C1Control(value: []const u8, index: usize) bool {
    return value[index] == 0xc2 and index + 1 < value.len and value[index + 1] >= 0x80 and value[index + 1] <= 0x9f;
}

fn utf8SequenceLength(value: []const u8, index: usize) usize {
    const byte = value[index];
    if (byte < 0x80) return 1;

    const expected_len: usize = if (byte & 0b1110_0000 == 0b1100_0000)
        2
    else if (byte & 0b1111_0000 == 0b1110_0000)
        3
    else if (byte & 0b1111_1000 == 0b1111_0000)
        4
    else
        return 1;

    if (index + expected_len > value.len) return 1;
    for (value[index + 1 .. index + expected_len]) |continuation| {
        if (!isUtf8ContinuationByte(continuation)) return 1;
    }
    return expected_len;
}

fn isUtf8ContinuationByte(byte: u8) bool {
    return byte & 0b1100_0000 == 0b1000_0000;
}

test "terminal sanitizer strips escape sequences and controls" {
    const safe = try sanitizeAlloc(
        std.testing.allocator,
        "ok\nbad\x1b[31mred\x1b[0m\ttext\xc2\x85next\x85raw\x1b]0;title\x07done",
        .{},
    );
    defer std.testing.allocator.free(safe);

    try std.testing.expectEqualStrings("ok badred text next rawdone", safe);
    try std.testing.expect(std.mem.indexOfScalar(u8, safe, ascii_escape) == null);
}

test "terminal control detector skips safe UTF-8 sequences" {
    try std.testing.expect(!hasUnsafeControl("safe text", .{}));
    try std.testing.expect(!hasUnsafeControl("repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82-\xf0\x9f\x99\x82", .{}));

    try std.testing.expect(hasUnsafeControl("bad\nvalue", .{}));
    try std.testing.expect(!hasUnsafeControl("line\nvalue", .{ .preserve_newlines = true }));
    try std.testing.expect(hasUnsafeControl("bad\x1b[31mvalue", .{ .preserve_newlines = true }));
    try std.testing.expect(hasUnsafeControl("bad\xc2\x85value", .{}));
    try std.testing.expect(hasUnsafeControl("bad\x85value", .{}));
}

test "terminal sanitizer borrows already safe text" {
    const input = "safe text";
    const safe = try sanitizeMaybeAlloc(std.testing.allocator, input, .{});
    defer safe.deinit(std.testing.allocator);

    try std.testing.expect(!safe.allocated);
    try std.testing.expectEqual(@intFromPtr(input.ptr), @intFromPtr(safe.value.ptr));
    try std.testing.expectEqualStrings(input, safe.value);

    const unicode = "repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82-🙂";
    const safe_unicode = try sanitizeMaybeAlloc(std.testing.allocator, unicode, .{});
    defer safe_unicode.deinit(std.testing.allocator);

    try std.testing.expect(!safe_unicode.allocated);
    try std.testing.expectEqual(@intFromPtr(unicode.ptr), @intFromPtr(safe_unicode.value.ptr));
    try std.testing.expectEqualStrings(unicode, safe_unicode.value);
}

test "terminal sanitizer allocates only when text changes" {
    const safe = try sanitizeMaybeAlloc(std.testing.allocator, "bad\x1b[31mred\x1b[0m", .{});
    defer safe.deinit(std.testing.allocator);

    try std.testing.expect(safe.allocated);
    try std.testing.expectEqualStrings("badred", safe.value);
}

test "terminal sanitizer can preserve newlines for child output" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    try writeSafe(
        &out.writer,
        "ok\nbad\x1b[31mred\x1b[0m\ttext\xc2\x85next\x85raw\x1b]0;title\x07done",
        .{ .preserve_newlines = true },
    );

    try std.testing.expectEqualStrings("ok\nbadred text next rawdone", out.writer.buffered());
    try std.testing.expect(std.mem.indexOfScalar(u8, out.writer.buffered(), ascii_escape) == null);
}

test "clipUtf8 does not split multibyte sequences" {
    const text = "repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82";

    try std.testing.expectEqualStrings("repo-", clipUtf8(text, 6));
    try std.testing.expectEqualStrings("repo-\xd0\xbf", clipUtf8(text, 7));
    try std.testing.expectEqualStrings("", clipUtf8(text, 0));
}

test "bounded terminal writer limits sanitized output" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const truncated = try writeSafeBounded(
        &out.writer,
        "ab\x1b[31mcd\x1b[0mef",
        4,
        .{},
    );

    try std.testing.expect(truncated);
    try std.testing.expectEqualStrings("abcd" ++ truncated_output_suffix, out.writer.buffered());
    try std.testing.expect(std.mem.indexOfScalar(u8, out.writer.buffered(), ascii_escape) == null);
}

test "bounded terminal writer does not split UTF-8 sequences" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const truncated = try writeSafeBounded(
        &out.writer,
        "ok🙂done",
        5,
        .{},
    );

    try std.testing.expect(truncated);
    try std.testing.expectEqualStrings("ok" ++ truncated_output_suffix, out.writer.buffered());
}

test "bounded terminal writer does not truncate removed escape bytes" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const truncated = try writeSafeBounded(
        &out.writer,
        "\x1b[31mok\x1b[0m",
        2,
        .{},
    );

    try std.testing.expect(!truncated);
    try std.testing.expectEqualStrings("ok", out.writer.buffered());
}
