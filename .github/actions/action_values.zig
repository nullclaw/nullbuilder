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

    fn prefix(self: HttpScheme) []const u8 {
        return switch (self) {
            .http => "http://",
            .https => "https://",
        };
    }
};

const http_schemes = [_]HttpScheme{ .https, .http };

const ParsedHttpUrl = struct {
    scheme: HttpScheme,
    rest: []const u8,
};

const ParsedHttpUrlParts = struct {
    scheme: HttpScheme,
    authority: []const u8,
    tail: []const u8,
};

const HttpUrlTailValidation = union(enum) {
    safe,
    invalid_prefix,
    invalid_character: usize,
    invalid_percent_encoding: usize,
    percent_encoded_control: usize,
    unsafe_path_segment: usize,

    fn accepts(self: HttpUrlTailValidation) bool {
        return switch (self) {
            .safe => true,
            else => false,
        };
    }
};

const PercentEncodedByteValidation = enum {
    safe,
    truncated,
    invalid_hex,
    control,

    fn accepts(self: PercentEncodedByteValidation) bool {
        return self == .safe;
    }
};

pub const DecimalIdValidation = union(enum) {
    safe: u64,
    empty,
    oversized,
    leading_zero,
    invalid_digit: usize,
    overflow,
    zero,

    pub fn accepts(self: DecimalIdValidation) bool {
        return switch (self) {
            .safe => true,
            else => false,
        };
    }

    pub fn valueOrNull(self: DecimalIdValidation) ?u64 {
        return switch (self) {
            .safe => |value| value,
            else => null,
        };
    }
};

const KnownHostLiteral = enum {
    github_dot_com,
    localhost,
    loopback_ipv6,

    fn text(self: KnownHostLiteral) []const u8 {
        return switch (self) {
            .github_dot_com => "github.com",
            .localhost => "localhost",
            .loopback_ipv6 => "[::1]",
        };
    }

    fn matches(self: KnownHostLiteral, host: []const u8) bool {
        return switch (self) {
            .github_dot_com, .loopback_ipv6 => std.mem.eql(u8, host, self.text()),
            .localhost => text_safety.eqlAsciiIgnoreCase(host, self.text()),
        };
    }
};

const HostKind = enum {
    github_dot_com,
    localhost,
    loopback_ipv4,
    loopback_ipv6,
    domain,

    fn isLoopback(self: HostKind) bool {
        return switch (self) {
            .localhost, .loopback_ipv4, .loopback_ipv6 => true,
            .github_dot_com, .domain => false,
        };
    }
};

const LoopbackIpv4Prefix = enum {
    first_octet,

    fn text(self: LoopbackIpv4Prefix) []const u8 {
        return switch (self) {
            .first_octet => "127",
        };
    }

    fn matches(self: LoopbackIpv4Prefix, octet: []const u8) bool {
        return std.mem.eql(u8, octet, self.text());
    }
};

const LoopbackIpv4Address = struct {
    octets: [4][]const u8,

    fn parse(host: []const u8) ?LoopbackIpv4Address {
        var split = std.mem.splitScalar(u8, host, '.');
        var octets: [4][]const u8 = undefined;
        var index: usize = 0;

        while (split.next()) |octet| {
            if (index >= octets.len) return null;
            octets[index] = octet;
            index += 1;
        }

        if (index != octets.len) return null;
        if (!LoopbackIpv4Prefix.first_octet.matches(octets[0])) return null;
        for (octets[1..]) |octet| {
            if (!isDecimalIpv4Octet(octet)) return null;
        }

        return .{ .octets = octets };
    }
};

const GitHubActionsRunSegment = enum {
    actions,
    runs,

    fn text(self: GitHubActionsRunSegment) []const u8 {
        return switch (self) {
            .actions => "actions",
            .runs => "runs",
        };
    }

    fn matches(self: GitHubActionsRunSegment, value: []const u8) bool {
        return std.mem.eql(u8, value, self.text());
    }
};

