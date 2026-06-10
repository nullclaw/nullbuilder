const std = @import("std");

const text_safety = @import("text_safety");

pub const ascii_escape: u8 = text_safety.ascii_escape;
pub const truncated_output_suffix = "\n[output truncated]\n";

pub const SanitizeOptions = struct {
    preserve_newlines: bool = false,
};

pub const OutputBudget = struct {
    remaining: usize,
    truncated: bool = false,
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
    var budget = OutputBudget{ .remaining = max_bytes };
    return writeSafeBudgeted(out, value, &budget, options);
}

pub fn writeSafeBudgeted(out: *std.Io.Writer, value: []const u8, budget: *OutputBudget, options: SanitizeOptions) !bool {
    if (budget.truncated) return true;

    var index: usize = 0;
    var buffer: [4]u8 = undefined;

    while (index < value.len) {
        if (nextSanitizedSlice(value, &index, options, &buffer)) |slice| {
            if (budget.remaining == 0 or slice.len > budget.remaining) {
                try out.writeAll(truncated_output_suffix);
                budget.remaining = 0;
                budget.truncated = true;
                return true;
            }

            try out.writeAll(slice);
            budget.remaining -= slice.len;
        }
    }

    return false;
}

pub fn clipUtf8(value: []const u8, max_len: usize) []const u8 {
    if (value.len <= max_len) return value;
    if (max_len == 0) return "";

    var end = max_len;
    while (end > 0 and text_safety.isUtf8ContinuationByte(value[end])) {
        end -= 1;
    }

    return value[0..end];
}

pub fn hasUnsafeControl(value: []const u8, options: SanitizeOptions) bool {
    var index: usize = 0;
    while (index < value.len) {
        const byte = value[index];
        if (byte == ascii_escape or
            text_safety.isUtf8C1Control(value, index) or
            text_safety.utf8BidiControlSequenceLength(value, index) != null or
            text_safety.isInvalidUtf8SequenceStart(value, index) or
            isUnsafeTerminalControlByte(byte, options))
        {
            return true;
        }
        index += text_safety.utf8SequenceLength(value, index);
    }

    return false;
}

fn isSafe(value: []const u8, options: SanitizeOptions) bool {
    return !hasUnsafeControl(value, options);
}

fn nextSanitizedSlice(value: []const u8, index: *usize, options: SanitizeOptions, buffer: *[4]u8) ?[]const u8 {
    const byte = value[index.*];
    if (byte == ascii_escape) {
        index.* = text_safety.skipAnsiEscape(value, index.*);
        return null;
    }

    if (text_safety.isRawAnsiControlSequence(byte)) {
        index.* = text_safety.skipAnsiControlSequence(value, index.* + 1);
        return null;
    }

    if (text_safety.isUtf8AnsiControlSequence(value, index.*)) {
        index.* = text_safety.skipAnsiControlSequence(value, index.* + 2);
        return null;
    }

    if (text_safety.isRawAnsiStringControl(byte)) {
        index.* = text_safety.skipAnsiStringControl(value, index.* + 1);
        return null;
    }

    if (text_safety.isUtf8C1Control(value, index.*)) {
        index.* += 2;
        buffer[0] = ' ';
        return buffer[0..1];
    }

    if (text_safety.utf8BidiControlSequenceLength(value, index.*)) |sequence_len| {
        index.* += sequence_len;
        buffer[0] = ' ';
        return buffer[0..1];
    }

    if (isUnsafeTerminalControlByte(byte, options)) {
        index.* += 1;
        buffer[0] = ' ';
        return buffer[0..1];
    }

    if (text_safety.isInvalidUtf8SequenceStart(value, index.*)) {
        index.* += 1;
        buffer[0] = ' ';
        return buffer[0..1];
    }

    const start = index.*;
    const sequence_len = text_safety.utf8SequenceLength(value, start);
    index.* += sequence_len;
    return value[start..index.*];
}

