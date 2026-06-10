const std = @import("std");

pub const ascii_escape: u8 = 0x1b;

pub fn sanitizeDiagnosticToken(value: []const u8, buffer: []u8) []const u8 {
    var written: usize = 0;
    var index: usize = 0;
    while (index < value.len) {
        if (written >= buffer.len) break;

        const byte = value[index];
        if (byte == ascii_escape) {
            index = skipAnsiEscape(value, index);
            continue;
        }

        if (isUtf8C1Control(value, index)) {
            buffer[written] = ' ';
            index += 2;
        } else {
            buffer[written] = if (isControlByte(byte)) ' ' else byte;
            index += 1;
        }
        written += 1;
    }

    return buffer[0..written];
}

pub fn hasControl(value: []const u8) bool {
    var index: usize = 0;
    while (index < value.len) {
        if (isControlByte(value[index]) or isUtf8C1Control(value, index)) {
            return true;
        }
        index += 1;
    }
    return false;
}

pub fn isAsciiControlOrSpace(byte: u8) bool {
    return byte <= ' ' or byte == 0x7f;
}

pub fn isControlByte(byte: u8) bool {
    return byte < 0x20 or (byte >= 0x7f and byte <= 0x9f);
}

pub fn isUtf8C1Control(value: []const u8, index: usize) bool {
    return value[index] == 0xc2 and index + 1 < value.len and value[index + 1] >= 0x80 and value[index + 1] <= 0x9f;
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

test "action text detects ASCII and UTF-8 encoded control characters" {
    try std.testing.expect(!hasControl("safe value"));
    try std.testing.expect(hasControl("line\nbreak"));
    try std.testing.expect(hasControl("escape\x1b[31m"));
    try std.testing.expect(hasControl("raw\x85control"));
    try std.testing.expect(hasControl("c1\xc2\x85control"));
}

test "action text sanitizes diagnostic tokens without echoing controls" {
    var buffer: [16]u8 = undefined;
    try std.testing.expectEqualStrings(
        "bad  value",
        sanitizeDiagnosticToken("bad\n\x1b[31m\tvalue", &buffer),
    );

    var title_buffer: [32]u8 = undefined;
    try std.testing.expectEqualStrings(
        "baddone",
        sanitizeDiagnosticToken("bad\x1b]0;title\x07done", &title_buffer),
    );

    var c1_buffer: [32]u8 = undefined;
    try std.testing.expectEqualStrings(
        "bad next raw",
        sanitizeDiagnosticToken("bad\xc2\x85next\x85raw", &c1_buffer),
    );

    var short_buffer: [4]u8 = undefined;
    try std.testing.expectEqualStrings("abcd", sanitizeDiagnosticToken("abcdef", &short_buffer));
}

test "action text keeps URL authority ASCII control checks explicit" {
    try std.testing.expect(isAsciiControlOrSpace(' '));
    try std.testing.expect(isAsciiControlOrSpace('\n'));
    try std.testing.expect(isAsciiControlOrSpace(0x7f));
    try std.testing.expect(!isAsciiControlOrSpace('a'));
}
