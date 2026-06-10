const std = @import("std");
const repository_safety = @import("repository_safety");
const text_safety = @import("text_safety");

const max_decimal_id_digits = "18446744073709551615".len;
const full_sha_bytes = 40;
const max_host_bytes = 253;
const max_host_label_bytes = 63;
const max_port_digits = "65535".len;

const HttpScheme = enum {
    http,
    https,
};

const ParsedHttpUrl = struct {
    scheme: HttpScheme,
    rest: []const u8,
};

pub fn isDecimalId(value: []const u8) bool {
    return parseDecimalId(value) != null;
}

pub fn parseDecimalId(value: []const u8) ?u64 {
    if (!isCanonicalDecimalText(value, max_decimal_id_digits)) return null;

    const id = std.fmt.parseUnsigned(u64, value, 10) catch return null;
    return if (id > 0) id else null;
}

pub fn isFullHexSha(value: []const u8) bool {
    if (value.len != full_sha_bytes) return false;

    for (value) |byte| {
        if (!std.ascii.isHex(byte)) return false;
    }

    return true;
}

pub fn isRepositorySlug(value: []const u8) bool {
    return repository_safety.isRepositorySlug(value);
}

pub fn isHttpUrlBase(value: []const u8) bool {
    const parsed = parseHttpPrefix(value) orelse return false;
    if (!isHttpAuthority(parsed.rest)) return false;

    return parsed.scheme == .https or isLoopbackAuthority(parsed.rest);
}

pub fn isHttpUrl(value: []const u8, max_len: usize) bool {
    if (!isSafeSingleLineText(value, max_len)) return false;
    for (value) |byte| {
        if (byte == ' ') return false;
    }

    const parsed = parseHttpPrefix(value) orelse return false;

    const rest = parsed.rest;
    const authority_len = std.mem.indexOfAny(u8, rest, "/?#") orelse rest.len;
    const authority = rest[0..authority_len];
    if (!isHttpAuthority(authority)) return false;
    if (parsed.scheme == .http and !isLoopbackAuthority(authority)) return false;

    return isSafeHttpUrlTail(rest[authority_len..]);
}

fn parseHttpPrefix(value: []const u8) ?ParsedHttpUrl {
    if (std.mem.startsWith(u8, value, "https://")) {
        return .{
            .scheme = .https,
            .rest = value["https://".len..],
        };
    }

    if (std.mem.startsWith(u8, value, "http://")) {
        return .{
            .scheme = .http,
            .rest = value["http://".len..],
        };
    }

    return null;
}

const HostPort = struct {
    host: []const u8,
    port: ?[]const u8 = null,
};

fn isHttpAuthority(authority: []const u8) bool {
    if (authority.len == 0) return false;

    for (authority) |byte| {
        if (text_safety.isAsciiControlOrSpace(byte)) return false;
        if (byte == '/' or byte == '?' or byte == '#' or byte == '@') return false;
    }

    const host_port = splitHostPort(authority) orelse return false;
    if (!isSafeHost(host_port.host)) return false;
    if (host_port.port) |port| {
        if (!isSafePort(port)) return false;
    }

    return true;
}

fn isLoopbackAuthority(authority: []const u8) bool {
    const host_port = splitHostPort(authority) orelse return false;
    return isLoopbackHost(host_port.host);
}

fn splitHostPort(authority: []const u8) ?HostPort {
    if (std.mem.startsWith(u8, authority, "[")) {
        const close = std.mem.indexOfScalar(u8, authority, ']') orelse return null;
        const host = authority[0 .. close + 1];
        const tail = authority[close + 1 ..];

        if (tail.len == 0) return .{ .host = host };
        if (tail[0] != ':') return null;
        return .{
            .host = host,
            .port = tail[1..],
        };
    }

    const separator = std.mem.lastIndexOfScalar(u8, authority, ':') orelse return .{ .host = authority };
    return .{
        .host = authority[0..separator],
        .port = authority[separator + 1 ..],
    };
}

