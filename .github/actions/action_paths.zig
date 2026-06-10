const std = @import("std");
const text_safety = @import("text_safety");

const max_label_bytes = 128;
const max_relative_path_bytes = 1024;

fn isAsciiAlpha(byte: u8) bool {
    return (byte >= 'a' and byte <= 'z') or (byte >= 'A' and byte <= 'Z');
}

fn isAsciiDigit(byte: u8) bool {
    return byte >= '0' and byte <= '9';
}

pub fn isSafeLabel(value: []const u8) bool {
    if (value.len == 0 or value.len > max_label_bytes) return false;
    if (isWindowsReservedDeviceName(value)) return false;

    var previous_dot = false;
    for (value, 0..) |byte, index| {
        const is_alpha = isAsciiAlpha(byte);
        const is_digit = isAsciiDigit(byte);
        const is_safe_symbol = byte == '.' or byte == '_' or byte == '-';

        if (!is_alpha and !is_digit and !is_safe_symbol) return false;
        if (index == 0 and !is_alpha and !is_digit) return false;
        if (byte == '.' and previous_dot) return false;
        previous_dot = byte == '.';
    }

    return !previous_dot;
}

fn isWindowsReservedDeviceName(value: []const u8) bool {
    const stem = std.mem.sliceTo(value, '.');

    if (text_safety.eqlAsciiIgnoreCase(stem, "con")) return true;
    if (text_safety.eqlAsciiIgnoreCase(stem, "prn")) return true;
    if (text_safety.eqlAsciiIgnoreCase(stem, "aux")) return true;
    if (text_safety.eqlAsciiIgnoreCase(stem, "nul")) return true;

    if (stem.len == 4 and (text_safety.eqlAsciiIgnoreCase(stem[0..3], "com") or text_safety.eqlAsciiIgnoreCase(stem[0..3], "lpt"))) {
        return stem[3] >= '1' and stem[3] <= '9';
    }

    return false;
}

fn hasWindowsDrivePrefix(path: []const u8) bool {
    return path.len >= 2 and isAsciiAlpha(path[0]) and path[1] == ':';
}

pub fn isSafeRelativePath(path: []const u8) bool {
    if (path.len == 0 or path.len > max_relative_path_bytes) return false;
    if (path[0] == '/') return false;
    if (std.mem.indexOfScalar(u8, path, '\\') != null) return false;
    if (hasWindowsDrivePrefix(path)) return false;

    var segments = std.mem.splitScalar(u8, path, '/');
    while (segments.next()) |segment| {
        if (std.mem.eql(u8, segment, ".")) return false;
        if (std.mem.eql(u8, segment, "..")) return false;
        if (!isSafeLabel(segment)) return false;
    }

    return true;
}

test "action paths accepts safe labels" {
    try std.testing.expect(isSafeLabel("linux-x86_64"));
    try std.testing.expect(isSafeLabel("nullclaw-linux-x86_64.exe"));
}

test "action paths rejects unsafe labels" {
    const oversized_label = [_]u8{'a'} ** (max_label_bytes + 1);

    try std.testing.expect(!isSafeLabel("../outside"));
    try std.testing.expect(!isSafeLabel("linux/amd64"));
    try std.testing.expect(!isSafeLabel(".."));
    try std.testing.expect(!isSafeLabel("-leading-dash"));
    try std.testing.expect(!isSafeLabel(".hidden"));
    try std.testing.expect(!isSafeLabel("trailing."));
    try std.testing.expect(!isSafeLabel("CON"));
    try std.testing.expect(!isSafeLabel("nul.txt"));
    try std.testing.expect(!isSafeLabel("COM1"));
    try std.testing.expect(!isSafeLabel("lpt9.log"));
    try std.testing.expect(!isSafeLabel(oversized_label[0..]));
    try std.testing.expect(isSafeLabel("com10"));
}

test "action paths accepts only safe relative paths" {
    const oversized_path = [_]u8{'a'} ** (max_relative_path_bytes + 1);

    try std.testing.expect(isSafeRelativePath("previous-nightly-runs.json"));
    try std.testing.expect(isSafeRelativePath("nightly-artifacts/nullclaw-linux-x86_64"));
    try std.testing.expect(isSafeRelativePath("nightly-artifacts/nullclaw-linux-x86_64.exe"));

    try std.testing.expect(!isSafeRelativePath(""));
    try std.testing.expect(!isSafeRelativePath("../outside"));
    try std.testing.expect(!isSafeRelativePath("nightly-artifacts/../outside"));
    try std.testing.expect(!isSafeRelativePath("/tmp/nullclaw"));
    try std.testing.expect(!isSafeRelativePath("C:/temp/nullclaw"));
    try std.testing.expect(!isSafeRelativePath("C:\\temp\\nullclaw"));
    try std.testing.expect(!isSafeRelativePath("nightly-artifacts//nullclaw"));
    try std.testing.expect(!isSafeRelativePath("nightly-artifacts/.hidden"));
    try std.testing.expect(!isSafeRelativePath("nightly-artifacts/nullclaw."));
    try std.testing.expect(!isSafeRelativePath("nightly-artifacts/CON"));
    try std.testing.expect(!isSafeRelativePath(oversized_path[0..]));
}
