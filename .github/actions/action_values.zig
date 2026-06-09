const std = @import("std");

pub fn isDecimalId(value: []const u8) bool {
    if (value.len == 0) return false;

    const id = std.fmt.parseUnsigned(u64, value, 10) catch return false;
    return id > 0;
}

pub fn isHexSha(value: []const u8) bool {
    if (value.len < 7 or value.len > 64) return false;

    for (value) |byte| {
        if (!std.ascii.isHex(byte)) return false;
    }

    return true;
}

pub fn isRepositorySlug(value: []const u8) bool {
    var segments = std.mem.splitScalar(u8, value, '/');
    const owner = segments.next() orelse return false;
    const repo = segments.next() orelse return false;
    if (segments.next() != null) return false;

    return isSafeSlugSegment(owner) and isSafeSlugSegment(repo);
}

pub fn isHttpUrlBase(value: []const u8) bool {
    const scheme_len: usize = if (std.mem.startsWith(u8, value, "https://"))
        "https://".len
    else if (std.mem.startsWith(u8, value, "http://"))
        "http://".len
    else
        return false;
    const authority = value[scheme_len..];
    if (authority.len == 0) return false;

    var has_hostname_char = false;
    for (authority) |byte| {
        if (isAsciiControlOrSpace(byte)) return false;
        if (byte == '/' or byte == '?' or byte == '#') return false;
        if (std.ascii.isAlphanumeric(byte)) has_hostname_char = true;
    }

    return has_hostname_char;
}

pub fn isSafeMetadataValue(value: []const u8, max_len: usize) bool {
    if (value.len == 0 or value.len > max_len) return false;

    for (value) |byte| {
        if (isAsciiControlOrSpace(byte)) return false;
    }

    return true;
}

fn isSafeSlugSegment(value: []const u8) bool {
    if (value.len == 0) return false;

    var previous_dot = false;
    for (value, 0..) |byte, index| {
        const is_alpha = std.ascii.isAlphabetic(byte);
        const is_digit = std.ascii.isDigit(byte);
        const is_safe_symbol = byte == '.' or byte == '_' or byte == '-';

        if (!is_alpha and !is_digit and !is_safe_symbol) return false;
        if (index == 0 and !is_alpha and !is_digit) return false;
        if (byte == '.' and previous_dot) return false;
        previous_dot = byte == '.';
    }

    return true;
}

fn isAsciiControlOrSpace(byte: u8) bool {
    return byte <= ' ' or byte == 0x7f;
}

test "action values validate decimal ids and shas" {
    try std.testing.expect(isDecimalId("1"));
    try std.testing.expect(isDecimalId("123456789"));
    try std.testing.expect(!isDecimalId(""));
    try std.testing.expect(!isDecimalId("0"));
    try std.testing.expect(!isDecimalId("12a"));

    try std.testing.expect(isHexSha("abcdef0"));
    try std.testing.expect(isHexSha("abcdef0123456789abcdef0123456789abcdef01"));
    try std.testing.expect(!isHexSha("abcdef"));
    try std.testing.expect(!isHexSha("not-a-sha"));
}

test "action values validate repository slugs" {
    try std.testing.expect(isRepositorySlug("nullclaw/nullbuilder"));
    try std.testing.expect(isRepositorySlug("null-claw/null.builder"));

    try std.testing.expect(!isRepositorySlug(""));
    try std.testing.expect(!isRepositorySlug("nullclaw"));
    try std.testing.expect(!isRepositorySlug("nullclaw/nullbuilder/extra"));
    try std.testing.expect(!isRepositorySlug("../nullbuilder"));
    try std.testing.expect(!isRepositorySlug("nullclaw/.hidden"));
}

test "action values validate URL bases and metadata" {
    try std.testing.expect(isHttpUrlBase("https://github.com"));
    try std.testing.expect(isHttpUrlBase("https://github.example.com:8443"));

    try std.testing.expect(!isHttpUrlBase("github.com"));
    try std.testing.expect(!isHttpUrlBase("https://."));
    try std.testing.expect(!isHttpUrlBase("https://github.com/path"));
    try std.testing.expect(!isHttpUrlBase("https://github.com?query=1"));
    try std.testing.expect(!isHttpUrlBase("https://github.com\n"));

    try std.testing.expect(isSafeMetadataValue("nightly-20260609-abcdef0", 64));
    try std.testing.expect(!isSafeMetadataValue("", 64));
    try std.testing.expect(!isSafeMetadataValue("line\nbreak", 64));
    try std.testing.expect(!isSafeMetadataValue("too-long", 3));
}
