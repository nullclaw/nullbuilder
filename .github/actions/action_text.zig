const std = @import("std");

const text_safety = @import("text_safety");

pub const ascii_escape: u8 = text_safety.ascii_escape;

pub fn sanitizeDiagnosticToken(value: []const u8, buffer: []u8) []const u8 {
    var written: usize = 0;
    var index: usize = 0;
    while (index < value.len) {
        const byte = value[index];
        if (byte == ascii_escape) {
            index = text_safety.skipAnsiEscape(value, index);
            continue;
        }

        if (text_safety.isRawAnsiStringControl(byte)) {
            index = text_safety.skipAnsiStringControl(value, index + 1);
            continue;
        }

        if (text_safety.isUtf8C1Control(value, index)) {
            if (written >= buffer.len) break;
            buffer[written] = ' ';
            index += 2;
            written += 1;
            continue;
        }

        if (text_safety.utf8BidiControlSequenceLength(value, index)) |sequence_len| {
            if (written >= buffer.len) break;
            buffer[written] = ' ';
            index += sequence_len;
            written += 1;
            continue;
        }

        if (text_safety.isControlByte(byte)) {
            if (written >= buffer.len) break;
            buffer[written] = ' ';
            index += 1;
            written += 1;
            continue;
        }

        if (text_safety.isInvalidUtf8SequenceStart(value, index)) {
            if (written >= buffer.len) break;
            buffer[written] = ' ';
            index += 1;
            written += 1;
            continue;
        }

        const sequence_len = text_safety.utf8SequenceLength(value, index);
        if (sequence_len > buffer.len - written) break;

        @memcpy(buffer[written..][0..sequence_len], value[index..][0..sequence_len]);
        written += sequence_len;
        index += sequence_len;
    }

    return buffer[0..written];
}

pub fn hasControl(value: []const u8) bool {
    return text_safety.hasControl(value);
}

pub fn isAsciiControlOrSpace(byte: u8) bool {
    return byte <= ' ' or byte == 0x7f;
}

pub fn isControlByte(byte: u8) bool {
    return text_safety.isControlByte(byte);
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
    try std.testing.expect(hasControl("bidi\xe2\x80\xaecontrol"));
    try std.testing.expect(hasControl("bidi\xe2\x81\xa6control"));
    try std.testing.expect(hasControl("bidi\xd8\x9ccontrol"));
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

    var string_control_buffer: [64]u8 = undefined;
    const string_control = sanitizeDiagnosticToken(
        "start\x1bPprivate-dcs\x1b\\mid\x1bXprivate-sos\x1b\\raw\x90private-raw\x9cend",
        &string_control_buffer,
    );
    try std.testing.expectEqualStrings("startmidrawend", string_control);
    try std.testing.expect(std.mem.indexOf(u8, string_control, "private") == null);

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

    var bidi_buffer: [32]u8 = undefined;
    try std.testing.expectEqualStrings(
        "bad spoof done",
        sanitizeDiagnosticToken("bad\xe2\x80\xaespoof\xe2\x81\xa9done", &bidi_buffer),
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
