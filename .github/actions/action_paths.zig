const std = @import("std");
const text_safety = @import("text_safety");

pub const MAX_LABEL_BYTES = 128;
pub const MAX_RELATIVE_PATH_BYTES = 1024;

pub const LabelValidation = enum {
    safe,
    empty,
    oversized,
    windows_reserved,
    invalid_character,
    leading_symbol,
    repeated_dot,
    trailing_dot,

    pub fn accepts(self: LabelValidation) bool {
        return self == .safe;
    }
};

pub const RelativePathSegment = enum {
    safe_label,
    empty,
    current_dir,
    parent_dir,
    unsafe_label,
};

pub const InvalidRelativePathSegment = struct {
    start: usize,
    validation: RelativePathSegment,
};

pub const RelativePathValidation = union(enum) {
    safe,
    empty,
    oversized,
    absolute_path,
    backslash: usize,
    windows_drive_prefix,
    invalid_segment: InvalidRelativePathSegment,

    pub fn accepts(self: RelativePathValidation) bool {
        return switch (self) {
            .safe => true,
            else => false,
        };
    }
};

fn isAsciiAlpha(byte: u8) bool {
    return (byte >= 'a' and byte <= 'z') or (byte >= 'A' and byte <= 'Z');
}

fn isAsciiDigit(byte: u8) bool {
    return byte >= '0' and byte <= '9';
}

pub fn isSafeLabel(value: []const u8) bool {
    return classifyLabel(value).accepts();
}

pub fn classifyLabel(value: []const u8) LabelValidation {
    if (value.len == 0) return .empty;
    if (value.len > MAX_LABEL_BYTES) return .oversized;
    if (isWindowsReservedDeviceName(value)) return .windows_reserved;

    var previous_dot = false;
    for (value, 0..) |byte, index| {
        const is_alpha = isAsciiAlpha(byte);
        const is_digit = isAsciiDigit(byte);
        const is_safe_symbol = byte == '.' or byte == '_' or byte == '-';

        if (!is_alpha and !is_digit and !is_safe_symbol) return .invalid_character;
        if (index == 0 and !is_alpha and !is_digit) return .leading_symbol;
        if (byte == '.' and previous_dot) return .repeated_dot;
        previous_dot = byte == '.';
    }

    return if (previous_dot) .trailing_dot else .safe;
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
    return classifyRelativePath(path).accepts();
}

pub fn classifyRelativePath(path: []const u8) RelativePathValidation {
    if (path.len == 0) return .empty;
    if (path.len > MAX_RELATIVE_PATH_BYTES) return .oversized;
    if (path[0] == '/') return .absolute_path;
    if (std.mem.indexOfScalar(u8, path, '\\')) |index| return .{ .backslash = index };
    if (hasWindowsDrivePrefix(path)) return .windows_drive_prefix;

    var segment_start: usize = 0;
    while (segment_start <= path.len) {
        const relative_end = std.mem.indexOfScalar(u8, path[segment_start..], '/') orelse path.len - segment_start;
        const segment_end = segment_start + relative_end;
        const validation = classifyRelativePathSegment(path[segment_start..segment_end]);
        if (validation != .safe_label) {
            return .{ .invalid_segment = .{
                .start = segment_start,
                .validation = validation,
            } };
        }
        if (segment_end == path.len) break;
        segment_start = segment_end + 1;
    }

    return .safe;
}

fn classifyRelativePathSegment(segment: []const u8) RelativePathSegment {
    if (segment.len == 0) return .empty;
    if (std.mem.eql(u8, segment, ".")) return .current_dir;
    if (std.mem.eql(u8, segment, "..")) return .parent_dir;
    return if (classifyLabel(segment).accepts()) .safe_label else .unsafe_label;
}

pub fn eqlSafeRelativePath(left: []const u8, right: []const u8) bool {
    return isSafeRelativePath(left) and isSafeRelativePath(right) and text_safety.eqlAsciiIgnoreCase(left, right);
}

test "action paths accepts safe labels" {
    try std.testing.expect(isSafeLabel("linux-x86_64"));
    try std.testing.expect(isSafeLabel("nullclaw-linux-x86_64.exe"));
}