fn isSafeHost(host: []const u8) bool {
    if (host.len == 0 or host.len > max_host_bytes) return false;
    if (isLoopbackIpv6(host)) return true;

    var labels = std.mem.splitScalar(u8, host, '.');
    while (labels.next()) |label| {
        if (!isSafeHostLabel(label)) return false;
    }

    return true;
}

fn isLoopbackHost(host: []const u8) bool {
    return text_safety.eqlAsciiIgnoreCase(host, "localhost") or isLoopbackIpv4(host) or isLoopbackIpv6(host);
}

fn isLoopbackIpv4(host: []const u8) bool {
    var octets = std.mem.splitScalar(u8, host, '.');
    const first = octets.next() orelse return false;
    if (!std.mem.eql(u8, first, "127")) return false;

    var count: usize = 1;
    while (octets.next()) |octet| {
        count += 1;
        if (!isDecimalIpv4Octet(octet)) return false;
    }

    return count == 4;
}

fn isLoopbackIpv6(host: []const u8) bool {
    return std.mem.eql(u8, host, "[::1]");
}

fn isDecimalIpv4Octet(value: []const u8) bool {
    if (!isCanonicalDecimalText(value, 3)) return false;

    const octet = std.fmt.parseUnsigned(u8, value, 10) catch return false;
    return octet <= 255;
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
    if (!isCanonicalDecimalText(port, max_port_digits)) return false;
    const parsed = std.fmt.parseUnsigned(u16, port, 10) catch return false;
    return parsed > 0;
}

fn isSafeHttpUrlTail(value: []const u8) bool {
    var index: usize = 0;
    while (index < value.len) {
        const byte = value[index];
        if (std.ascii.isAlphabetic(byte) or std.ascii.isDigit(byte)) {
            index += 1;
            continue;
        }

        switch (byte) {
            '%' => {
                if (!isSafePercentEncodedByte(value, index)) return false;
                index += 3;
                continue;
            },
            '-', '.', '_', '~', '!', '$', '&', '(', ')', '*', '+', ',', ';', '=', ':', '@', '/', '?' => {},
            else => return false,
        }
        index += 1;
    }

    return true;
}

fn isSafePercentEncodedByte(value: []const u8, index: usize) bool {
    if (index + 2 >= value.len) return false;
    const decoded = decodePercentEncodedByte(value[index + 1], value[index + 2]) orelse return false;
    return !text_safety.isControlByte(decoded);
}

fn decodePercentEncodedByte(high: u8, low: u8) ?u8 {
    const high_value = hexValue(high) orelse return null;
    const low_value = hexValue(low) orelse return null;
    return high_value * 16 + low_value;
}

fn hexValue(byte: u8) ?u8 {
    if (byte >= '0' and byte <= '9') return byte - '0';
    if (byte >= 'a' and byte <= 'f') return byte - 'a' + 10;
    if (byte >= 'A' and byte <= 'F') return byte - 'A' + 10;
    return null;
}

pub fn isSafeMetadataToken(value: []const u8, max_len: usize) bool {
    if (!isSafeSingleLineText(value, max_len)) return false;

    var previous_dot = false;
    for (value, 0..) |byte, index| {
        const is_alpha = std.ascii.isAlphabetic(byte);
        const is_digit = std.ascii.isDigit(byte);
        const is_safe_symbol = byte == '.' or byte == '_' or byte == '-' or byte == '+';

        if (!is_alpha and !is_digit and !is_safe_symbol) return false;
        if (index == 0 and !is_alpha and !is_digit) return false;
        if (byte == '.' and previous_dot) return false;
        previous_dot = byte == '.';
    }

    const last = value[value.len - 1];
    return std.ascii.isAlphabetic(last) or std.ascii.isDigit(last);
}