const GitHubActionsRunPath = struct {
    owner: []const u8,
    repo: []const u8,
    run_id: []const u8,
};

pub fn isDecimalId(value: []const u8) bool {
    return classifyDecimalId(value).accepts();
}

pub fn parseDecimalId(value: []const u8) ?u64 {
    return classifyDecimalId(value).valueOrNull();
}

pub fn classifyDecimalId(value: []const u8) DecimalIdValidation {
    if (value.len == 0) return .empty;
    if (value.len > max_decimal_id_digits) return .oversized;
    if (value.len > 1 and value[0] == '0') return .leading_zero;

    var parsed: u64 = 0;
    for (value, 0..) |byte, index| {
        const digit: u64 = @intCast(decimalValue(byte) orelse return .{ .invalid_digit = index });
        const shifted = std.math.mul(u64, parsed, 10) catch return .overflow;
        parsed = std.math.add(u64, shifted, digit) catch return .overflow;
    }

    return if (parsed > 0) .{ .safe = parsed } else .zero;
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

pub fn isRepositoryOwner(value: []const u8) bool {
    return repository_safety.isOwnerSegment(value);
}

pub fn isRepositoryName(value: []const u8) bool {
    return repository_safety.isRepoSegment(value);
}

pub fn isHttpUrlBase(value: []const u8) bool {
    const parsed = parseHttpUrlParts(value) orelse return false;
    if (parsed.tail.len != 0) return false;

    return isAllowedHttpAuthority(parsed.scheme, parsed.authority);
}

pub fn isHttpUrl(value: []const u8, max_len: usize) bool {
    return parseSafeHttpUrl(value, max_len) != null;
}

pub fn isGitHubActionsRunUrl(value: []const u8, max_len: usize) bool {
    const parsed = parseSafeHttpUrl(value, max_len) orelse return false;
    return isGitHubActionsRunUrlTail(parsed.tail);
}

pub fn isGitHubDotComActionsRunUrl(value: []const u8, max_len: usize) bool {
    const parsed = parseSafeHttpUrl(value, max_len) orelse return false;
    return parsed.scheme == .https and isGitHubDotComAuthority(parsed.authority) and
        isGitHubActionsRunUrlTail(parsed.tail);
}

fn parseSafeHttpUrl(value: []const u8, max_len: usize) ?ParsedHttpUrlParts {
    if (!isSafeSingleLineText(value, max_len)) return null;
    for (value) |byte| {
        if (byte == ' ') return null;
    }

    const parsed = parseHttpUrlParts(value) orelse return null;
    if (!isAllowedHttpAuthority(parsed.scheme, parsed.authority)) return null;
    if (!isSafeHttpUrlTail(parsed.tail)) return null;

    return parsed;
}

fn parseHttpPrefix(value: []const u8) ?ParsedHttpUrl {
    for (http_schemes) |scheme| {
        const prefix = scheme.prefix();
        if (std.mem.startsWith(u8, value, prefix)) {
            return .{
                .scheme = scheme,
                .rest = value[prefix.len..],
            };
        }
    }

    return null;
}

fn parseHttpUrlParts(value: []const u8) ?ParsedHttpUrlParts {
    const parsed = parseHttpPrefix(value) orelse return null;
    const authority_len = std.mem.indexOfAny(u8, parsed.rest, "/?#") orelse parsed.rest.len;

    return .{
        .scheme = parsed.scheme,
        .authority = parsed.rest[0..authority_len],
        .tail = parsed.rest[authority_len..],
    };
}

const HostPort = struct {
    host: []const u8,
    port: ?[]const u8 = null,
};

const AuthorityForm = enum {
    bracketed_host,
    plain_host,

    fn fromAuthority(authority: []const u8) AuthorityForm {
        return if (std.mem.startsWith(u8, authority, "[")) .bracketed_host else .plain_host;
    }
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

fn isGitHubDotComAuthority(authority: []const u8) bool {
    const host_port = splitHostPort(authority) orelse return false;
    if (host_port.port != null) return false;
    const kind = classifyHost(host_port.host) orelse return false;
    return kind == .github_dot_com;
}

fn isAllowedHttpAuthority(scheme: HttpScheme, authority: []const u8) bool {
    if (!isHttpAuthority(authority)) return false;
    return scheme == .https or isLoopbackAuthority(authority);
}

fn splitHostPort(authority: []const u8) ?HostPort {
    return switch (AuthorityForm.fromAuthority(authority)) {
        .bracketed_host => splitBracketedHostPort(authority),
        .plain_host => splitPlainHostPort(authority),
    };
}

fn splitBracketedHostPort(authority: []const u8) ?HostPort {
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

fn splitPlainHostPort(authority: []const u8) ?HostPort {
    const separator = std.mem.lastIndexOfScalar(u8, authority, ':') orelse return .{ .host = authority };
    const host = authority[0..separator];
    if (std.mem.indexOfScalar(u8, host, ':') != null) return null;

    return .{
        .host = host,
        .port = authority[separator + 1 ..],
    };
}

fn isSafeHost(host: []const u8) bool {
    return classifyHost(host) != null;
}

fn classifyHost(host: []const u8) ?HostKind {
    if (host.len == 0 or host.len > max_host_bytes) return null;
    if (KnownHostLiteral.github_dot_com.matches(host)) return .github_dot_com;
    if (KnownHostLiteral.localhost.matches(host)) return .localhost;
    if (KnownHostLiteral.loopback_ipv6.matches(host)) return .loopback_ipv6;
    if (isLoopbackIpv4(host)) return .loopback_ipv4;
    if (!isSafeDomainHost(host)) return null;
    return .domain;
}

fn isSafeDomainHost(host: []const u8) bool {
    var labels = std.mem.splitScalar(u8, host, '.');
    while (labels.next()) |label| {
        if (!isSafeHostLabel(label)) return false;
    }

    return true;
}

fn isLoopbackHost(host: []const u8) bool {
    const kind = classifyHost(host) orelse return false;
    return kind.isLoopback();
}

fn isLoopbackIpv4(host: []const u8) bool {
    return LoopbackIpv4Address.parse(host) != null;
}

fn isLoopbackIpv6(host: []const u8) bool {
    return KnownHostLiteral.loopback_ipv6.matches(host);
}

fn isDecimalIpv4Octet(value: []const u8) bool {
    return parseCanonicalDecimal(u8, value, 3) != null;
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
    const parsed = parseCanonicalDecimal(u16, port, max_port_digits) orelse return false;
    return parsed > 0;
}

fn isSafeHttpUrlTail(value: []const u8) bool {
    return classifyHttpUrlTail(value).accepts();
}

fn classifyHttpUrlTail(value: []const u8) HttpUrlTailValidation {
    if (value.len > 0 and value[0] != '/') return .invalid_prefix;

    var index: usize = 0;
    while (index < value.len) {
        const byte = value[index];
        if (std.ascii.isAlphabetic(byte) or std.ascii.isDigit(byte)) {
            index += 1;
            continue;
        }

        switch (byte) {
            '%' => {
                switch (classifyPercentEncodedByte(value, index)) {
                    .safe => {},
                    .truncated, .invalid_hex => return .{ .invalid_percent_encoding = index },
                    .control => return .{ .percent_encoded_control = index },
                }
                index += 3;
                continue;
            },
            '-', '.', '_', '~', '!', '$', '&', '(', ')', '*', '+', ',', ';', '=', ':', '@', '/', '?' => {},
            else => return .{ .invalid_character = index },
        }
        index += 1;
    }

    if (firstUnsafeHttpPathSegment(value)) |segment_start| {
        return .{ .unsafe_path_segment = segment_start };
    }

    return .safe;
}

fn isGitHubActionsRunUrlTail(value: []const u8) bool {
    return parseGitHubActionsRunUrlTail(value) != null;
}

fn parseGitHubActionsRunUrlTail(value: []const u8) ?GitHubActionsRunPath {
    if (value.len == 0 or value[0] != '/') return null;
    if (std.mem.indexOfAny(u8, value, "?#") != null) return null;

    const path = value[1..];

    var segments = std.mem.splitScalar(u8, path, '/');
    const owner = segments.next() orelse return null;
    const repo = segments.next() orelse return null;
    const actions = segments.next() orelse return null;
    const runs = segments.next() orelse return null;
    const run_id = segments.next() orelse return null;

    if (segments.next() != null) return null;
    if (!isRepositoryOwner(owner)) return null;
    if (!isRepositoryName(repo)) return null;
    if (!GitHubActionsRunSegment.actions.matches(actions)) return null;
    if (!GitHubActionsRunSegment.runs.matches(runs)) return null;
    if (!isDecimalId(run_id)) return null;

    return .{
        .owner = owner,
        .repo = repo,
        .run_id = run_id,
    };
}

fn hasUnsafeHttpUrlPathSyntax(value: []const u8) bool {
    return firstUnsafeHttpPathSegment(value) != null;
}

fn firstUnsafeHttpPathSegment(value: []const u8) ?usize {
    if (value.len == 0 or value[0] != '/') return null;

    const path_end = std.mem.indexOfScalar(u8, value, '?') orelse value.len;
    const path = value[0..path_end];
    var segment_start: usize = 1;

    for (path[1..], 1..) |byte, index| {
        if (byte != '/') continue;
        if (isUnsafeHttpPathSegment(path[segment_start..index])) return segment_start;
        segment_start = index + 1;
    }

    return if (isUnsafeHttpPathSegment(path[segment_start..])) segment_start else null;
}

fn isUnsafeHttpPathSegment(segment: []const u8) bool {
    if (segment.len == 0) return true;
    return isDotHttpPathSegment(segment);
}

fn isDotHttpPathSegment(segment: []const u8) bool {
    var dots: usize = 0;
    var index: usize = 0;

    while (index < segment.len) {
        if (segment[index] == '.') {
            dots += 1;
            index += 1;
            continue;
        }

        if (isEncodedDot(segment, index)) {
            dots += 1;
            index += 3;
            continue;
        }

        return false;
    }

    return dots == 1 or dots == 2;
}

fn isEncodedDot(value: []const u8, index: usize) bool {
    return index + 2 < value.len and
        value[index] == '%' and
        value[index + 1] == '2' and
        std.ascii.toLower(value[index + 2]) == 'e';
}

fn isSafePercentEncodedByte(value: []const u8, index: usize) bool {
    return classifyPercentEncodedByte(value, index).accepts();
}

fn classifyPercentEncodedByte(value: []const u8, index: usize) PercentEncodedByteValidation {
    if (index + 2 >= value.len) return .truncated;
    const decoded = decodePercentEncodedByte(value[index + 1], value[index + 2]) orelse return .invalid_hex;
    return if (text_safety.isControlByte(decoded)) .control else .safe;
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

fn parseCanonicalDecimal(comptime T: type, value: []const u8, max_digits: usize) ?T {
    if (!isCanonicalDecimalText(value, max_digits)) return null;

    var parsed: T = 0;
    for (value) |byte| {
        const digit: T = @intCast(decimalValue(byte).?);
        const shifted = std.math.mul(T, parsed, 10) catch return null;
        parsed = std.math.add(T, shifted, digit) catch return null;
    }

    return parsed;
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

test "action values classify decimal ids" {
    try expectDecimalIdSafe(1, "1");
    try expectDecimalIdSafe(123456789, "123456789");
    try expectDecimalIdSafe(18446744073709551615, "18446744073709551615");
    try expectDecimalIdValidation(.empty, "");
    try expectDecimalIdValidation(.zero, "0");
    try expectDecimalIdValidation(.leading_zero, "01");
    try expectDecimalIdValidation(.oversized, "1" ** 100);
    try expectDecimalIdValidation(.overflow, "18446744073709551616");
    try expectDecimalIdInvalidDigit("12a", 2);

    try std.testing.expect((DecimalIdValidation{ .safe = 1 }).accepts());
    try std.testing.expect(!(DecimalIdValidation{ .zero = {} }).accepts());
    try std.testing.expect(!(DecimalIdValidation{ .invalid_digit = 0 }).accepts());
    try std.testing.expectEqual(@as(?u64, 1), (DecimalIdValidation{ .safe = 1 }).valueOrNull());
    try std.testing.expectEqual(@as(?u64, null), (DecimalIdValidation{ .overflow = {} }).valueOrNull());
}

fn expectDecimalIdSafe(expected: u64, value: []const u8) !void {
    switch (classifyDecimalId(value)) {
        .safe => |actual| try std.testing.expectEqual(expected, actual),
        else => return error.ExpectedDecimalId,
    }
}

fn expectDecimalIdValidation(expected: std.meta.Tag(DecimalIdValidation), value: []const u8) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyDecimalId(value)));
}

fn expectDecimalIdInvalidDigit(value: []const u8, expected_index: usize) !void {
    switch (classifyDecimalId(value)) {
        .invalid_digit => |index| try std.testing.expectEqual(expected_index, index),
        else => return error.ExpectedInvalidDigit,
    }
}

test "action values validate repository slugs" {
    try std.testing.expect(isRepositorySlug("nullclaw/nullbuilder"));
    try std.testing.expect(isRepositorySlug("null-claw/null.builder"));
    try std.testing.expect(isRepositoryOwner("null-claw"));
    try std.testing.expect(isRepositoryName("null.builder"));

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
    try std.testing.expect(!isRepositoryOwner("null_claw"));
    try std.testing.expect(!isRepositoryName(".hidden"));
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
    try std.testing.expect(!isHttpUrlBase("http://127.0.0.256"));
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
    try std.testing.expect(!isHttpUrlBase("https://github.com#fragment"));
    try std.testing.expect(!isHttpUrlBase("https://github.com\n"));
    try std.testing.expect(!isHttpUrlBase("https://github.com@evil.example"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:abc"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:443:evil"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:0"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:0443"));
    try std.testing.expect(isHttpUrlBase("https://github.com:65535"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:65536"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:123456"));
    try std.testing.expect(!isHttpUrlBase("https://github.com:" ++ ("1" ** 100)));
}

test "action values classify HTTP hosts and exact GitHub authority" {
    try std.testing.expectEqual(HostKind.github_dot_com, classifyHost("github.com").?);
    try std.testing.expectEqual(HostKind.domain, classifyHost("GitHub.com").?);
    try std.testing.expectEqual(HostKind.localhost, classifyHost("localhost").?);
    try std.testing.expectEqual(HostKind.localhost, classifyHost("LOCALHOST").?);
    try std.testing.expectEqual(HostKind.loopback_ipv4, classifyHost("127.0.0.1").?);
    try std.testing.expectEqual(HostKind.loopback_ipv6, classifyHost("[::1]").?);
    try std.testing.expectEqual(HostKind.domain, classifyHost("github.example.test").?);
    try std.testing.expect(classifyHost("[::2]") == null);

    const loopback_ipv4 = LoopbackIpv4Address.parse("127.0.0.1") orelse return error.ExpectedLoopbackIpv4;
    try std.testing.expectEqualStrings("127", loopback_ipv4.octets[0]);
    try std.testing.expectEqualStrings("0", loopback_ipv4.octets[1]);
    try std.testing.expectEqualStrings("0", loopback_ipv4.octets[2]);
    try std.testing.expectEqualStrings("1", loopback_ipv4.octets[3]);
    for ([_][]const u8{
        "126.0.0.1",
        "127.0.0",
        "127.0.0.1.1",
        "127.0.0.01",
        "127.0.0.256",
    }) |host| {
        try std.testing.expect(LoopbackIpv4Address.parse(host) == null);
    }

    try std.testing.expect(HostKind.localhost.isLoopback());
    try std.testing.expect(HostKind.loopback_ipv4.isLoopback());
    try std.testing.expect(HostKind.loopback_ipv6.isLoopback());
    try std.testing.expect(!HostKind.github_dot_com.isLoopback());
    try std.testing.expect(!HostKind.domain.isLoopback());

    try std.testing.expect(isGitHubDotComAuthority("github.com"));
    try std.testing.expect(!isGitHubDotComAuthority("GitHub.com"));
    try std.testing.expect(!isGitHubDotComAuthority("github.com:443"));
    try std.testing.expect(!isGitHubDotComAuthority("github.com.evil.example"));
}

test "action values split HTTP authority forms explicitly" {
    try std.testing.expectEqual(AuthorityForm.plain_host, AuthorityForm.fromAuthority("github.com:443"));
    try std.testing.expectEqual(AuthorityForm.bracketed_host, AuthorityForm.fromAuthority("[::1]:8080"));

    const plain = splitHostPort("github.com:443") orelse return error.ExpectedAuthority;
    try std.testing.expectEqualStrings("github.com", plain.host);
    try std.testing.expectEqualStrings("443", plain.port.?);

    const plain_without_port = splitHostPort("github.com") orelse return error.ExpectedAuthority;
    try std.testing.expectEqualStrings("github.com", plain_without_port.host);
    try std.testing.expect(plain_without_port.port == null);

    const bracketed = splitHostPort("[::1]:8080") orelse return error.ExpectedAuthority;
    try std.testing.expectEqualStrings("[::1]", bracketed.host);
    try std.testing.expectEqualStrings("8080", bracketed.port.?);

    const bracketed_without_port = splitHostPort("[::1]") orelse return error.ExpectedAuthority;
    try std.testing.expectEqualStrings("[::1]", bracketed_without_port.host);
    try std.testing.expect(bracketed_without_port.port == null);

    try std.testing.expect(splitHostPort("[::1") == null);
    try std.testing.expect(splitHostPort("[::1]evil") == null);
    try std.testing.expect(splitHostPort("github.com:443:evil") == null);
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

test "action values map HTTP schemes to canonical URL prefixes" {
    try std.testing.expectEqual(@as(usize, 2), http_schemes.len);
    for (http_schemes) |scheme| {
        const sample_url = switch (scheme) {
            .https => "https://github.com",
            .http => "http://github.com",
        };
        const parsed = parseHttpPrefix(sample_url) orelse return error.ExpectedHttpScheme;
        try std.testing.expectEqual(scheme, parsed.scheme);
        try std.testing.expectEqualStrings("github.com", parsed.rest);
    }

    try std.testing.expect(parseHttpPrefix("github.com") == null);
    try std.testing.expect(parseHttpPrefix("https:/github.com") == null);
    try std.testing.expect(parseHttpPrefix("httpx://github.com") == null);
}

test "action values parse safe HTTP URL components at the validation boundary" {
    const parsed = parseSafeHttpUrl(
        "https://github.com:8443/nullclaw/nullbuilder/actions/runs/123?check=true",
        256,
    ) orelse return error.ExpectedSafeHttpUrl;

    try std.testing.expectEqual(HttpScheme.https, parsed.scheme);
    try std.testing.expectEqualStrings("github.com:8443", parsed.authority);
    try std.testing.expectEqualStrings("/nullclaw/nullbuilder/actions/runs/123?check=true", parsed.tail);

    try std.testing.expect(parseSafeHttpUrl("http://github.example.local/runs/1", 256) == null);
    try std.testing.expect(parseSafeHttpUrl("https://github.com/actions//runs/123", 256) == null);
    try std.testing.expect(parseSafeHttpUrl("https://github.com/actions/runs/123%0a", 256) == null);
    try std.testing.expect(parseSafeHttpUrl("https://github.com/runs/1", 10) == null);
}

test "action values classify safe HTTP URL tails" {
    try expectHttpUrlTailValidation(.safe, "");
    try expectHttpUrlTailValidation(.safe, "/actions/runs/123");
    try expectHttpUrlTailValidation(.safe, "/actions/runs/123?name=check%20suite&step=1");
    try expectHttpUrlTailValidation(.invalid_prefix, "?query=1");
    try expectHttpUrlTailValidation(.invalid_prefix, "#fragment");

    const space_tail = "/path with spaces";
    try expectHttpUrlTailIndex(.invalid_character, space_tail, std.mem.indexOfScalar(u8, space_tail, ' ').?);

    const truncated_percent = "/actions/runs/123%";
    try expectHttpUrlTailIndex(
        .invalid_percent_encoding,
        truncated_percent,
        std.mem.indexOfScalar(u8, truncated_percent, '%').?,
    );

    const invalid_percent = "/actions/runs/123%zz";
    try expectHttpUrlTailIndex(
        .invalid_percent_encoding,
        invalid_percent,
        std.mem.indexOfScalar(u8, invalid_percent, '%').?,
    );

    const control_percent = "/actions/runs/123%0a";
    try expectHttpUrlTailIndex(
        .percent_encoded_control,
        control_percent,
        std.mem.indexOfScalar(u8, control_percent, '%').?,
    );

    try expectHttpUrlTailIndex(.unsafe_path_segment, "/actions//runs", 9);
    try expectHttpUrlTailIndex(.unsafe_path_segment, "/actions/%2e/runs", 9);

    try std.testing.expect((HttpUrlTailValidation{ .safe = {} }).accepts());
    try std.testing.expect(!(HttpUrlTailValidation{ .invalid_prefix = {} }).accepts());
    try std.testing.expect(!(HttpUrlTailValidation{ .unsafe_path_segment = 1 }).accepts());
}

fn expectHttpUrlTailValidation(expected: std.meta.Tag(HttpUrlTailValidation), value: []const u8) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyHttpUrlTail(value)));
}