test "action paths rejects unsafe labels" {
    const oversized_label = [_]u8{'a'} ** (MAX_LABEL_BYTES + 1);

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

test "action paths classify safe labels" {
    const oversized_label = [_]u8{'a'} ** (MAX_LABEL_BYTES + 1);

    try std.testing.expectEqual(LabelValidation.safe, classifyLabel("linux-x86_64"));
    try std.testing.expectEqual(LabelValidation.empty, classifyLabel(""));
    try std.testing.expectEqual(LabelValidation.oversized, classifyLabel(oversized_label[0..]));
    try std.testing.expectEqual(LabelValidation.windows_reserved, classifyLabel("CON"));
    try std.testing.expectEqual(LabelValidation.windows_reserved, classifyLabel("nul.txt"));
    try std.testing.expectEqual(LabelValidation.invalid_character, classifyLabel("linux/amd64"));
    try std.testing.expectEqual(LabelValidation.leading_symbol, classifyLabel("-leading-dash"));
    try std.testing.expectEqual(LabelValidation.leading_symbol, classifyLabel(".hidden"));
    try std.testing.expectEqual(LabelValidation.repeated_dot, classifyLabel("double..dot"));
    try std.testing.expectEqual(LabelValidation.trailing_dot, classifyLabel("trailing."));

    try std.testing.expect(LabelValidation.safe.accepts());
    try std.testing.expect(!LabelValidation.windows_reserved.accepts());
}

test "action paths classify relative path segments before accepting paths" {
    try std.testing.expectEqual(RelativePathSegment.safe_label, classifyRelativePathSegment("nightly-artifacts"));
    try std.testing.expectEqual(RelativePathSegment.safe_label, classifyRelativePathSegment("nullclaw-linux-x86_64.exe"));
    try std.testing.expectEqual(RelativePathSegment.empty, classifyRelativePathSegment(""));
    try std.testing.expectEqual(RelativePathSegment.current_dir, classifyRelativePathSegment("."));
    try std.testing.expectEqual(RelativePathSegment.parent_dir, classifyRelativePathSegment(".."));
    try std.testing.expectEqual(RelativePathSegment.unsafe_label, classifyRelativePathSegment(".hidden"));
    try std.testing.expectEqual(RelativePathSegment.unsafe_label, classifyRelativePathSegment("CON"));
    try std.testing.expectEqual(RelativePathSegment.unsafe_label, classifyRelativePathSegment("linux/amd64"));
}

test "action paths accepts only safe relative paths" {
    const oversized_path = [_]u8{'a'} ** (MAX_RELATIVE_PATH_BYTES + 1);

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

test "action paths classify relative path validation outcomes" {
    const oversized_path = [_]u8{'a'} ** (MAX_RELATIVE_PATH_BYTES + 1);

    try expectRelativePathValidation(.safe, "previous-nightly-runs.json");
    try expectRelativePathValidation(.safe, "nightly-artifacts/nullclaw-linux-x86_64");
    try expectRelativePathValidation(.empty, "");
    try expectRelativePathValidation(.oversized, oversized_path[0..]);
    try expectRelativePathValidation(.absolute_path, "/tmp/nullclaw");
    try expectRelativePathValidation(.windows_drive_prefix, "C:/temp/nullclaw");
    try expectRelativePathBackslash("C:\\temp\\nullclaw", 2);
    try expectRelativePathSegment(.parent_dir, "../outside", 0);
    try expectRelativePathSegment(.parent_dir, "nightly-artifacts/../outside", 18);
    try expectRelativePathSegment(.empty, "nightly-artifacts//nullclaw", 18);
    try expectRelativePathSegment(.unsafe_label, "nightly-artifacts/.hidden", 18);
    try expectRelativePathSegment(.unsafe_label, "nightly-artifacts/nullclaw.", 18);
    try expectRelativePathSegment(.unsafe_label, "nightly-artifacts/CON", 18);

    try std.testing.expect((RelativePathValidation{ .safe = {} }).accepts());
    try std.testing.expect(!(RelativePathValidation{ .absolute_path = {} }).accepts());
    try std.testing.expect(!(RelativePathValidation{ .invalid_segment = .{
        .start = 0,
        .validation = .parent_dir,
    } }).accepts());
}

fn expectRelativePathValidation(expected: std.meta.Tag(RelativePathValidation), path: []const u8) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyRelativePath(path)));
}

fn expectRelativePathBackslash(path: []const u8, expected_index: usize) !void {
    switch (classifyRelativePath(path)) {
        .backslash => |index| try std.testing.expectEqual(expected_index, index),
        else => return error.ExpectedRelativePathBackslash,
    }
}

fn expectRelativePathSegment(expected: RelativePathSegment, path: []const u8, expected_start: usize) !void {
    switch (classifyRelativePath(path)) {
        .invalid_segment => |actual| {
            try std.testing.expectEqual(expected_start, actual.start);
            try std.testing.expectEqual(expected, actual.validation);
        },
        else => return error.ExpectedInvalidRelativePathSegment,
    }
}

test "action paths compare safe relative paths for case-insensitive filesystems" {
    try std.testing.expect(eqlSafeRelativePath(
        "nightly-artifacts/manifest-linux-x86_64.json",
        "Nightly-Artifacts/MANIFEST-linux-X86_64.JSON",
    ));
    try std.testing.expect(!eqlSafeRelativePath(
        "nightly-artifacts/manifest-linux-x86_64.json",
        "nightly-artifacts/manifest-linux-arm64.json",
    ));
    try std.testing.expect(!eqlSafeRelativePath("../manifest-linux-x86_64.json", "manifest-linux-x86_64.json"));
}
