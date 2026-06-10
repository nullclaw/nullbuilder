const std = @import("std");

pub const ascii_escape: u8 = 0x1b;

pub fn hasControl(value: []const u8) bool {
    var index: usize = 0;
    while (index < value.len) {
        if (isControlByte(value[index]) or isUtf8C1Control(value, index)) {
            return true;
        }
        index += utf8SequenceLength(value, index);
    }
    return false;
}

pub fn isControlByte(byte: u8) bool {
    return byte < 0x20 or (byte >= 0x7f and byte <= 0x9f);
}

pub fn isUtf8C1Control(value: []const u8, index: usize) bool {
    return value[index] == 0xc2 and index + 1 < value.len and value[index + 1] >= 0x80 and value[index + 1] <= 0x9f;
}

pub fn utf8SequenceLength(value: []const u8, index: usize) usize {
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

pub fn isUtf8ContinuationByte(byte: u8) bool {
    return byte & 0b1100_0000 == 0b1000_0000;
}

test "text safety detects ASCII and UTF-8 encoded control characters" {
    try std.testing.expect(!hasControl("safe value"));
    try std.testing.expect(!hasControl("repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb5\xd1\x82-\xf0\x9f\x99\x82"));

    try std.testing.expect(hasControl("line\nbreak"));
    try std.testing.expect(hasControl("escape\x1b[31m"));
    try std.testing.expect(hasControl("raw\x85control"));
    try std.testing.expect(hasControl("c1\xc2\x85control"));
}

test "text safety counts only complete UTF-8 sequences" {
    const text = "repo-\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb5\xd1\x82";

    try std.testing.expectEqual(@as(usize, 1), utf8SequenceLength(text, 0));
    try std.testing.expectEqual(@as(usize, 2), utf8SequenceLength(text, 5));
    try std.testing.expectEqual(@as(usize, 1), utf8SequenceLength(text[0..6], 5));
    try std.testing.expect(isUtf8ContinuationByte(text[6]));
}