fn expectHttpUrlTailIndex(
    expected: std.meta.Tag(HttpUrlTailValidation),
    value: []const u8,
    expected_index: usize,
) !void {
    const actual = classifyHttpUrlTail(value);
    try std.testing.expectEqual(expected, std.meta.activeTag(actual));
    const actual_index = switch (actual) {
        .invalid_character => |index| index,
        .invalid_percent_encoding => |index| index,
        .percent_encoded_control => |index| index,
        .unsafe_path_segment => |index| index,
        else => return error.ExpectedHttpUrlTailIndex,
    };
    try std.testing.expectEqual(expected_index, actual_index);
}

test "action values classify percent-encoded URL bytes" {
    try expectPercentEncodedByteValidation(.safe, "%20", 0);
    try expectPercentEncodedByteValidation(.truncated, "%", 0);
    try expectPercentEncodedByteValidation(.truncated, "%2", 0);
    try expectPercentEncodedByteValidation(.invalid_hex, "%zz", 0);
    try expectPercentEncodedByteValidation(.control, "%0a", 0);
    try expectPercentEncodedByteValidation(.control, "%85", 0);

    try std.testing.expect(PercentEncodedByteValidation.safe.accepts());
    try std.testing.expect(!PercentEncodedByteValidation.truncated.accepts());
    try std.testing.expect(!PercentEncodedByteValidation.control.accepts());
}

