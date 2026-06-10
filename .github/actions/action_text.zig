const std = @import("std");

pub const ascii_escape: u8 = 0x1b;

pub fn sanitizeDiagnosticToken(value: []const u8, buffer: []u8) []const u8 {
    var written: usize = 0;
    var index: usize = 0;
    while (index < value.len) {
        const byte = value[index];
        if (byte == ascii_escape) {
            index = skipAnsiEscape(value, index);
            continue;
        }

        if (isUtf8C1Control(value, index)) {
            if (written >= buffer.len) break;
            buffer[written] = ' ';
            index += 2;
            written += 1;
            continue;
        }

        if (isControlByte(byte)) {
            if (written >= buffer.len) break;
            buffer[written] = ' ';
            index += 1;
            written += 1;
            continue;
        }

        if (isInvalidUtf8SequenceStart(value, index)) {
            if (written >= buffer.len) break;
            buffer[written] = ' ';
            index += 1;
            written += 1;
            continue;
        }

        const sequence_len = utf8SequenceLength(value, index);
        if (sequence_len > buffer.len - written) break;

        @memcpy(buffer[written..][0..sequence_len], value[index..][0..sequence_len]);
        written += sequence_len;
        index += sequence_len;
    }

    return buffer[0..written];
}

pub fn hasControl(value: []const u8) bool {
    var index: usize = 0;
    while (index < value.len) {
        if (isControlByte(value[index]) or isUtf8C1Control(value, index) or isInvalidUtf8SequenceStart(value, index)) {
            return true;
        }
        index += utf8SequenceLength(value, index);
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

fn utf8SequenceLength(value: []const u8, index: usize) usize {
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

fn isUtf8ContinuationByte(byte: u8) bool {
    return byte & 0b1100_0000 == 0b1000_0000;
}

fn isInvalidUtf8SequenceStart(value: []const u8, index: usize) bool {
    return value[index] >= 0x80 and utf8SequenceLength(value, index) == 1;
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
    try std.testing.expect(!hasControl("repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82-\xf0\x9f\x99\x82"));
    try std.testing.expect(hasControl("line\nbreak"));
    try std.testing.expect(hasControl("escape\x1b[31m"));
    try std.testing.expect(hasControl("raw\x85control"));
    try std.testing.expect(hasControl("c1\xc2\x85control"));
    try std.testing.expect(hasControl("overlong\xc0\x85control"));
    try std.testing.expect(hasControl("truncated\xe2\x82"));
    try std.testing.expect(hasControl("surrogate\xed\xa0\x80"));
    try std.testing.expect(hasControl("too-large\xf4\x90\x80\x80"));
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

    var invalid_utf8_buffer: [32]u8 = undefined;
    try std.testing.expectEqualStrings(
        "bad  done",
        sanitizeDiagnosticToken("bad\xc0\x85done", &invalid_utf8_buffer),
    );

    var short_buffer: [4]u8 = undefined;
    try std.testing.expectEqualStrings("abcd", sanitizeDiagnosticToken("abcdef", &short_buffer));
}

test "action text bounds diagnostic tokens without splitting UTF-8 sequences" {
    const text = "repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82";

    var partial_buffer: [6]u8 = undefined;
    try std.testing.expectEqualStrings("repo-", sanitizeDiagnosticToken(text, &partial_buffer));

    var complete_buffer: [7]u8 = undefined;
    try std.testing.expectEqualStrings("repo-\xd0\xbf", sanitizeDiagnosticToken(text, &complete_buffer));
}

test "action text keeps URL authority ASCII control checks explicit" {
    try std.testing.expect(isAsciiControlOrSpace(' '));
    try std.testing.expect(isAsciiControlOrSpace('\n'));
    try std.testing.expect(isAsciiControlOrSpace(0x7f));
    try std.testing.expect(!isAsciiControlOrSpace('a'));
}
