const std = @import("std");

const max_decimal_id_digits = "18446744073709551615".len;
const max_host_bytes = 253;
const max_host_label_bytes = 63;
const max_port_digits = "65535".len;
const max_repo_segment_bytes = 100;

pub fn isDecimalId(value: []const u8) bool {
    if (value.len == 0 or value.len > max_decimal_id_digits) return false;

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

    return isSafeOwnerSegment(owner) and isSafeRepoSegment(repo);
}

pub fn isHttpUrlBase(value: []const u8) bool {
    const scheme_len: usize = if (std.mem.startsWith(u8, value, "https://"))
        "https://".len
    else if (std.mem.startsWith(u8, value, "http://"))
        "http://".len
    else
        return false;

    return isHttpAuthority(value[scheme_len..]);
}

const HostPort = struct {
    host: []const u8,
    port: ?[]const u8 = null,
};

fn isHttpAuthority(authority: []const u8) bool {
    if (authority.len == 0) return false;

    for (authority) |byte| {
        if (isAsciiControlOrSpace(byte)) return false;
        if (byte == '/' or byte == '?' or byte == '#' or byte == '@') return false;
    }

    const host_port = splitHostPort(authority);
    if (!isSafeHost(host_port.host)) return false;
    if (host_port.port) |port| {
        if (!isSafePort(port)) return false;
    }

    return true;
}

fn splitHostPort(authority: []const u8) HostPort {
    const separator = std.mem.lastIndexOfScalar(u8, authority, ':') orelse return .{ .host = authority };
    return .{
        .host = authority[0..separator],
        .port = authority[separator + 1 ..],
    };
}

fn isSafeHost(host: []const u8) bool {
    if (host.len == 0 or host.len > max_host_bytes) return false;

    var labels = std.mem.splitScalar(u8, host, '.');
    while (labels.next()) |label| {
        if (!isSafeHostLabel(label)) return false;
    }

    return true;
}

fn isSafeHostLabel(label: []const u8) bool {
    if (label.len == 0 or label.len > max_host_label_bytes) return false;

    for (label, 0..) |byte, index| {
        const is_alpha = std.ascii.isAlphabetic(byte);
        const is_digit = std.ascii.isDigit(byte);
        const is_hyphen = byte == '-';

        if (!is_alpha and !is_digit and !is_hyphen) return false;
        if ((index == 0 or index == label.len - 1) and !is_alpha and !is_digit) return false;
    }

    return true;
}

fn isSafePort(port: []const u8) bool {
    if (port.len == 0 or port.len > max_port_digits) return false;
    const parsed = std.fmt.parseUnsigned(u16, port, 10) catch return false;
    return parsed > 0;
}

pub fn isSafeMetadataValue(value: []const u8, max_len: usize) bool {
    if (!isSafeSingleLineText(value, max_len)) return false;

    for (value) |byte| {
        if (byte == ' ') return false;
    }

    return true;
}

pub fn isSafeActionOutputValue(value: []const u8, max_len: usize) bool {
    return isSafeSingleLineText(value, max_len);
}

fn isSafeSingleLineText(value: []const u8, max_len: usize) bool {
    if (value.len == 0 or value.len > max_len) return false;

    var index: usize = 0;
    while (index < value.len) {
        const byte = value[index];
        if (isControlByte(byte) or isUtf8C1Control(value, index)) return false;
        index += 1;
    }

    return true;
}

fn isControlByte(byte: u8) bool {
    return byte < 0x20 or (byte >= 0x7f and byte <= 0x9f);
}

fn isUtf8C1Control(value: []const u8, index: usize) bool {
    return value[index] == 0xc2 and index + 1 < value.len and value[index + 1] >= 0x80 and value[index + 1] <= 0x9f;
}

fn isSafeOwnerSegment(value: []const u8) bool {
    if (value.len == 0 or value.len > 39) return false;

    for (value, 0..) |byte, index| {
        const is_alpha = std.ascii.isAlphabetic(byte);
        const is_digit = std.ascii.isDigit(byte);
        const is_hyphen = byte == '-';

        if (!is_alpha and !is_digit and !is_hyphen) return false;
        if ((index == 0 or index == value.len - 1) and !is_alpha and !is_digit) return false;
    }

    return true;
}