fn expectPercentEncodedByteValidation(
    expected: PercentEncodedByteValidation,
    value: []const u8,
    index: usize,
) !void {
    try std.testing.expectEqual(expected, classifyPercentEncodedByte(value, index));
}

test "action values validate HTTP URLs with paths" {
    try std.testing.expect(isHttpUrl("https://github.com", 256));
    try std.testing.expect(isHttpUrl("http://localhost", 256));
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
    try std.testing.expect(!isHttpUrl("https://github.com:443:evil/runs/1", 256));
    try std.testing.expect(!isHttpUrl("https://github.com:0443/runs/1", 256));
    try std.testing.expect(!isHttpUrl("http://127.0.0.1:08080/runs/1", 256));
    try std.testing.expect(!isHttpUrl("https://github.com?query=secret", 256));
    try std.testing.expect(!isHttpUrl("https://github.com#fragment", 256));
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
    try std.testing.expect(!isHttpUrl("https://github.com/actions//runs/123", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/./runs/123", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/../runs/123", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/%2e/runs/123", 256));
    try std.testing.expect(!isHttpUrl("https://github.com/actions/%2E%2e/runs/123", 256));
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

test "action values parse GitHub Actions run URL tail components" {
    try std.testing.expect(GitHubActionsRunSegment.actions.matches("actions"));
    try std.testing.expect(GitHubActionsRunSegment.runs.matches("runs"));
    try std.testing.expect(!GitHubActionsRunSegment.actions.matches("runs"));

    const run_path = parseGitHubActionsRunUrlTail("/nullclaw/nullbuilder/actions/runs/123") orelse return error.ExpectedRunPath;
    try std.testing.expectEqualStrings("nullclaw", run_path.owner);
    try std.testing.expectEqualStrings("nullbuilder", run_path.repo);
    try std.testing.expectEqualStrings("123", run_path.run_id);

    for ([_][]const u8{
        "",
        "nullclaw/nullbuilder/actions/runs/123",
        "/nullclaw/nullbuilder/actions/runs/0",
        "/nullclaw/nullbuilder/actions/jobs/123",
        "/nullclaw/nullbuilder/actions/runs/123/extra",
        "/null_claw/nullbuilder/actions/runs/123",
        "/nullclaw/.hidden/actions/runs/123",
        "/nullclaw/nullbuilder/actions/runs/123?check_suite_focus=true",
        "/nullclaw/nullbuilder/actions/runs/123#summary",
    }) |tail| {
        try std.testing.expect(parseGitHubActionsRunUrlTail(tail) == null);
    }
}

test "action values validate GitHub Actions run URLs" {
    try std.testing.expect(isGitHubActionsRunUrl("https://github.com/nullclaw/nullbuilder/actions/runs/123", 256));
    try std.testing.expect(isGitHubActionsRunUrl("https://github.example.test/nullclaw/nullbuilder/actions/runs/123", 256));
    try std.testing.expect(isGitHubActionsRunUrl("http://localhost/nullclaw/nullbuilder/actions/runs/123", 256));
    try std.testing.expect(isGitHubDotComActionsRunUrl("https://github.com/nullclaw/nullbuilder/actions/runs/123", 256));

    try std.testing.expect(!isGitHubActionsRunUrl("https://github.com/nullclaw/nullbuilder/actions/runs/0", 256));
    try std.testing.expect(!isGitHubActionsRunUrl("https://github.com/null_claw/nullbuilder/actions/runs/123", 256));
    try std.testing.expect(!isGitHubActionsRunUrl("https://github.com/nullclaw/.hidden/actions/runs/123", 256));
    try std.testing.expect(!isGitHubActionsRunUrl("https://github.com/nullclaw/nullbuilder/actions/jobs/123", 256));
    try std.testing.expect(!isGitHubActionsRunUrl("https://github.com/nullclaw/nullbuilder/actions/runs/123/extra", 256));
    try std.testing.expect(!isGitHubActionsRunUrl("https://github.com/nullclaw/nullbuilder/actions/runs/123?check_suite_focus=true", 256));
    try std.testing.expect(!isGitHubActionsRunUrl("https://github.com/nullclaw/nullbuilder/actions/runs/123#summary", 256));
    try std.testing.expect(!isGitHubActionsRunUrl("https://github.com/nullclaw/nullbuilder/actions/runs/123", 32));

    try std.testing.expect(!isGitHubDotComActionsRunUrl("https://github.example.test/nullclaw/nullbuilder/actions/runs/123", 256));
    try std.testing.expect(!isGitHubDotComActionsRunUrl("https://github.com.evil.example/nullclaw/nullbuilder/actions/runs/123", 256));
    try std.testing.expect(!isGitHubDotComActionsRunUrl("https://github.com:443/nullclaw/nullbuilder/actions/runs/123", 256));
    try std.testing.expect(!isGitHubDotComActionsRunUrl("http://localhost/nullclaw/nullbuilder/actions/runs/123", 256));
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