pub fn isUtcTimestamp(value: []const u8) bool {
    if (value.len != "0000-00-00T00:00:00Z".len) return false;
    if (value[4] != '-' or value[7] != '-' or value[10] != 'T') return false;
    if (value[13] != ':' or value[16] != ':' or value[19] != 'Z') return false;

    if (!isAsciiDigitSlice(value[0..4])) return false;
    const year = fourDigitValue(value, 0) orelse return false;
    const month = twoDigitValue(value, 5) orelse return false;
    const day = twoDigitValue(value, 8) orelse return false;
    const hour = twoDigitValue(value, 11) orelse return false;
    const minute = twoDigitValue(value, 14) orelse return false;
    const second = twoDigitValue(value, 17) orelse return false;

    return isValidCalendarDay(year, month, day) and
        hour <= 23 and
        minute <= 59 and
        second <= 59;
}

pub fn isSafeActionOutputValue(value: []const u8, max_len: usize) bool {
    return isSafeSingleLineText(value, max_len);
}

fn isSafeSingleLineText(value: []const u8, max_len: usize) bool {
    return text_safety.isNonEmptyTextWithoutControl(value, max_len);
}

fn isAsciiDigitSlice(value: []const u8) bool {
    for (value) |byte| {
        if (!std.ascii.isDigit(byte)) return false;
    }
    return true;
}

fn isCanonicalDecimalText(value: []const u8, max_digits: usize) bool {
    if (value.len == 0 or value.len > max_digits) return false;
    if (value.len > 1 and value[0] == '0') return false;
    return isAsciiDigitSlice(value);
}

fn twoDigitValue(value: []const u8, index: usize) ?u8 {
    const high = decimalValue(value[index]) orelse return null;
    const low = decimalValue(value[index + 1]) orelse return null;
    return high * 10 + low;
}

fn fourDigitValue(value: []const u8, index: usize) ?u16 {
    const thousands = decimalValue(value[index]) orelse return null;
    const hundreds = decimalValue(value[index + 1]) orelse return null;
    const tens = decimalValue(value[index + 2]) orelse return null;
    const ones = decimalValue(value[index + 3]) orelse return null;

    return @as(u16, thousands) * 1000 +
        @as(u16, hundreds) * 100 +
        @as(u16, tens) * 10 +
        @as(u16, ones);
}

fn isValidCalendarDay(year: u16, month: u8, day: u8) bool {
    if (month < 1 or month > 12) return false;
    if (day < 1) return false;
    return day <= daysInMonth(year, month);
}

fn daysInMonth(year: u16, month: u8) u8 {
    return switch (month) {
        1, 3, 5, 7, 8, 10, 12 => 31,
        4, 6, 9, 11 => 30,
        2 => if (isLeapYear(year)) 29 else 28,
        else => 0,
    };
}

fn isLeapYear(year: u16) bool {
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0);
}

fn decimalValue(byte: u8) ?u8 {
    if (!std.ascii.isDigit(byte)) return null;
    return byte - '0';
}

test "action values validate decimal ids and full shas" {
    try std.testing.expect(isDecimalId("1"));
    try std.testing.expect(isDecimalId("123456789"));
    try std.testing.expect(isDecimalId("18446744073709551615"));
    try std.testing.expectEqual(@as(?u64, 123456789), parseDecimalId("123456789"));
    try std.testing.expectEqual(@as(?u64, 18446744073709551615), parseDecimalId("18446744073709551615"));
    try std.testing.expect(!isDecimalId(""));
    try std.testing.expect(!isDecimalId("0"));
    try std.testing.expect(!isDecimalId("01"));
    try std.testing.expect(!isDecimalId("12a"));
    try std.testing.expect(!isDecimalId("18446744073709551616"));
    try std.testing.expect(!isDecimalId("1" ** 100));
    try std.testing.expectEqual(@as(?u64, null), parseDecimalId("0"));
    try std.testing.expectEqual(@as(?u64, null), parseDecimalId("01"));
    try std.testing.expectEqual(@as(?u64, null), parseDecimalId("18446744073709551616"));

    try std.testing.expect(isFullHexSha("abcdef0123456789abcdef0123456789abcdef01"));
    try std.testing.expect(!isFullHexSha("abcdef0"));
    try std.testing.expect(!isFullHexSha("abcdef"));
    try std.testing.expect(!isFullHexSha("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"));
    try std.testing.expect(!isFullHexSha("not-a-sha"));
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
    try std.testing.expect(!isRepositorySlug("nullclaw/nullbuilder."));
    try std.testing.expect(!isRepositorySlug("nullclaw/double..dot"));
    try std.testing.expect(!isRepositorySlug("nullclaw/" ++ ("a" ** 101)));
    try std.testing.expect(!isRepositorySlug("nullclaw/nullbuilder.git"));
    try std.testing.expect(!isRepositorySlug("nullclaw/nullbuilder.GIT"));
}