fn isSafeRepoSegment(value: []const u8) bool {
    if (value.len == 0 or value.len > max_repo_segment_bytes) return false;
    if (endsWithAsciiIgnoreCase(value, ".git")) return false;

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

fn endsWithAsciiIgnoreCase(value: []const u8, suffix: []const u8) bool {
    if (value.len < suffix.len) return false;
    const tail = value[value.len - suffix.len ..];

    for (tail, suffix) |left_byte, right_byte| {
        if (std.ascii.toLower(left_byte) != std.ascii.toLower(right_byte)) return false;
    }

    return true;
}

fn isAsciiControlOrSpace(byte: u8) bool {
    return byte <= ' ' or byte == 0x7f;
}

test "action values validate decimal ids and shas" {
    try std.testing.expect(isDecimalId("1"));
    try std.testing.expect(isDecimalId("123456789"));
    try std.testing.expect(isDecimalId("18446744073709551615"));
    try std.testing.expect(!isDecimalId(""));
    try std.testing.expect(!isDecimalId("0"));
    try std.testing.expect(!isDecimalId("12a"));
    try std.testing.expect(!isDecimalId("18446744073709551616"));
    try std.testing.expect(!isDecimalId("1" ** 100));

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
    try std.testing.expect(!isRepositorySlug("null_claw/nullbuilder"));
    try std.testing.expect(!isRepositorySlug("null.claw/nullbuilder"));
    try std.testing.expect(!isRepositorySlug("nullclaw-/nullbuilder"));
    try std.testing.expect(!isRepositorySlug("abcdefghijklmnopqrstuvwxyzabcdefghijklmn/nullbuilder"));
    try std.testing.expect(!isRepositorySlug("nullclaw/.hidden"));
    try std.testing.expect(!isRepositorySlug("nullclaw/" ++ ("a" ** 101)));
    try std.testing.expect(!isRepositorySlug("nullclaw/nullbuilder.git"));
    try std.testing.expect(!isRepositorySlug("nullclaw/nullbuilder.GIT"));
}

test "action values validate URL bases and metadata" {
    try std.testing.expect(isHttpUrlBase("https://github.com"));
    try std.testing.expect(isHttpUrlBase("https://github.example.com:8443"));
    try std.testing.expect(isHttpUrlBase("http://github.example.local"));

    try std.testing.expect(!isHttpUrlBase("github.com"));
    try std.testing.expect(!isHttpUrlBase("https://."));
    try std.testing.expect(!isHttpUrlBase("https://github.com."));
    try std.testing.expect(!isHttpUrlBase("https://github..com"));
    try std.testing.expect(!isHttpUrlBase("https://github_.com"));
    try std.testing.expect(!isHttpUrlBase("https://-github.com"));
    try std.testing.expect(!isHttpUrlBase("https://github-.com"));
    try std.testing.expect(!isHttpUrlBase("https://" ++ ("a" ** 64) ++ ".com"));
    try std.testing.expect(!isHttpUrlBase("https://github.com/path"));
    try std.testing.expect(!isHttpUrlBase("https://github.com?query=1"));
    try std.testing.expect(!isHttpUrlBase("https://github.com\n"));
    try std.testing.expect(!isHttpUrlBase("https://github.com@evil.example"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:abc"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:0"));
    try std.testing.expect(isHttpUrlBase("https://github.com:65535"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:65536"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:123456"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:" ++ ("1" ** 100)));

    try std.testing.expect(isSafeMetadataValue("nightly-20260609-abcdef0", 64));
    try std.testing.expect(!isSafeMetadataValue("", 64));
    try std.testing.expect(!isSafeMetadataValue("line\nbreak", 64));
    try std.testing.expect(!isSafeMetadataValue("too-long", 3));
}

test "action values validate single-line GitHub output values" {
    try std.testing.expect(isSafeActionOutputValue("scheduled build", 64));
    try std.testing.expect(isSafeActionOutputValue("https://example.com/runs/1?check=true", 128));

    try std.testing.expect(!isSafeActionOutputValue("", 64));
    try std.testing.expect(!isSafeActionOutputValue("line\nbreak", 64));
    try std.testing.expect(!isSafeActionOutputValue("line\rbreak", 64));
    try std.testing.expect(!isSafeActionOutputValue("escape\x1b[31m", 64));
    try std.testing.expect(!isSafeActionOutputValue("c1\xc2\x85break", 64));
    try std.testing.expect(!isSafeActionOutputValue("raw\x85control", 64));
    try std.testing.expect(!isSafeActionOutputValue("too-long", 3));
}
