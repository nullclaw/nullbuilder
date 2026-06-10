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
    while (index < value.len) {
        if (nextSanitizedByte(value, &index, options)) |byte| {
            try sanitized.append(byte);
        }
    }

    return sanitized.toOwnedSlice();
}

pub fn writeSafe(out: *std.Io.Writer, value: []const u8, options: SanitizeOptions) !void {
    var index: usize = 0;
    while (index < value.len) {
        if (nextSanitizedByte(value, &index, options)) |byte| {
            try out.writeByte(byte);
        }
    }
}

pub fn writeSafeBounded(out: *std.Io.Writer, value: []const u8, max_bytes: usize, options: SanitizeOptions) !bool {
    var index: usize = 0;
    var written: usize = 0;

    while (index < value.len) {
        if (nextSanitizedByte(value, &index, options)) |byte| {
            if (written >= max_bytes) {
                try out.writeAll(truncated_output_suffix);
                return true;
            }

            try out.writeByte(byte);
            written += 1;
        }
    }

    return false;
}

fn isSafe(value: []const u8, options: SanitizeOptions) bool {
    var index: usize = 0;
    while (index < value.len) {
        const byte = value[index];
        if (byte == ascii_escape or isUnsafeTerminalControlByte(byte, options) or isUtf8C1Control(value, index)) {
            return false;
        }
        index += 1;
    }

    return true;
}

fn nextSanitizedByte(value: []const u8, index: *usize, options: SanitizeOptions) ?u8 {
    const byte = value[index.*];
    if (byte == ascii_escape) {
        index.* = skipAnsiEscape(value, index.*);
        return null;
    }

    if (isUtf8C1Control(value, index.*)) {
        index.* += 2;
        return ' ';
    }

    index.* += 1;
    return if (isUnsafeTerminalControlByte(byte, options)) ' ' else byte;
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

test "terminal sanitizer borrows already safe text" {
    const input = "safe text";
    const safe = try sanitizeMaybeAlloc(std.testing.allocator, input, .{});
    defer safe.deinit(std.testing.allocator);

    try std.testing.expect(!safe.allocated);
    try std.testing.expectEqual(@intFromPtr(input.ptr), @intFromPtr(safe.value.ptr));
    try std.testing.expectEqualStrings(input, safe.value);
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