test "action values validate URL bases" {
    try std.testing.expect(isHttpUrlBase("https://github.com"));
    try std.testing.expect(isHttpUrlBase("https://github.example.com:8443"));
    try std.testing.expect(isHttpUrlBase("http://localhost"));
    try std.testing.expect(isHttpUrlBase("http://127.0.0.1:8080"));
    try std.testing.expect(isHttpUrlBase("http://[::1]"));
    try std.testing.expect(isHttpUrlBase("http://[::1]:8080"));

    try std.testing.expect(!isHttpUrlBase("github.com"));
    try std.testing.expect(!isHttpUrlBase("http://github.example.local"));
    try std.testing.expect(!isHttpUrlBase("http://127.0.0.999"));
    try std.testing.expect(!isHttpUrlBase("http://127.0.0.01"));
    try std.testing.expect(!isHttpUrlBase("http://::1"));
    try std.testing.expect(!isHttpUrlBase("http://[::2]"));
    try std.testing.expect(!isHttpUrlBase("http://[::1"));
    try std.testing.expect(!isHttpUrlBase("http://[::1]evil"));
    try std.testing.expect(!isHttpUrlBase("http://[::1]:08080"));
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
    try std.testing.expect(!isHttpUrlBase("https://github.com:0443"));
    try std.testing.expect(isHttpUrlBase("https://github.com:65535"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:65536"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:123456"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:" ++ ("1" ** 100)));
}

test "action values validate metadata tokens" {
    try std.testing.expect(isSafeMetadataToken("nightly-20260504-abcdef0", 128));
    try std.testing.expect(isSafeMetadataToken("x86_64-linux-musl", 128));
    try std.testing.expect(isSafeMetadataToken("aarch64-linux-android.24", 128));
    try std.testing.expect(isSafeMetadataToken("baseline+v7a", 128));

    try std.testing.expect(!isSafeMetadataToken("", 128));
    try std.testing.expect(!isSafeMetadataToken(".hidden", 128));
    try std.testing.expect(!isSafeMetadataToken("-leading-dash", 128));
    try std.testing.expect(!isSafeMetadataToken("trailing.", 128));
    try std.testing.expect(!isSafeMetadataToken("double..dot", 128));
    try std.testing.expect(!isSafeMetadataToken("bad value", 128));
    try std.testing.expect(!isSafeMetadataToken("bad\"value", 128));
    try std.testing.expect(!isSafeMetadataToken("bad/value", 128));
    try std.testing.expect(!isSafeMetadataToken("too-long", 3));
}

test "action values validate UTC timestamps" {
    try std.testing.expect(isUtcTimestamp("2026-05-04T02:23:00Z"));
    try std.testing.expect(isUtcTimestamp("0000-01-01T00:00:00Z"));
    try std.testing.expect(isUtcTimestamp("2024-02-29T00:00:00Z"));
    try std.testing.expect(isUtcTimestamp("2000-02-29T00:00:00Z"));

    try std.testing.expect(!isUtcTimestamp(""));
    try std.testing.expect(!isUtcTimestamp("2026-05-04T02:23:00"));
    try std.testing.expect(!isUtcTimestamp("2026-05-04 02:23:00Z"));
    try std.testing.expect(!isUtcTimestamp("2026-13-04T02:23:00Z"));
    try std.testing.expect(!isUtcTimestamp("2026-00-04T02:23:00Z"));
    try std.testing.expect(!isUtcTimestamp("2026-05-00T02:23:00Z"));
    try std.testing.expect(!isUtcTimestamp("2026-02-29T00:00:00Z"));
    try std.testing.expect(!isUtcTimestamp("2100-02-29T00:00:00Z"));
    try std.testing.expect(!isUtcTimestamp("2026-02-30T00:00:00Z"));
    try std.testing.expect(!isUtcTimestamp("2026-04-31T00:00:00Z"));
    try std.testing.expect(!isUtcTimestamp("2026-05-04T24:23:00Z"));
    try std.testing.expect(!isUtcTimestamp("2026-05-04T02:60:00Z"));
    try std.testing.expect(!isUtcTimestamp("2026-05-04T02:23:60Z"));
    try std.testing.expect(!isUtcTimestamp("2026-05-04T02:23:00Z\n"));
}

test "action values validate HTTP URLs with paths" {
    try std.testing.expect(isHttpUrl("https://github.com/nullclaw/nullbuilder/actions/runs/123", 256));
    try std.testing.expect(isHttpUrl("http://localhost/runs/1?check=true", 256));
    try std.testing.expect(isHttpUrl("http://127.0.0.1:8080/runs/1?check=true", 256));
    try std.testing.expect(isHttpUrl("http://[::1]:8080/runs/1?check=true", 256));
    try std.testing.expect(isHttpUrl("https://github.com:8443/actions/runs/123", 256));
    try std.testing.expect(isHttpUrl("https://github.com/actions/runs/123?check_suite_focus=true", 256));
    try std.testing.expect(isHttpUrl("https://github.com/actions/runs/123?name=check%20suite&step=1", 256));

    try std.testing.expect(!isHttpUrl("", 256));
    try std.testing.expect(!isHttpUrl("github.com/runs/1", 256));
    try std.testing.expect(!isHttpUrl("http://github.example.local/runs/1?check=true", 256));
    try std.testing.expect(!isHttpUrl("http://127.0.0.999/runs/1", 256));
    try std.testing.expect(!isHttpUrl("http://127.0.0.01/runs/1", 256));
    try std.testing.expect(!isHttpUrl("http://[::2]/runs/1", 256));
    try std.testing.expect(!isHttpUrl("http://[::1]evil/runs/1", 256));
    try std.testing.expect(!isHttpUrl("https://github..com/runs/1", 256));
    try std.testing.expect(!isHttpUrl("https://github.com:bad/runs/1", 256));
    try std.testing.expect(!isHttpUrl("https://github.com:0443/runs/1", 256));
    try std.testing.expect(!isHttpUrl("http://127.0.0.1:08080/runs/1", 256));
    try std.testing.expect(!isHttpUrl("https://github.com\n/actions/runs/1", 256));
    try std.testing.expect(!isHttpUrl("https://github.com@evil.example/runs/1", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/path with spaces", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions\\runs\\123", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123\"quoted", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123<bad>", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123`bad`", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123{bad}", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123|bad", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123#summary", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123?check_suite_focus=true#summary", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123?name=check%20suite#step%2D1", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123%", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123%2", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123%zz", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123%0G", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123%0a", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123%1B", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123%7f", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123%85", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/runs/123%c2%85", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/runs/1", 10));
}

test "action values validate single-line GitHub output values" {
    try std.testing.expect(isSafeActionOutputValue("scheduled build", 64));
    try std.testing.expect(isSafeActionOutputValue("scheduled \xd0\xbf\xd1\x83\xd1\x82\xd1\x8c", 64));
    try std.testing.expect(isSafeActionOutputValue("https://example.com/runs/1?check=true", 128));

    try std.testing.expect(!isSafeActionOutputValue("", 64));
    try std.testing.expect(!isSafeActionOutputValue("line\nbreak", 64));
    try std.testing.expect(!isSafeActionOutputValue("line\rbreak", 64));
    try std.testing.expect(!isSafeActionOutputValue("escape\x1b[31m", 64));
    try std.testing.expect(!isSafeActionOutputValue("c1\xc2\x85break", 64));
    try std.testing.expect(!isSafeActionOutputValue("raw\x85control", 64));
    try std.testing.expect(!isSafeActionOutputValue("too-long", 3));
}