fn isUnsafeTerminalControlByte(byte: u8, options: SanitizeOptions) bool {
    if (options.preserve_newlines and byte == '\n') return false;
    return text_safety.isControlByte(byte);
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
    try std.testing.expect(hasUnsafeControl("bad\xc0\x85value", .{}));
    try std.testing.expect(hasUnsafeControl("bad\xe2\x82value", .{}));
    try std.testing.expect(hasUnsafeControl("bad\xe2\x80\xaevalue", .{}));
    try std.testing.expect(hasUnsafeControl("bad\xe2\x81\xa6value", .{}));
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

test "terminal sanitizer replaces malformed UTF-8 bytes" {
    const safe = try sanitizeAlloc(std.testing.allocator, "bad\xc0\x85next\xe2\x82done", .{});
    defer std.testing.allocator.free(safe);

    try std.testing.expectEqualStrings("bad  next  done", safe);
}

test "terminal sanitizer replaces bidi controls" {
    const safe = try sanitizeAlloc(std.testing.allocator, "bad\xe2\x80\xaespoof\xe2\x81\xa9done", .{});
    defer std.testing.allocator.free(safe);

    try std.testing.expectEqualStrings("bad spoof done", safe);
}

test "terminal sanitizer strips ANSI string control payloads" {
    const safe = try sanitizeAlloc(
        std.testing.allocator,
        "start\x1bPprivate-dcs\x1b\\mid\x1bXprivate-sos\x1b\\pm\x1b^private-pm\x07apc\x1b_private-apc\x1b\\end",
        .{},
    );
    defer std.testing.allocator.free(safe);

    try std.testing.expectEqualStrings("startmidpmapcend", safe);
    try std.testing.expect(std.mem.indexOf(u8, safe, "private") == null);
    try std.testing.expect(std.mem.indexOfScalar(u8, safe, ascii_escape) == null);
}

test "terminal sanitizer strips raw C1 string control payloads" {
    const safe = try sanitizeAlloc(
        std.testing.allocator,
        "start\x90private-dcs\x9cmid\x98private-sos\x1b\\pm\x9eprivate-pm\x07apc\x9fprivate-apc\x9cend\x9dprivate-osc\x9cdone",
        .{},
    );
    defer std.testing.allocator.free(safe);

    try std.testing.expectEqualStrings("startmidpmapcenddone", safe);
    try std.testing.expect(std.mem.indexOf(u8, safe, "private") == null);
    try std.testing.expect(!hasUnsafeControl(safe, .{}));
}

test "terminal sanitizer strips raw and UTF-8 C1 CSI payloads" {
    const safe = try sanitizeAlloc(
        std.testing.allocator,
        "start\x9b31mred\xc2\x9b0mdone",
        .{},
    );
    defer std.testing.allocator.free(safe);

    try std.testing.expectEqualStrings("startreddone", safe);
    try std.testing.expect(std.mem.indexOf(u8, safe, "31m") == null);
    try std.testing.expect(std.mem.indexOf(u8, safe, "0m") == null);
    try std.testing.expect(!hasUnsafeControl(safe, .{}));
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

test "bounded terminal writer handles zero and exact limits explicitly" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const zero_limit = try writeSafeBounded(&out.writer, "abc", 0, .{});
    try std.testing.expect(zero_limit);
    try std.testing.expectEqualStrings(truncated_output_suffix, out.writer.buffered());

    out.clearRetainingCapacity();
    const exact_limit = try writeSafeBounded(&out.writer, "abc", 3, .{});
    try std.testing.expect(!exact_limit);
    try std.testing.expectEqualStrings("abc", out.writer.buffered());

    out.clearRetainingCapacity();
    const removed_only = try writeSafeBounded(&out.writer, "\x1b[31m\x1b[0m", 0, .{});
    try std.testing.expect(!removed_only);
    try std.testing.expectEqualStrings("", out.writer.buffered());
}

test "budgeted terminal writer shares limits across calls" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    var budget = OutputBudget{ .remaining = 4 };

    try std.testing.expect(!try writeSafeBudgeted(&out.writer, "ab", &budget, .{}));
    try std.testing.expectEqual(@as(usize, 2), budget.remaining);
    try std.testing.expect(!budget.truncated);

    try std.testing.expect(!try writeSafeBudgeted(&out.writer, "cd", &budget, .{}));
    try std.testing.expectEqual(@as(usize, 0), budget.remaining);
    try std.testing.expect(!budget.truncated);

    try std.testing.expect(try writeSafeBudgeted(&out.writer, "ef", &budget, .{}));
    try std.testing.expectEqual(@as(usize, 0), budget.remaining);
    try std.testing.expect(budget.truncated);
    try std.testing.expectEqualStrings("abcd" ++ truncated_output_suffix, out.writer.buffered());

    try std.testing.expect(try writeSafeBudgeted(&out.writer, "gh", &budget, .{}));
    try std.testing.expectEqualStrings("abcd" ++ truncated_output_suffix, out.writer.buffered());
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
