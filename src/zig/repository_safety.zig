const std = @import("std");

pub const max_owner_segment_bytes = 39;
pub const max_repo_segment_bytes = 100;
pub const max_repository_slug_bytes = max_owner_segment_bytes + 1 + max_repo_segment_bytes;

pub fn isRepositorySlug(value: []const u8) bool {
    const slash_index = std.mem.indexOfScalar(u8, value, '/') orelse return false;
    if (slash_index == 0 or slash_index == value.len - 1) return false;
    if (std.mem.indexOfScalar(u8, value[slash_index + 1 ..], '/') != null) return false;

    return isOwnerSegment(value[0..slash_index]) and isRepoSegment(value[slash_index + 1 ..]);
}

pub fn isOwnerSegment(value: []const u8) bool {
    if (value.len == 0 or value.len > max_owner_segment_bytes) return false;

    for (value, 0..) |byte, index| {
        const is_alphanumeric = std.ascii.isAlphabetic(byte) or std.ascii.isDigit(byte);
        if (!is_alphanumeric and byte != '-') return false;
        if ((index == 0 or index == value.len - 1) and !is_alphanumeric) return false;
    }

    return true;
}

pub fn isRepoSegment(value: []const u8) bool {
    if (value.len == 0 or value.len > max_repo_segment_bytes) return false;
    if (endsWithAsciiIgnoreCase(value, ".git")) return false;

    var previous_dot = false;
    for (value, 0..) |byte, index| {
        const is_alphanumeric = std.ascii.isAlphabetic(byte) or std.ascii.isDigit(byte);
        const is_safe_symbol = byte == '.' or byte == '_' or byte == '-';
        if (!is_alphanumeric and !is_safe_symbol) return false;
        if (index == 0 and !is_alphanumeric) return false;
        if (byte == '.' and previous_dot) return false;
        previous_dot = byte == '.';
    }

    return !previous_dot;
}

fn endsWithAsciiIgnoreCase(value: []const u8, suffix: []const u8) bool {
    if (value.len < suffix.len) return false;

    const tail = value[value.len - suffix.len ..];
    for (tail, suffix) |left_byte, right_byte| {
        if (std.ascii.toLower(left_byte) != std.ascii.toLower(right_byte)) return false;
    }

    return true;
}

test "repository safety validates repository slugs" {
    try std.testing.expect(isRepositorySlug("nullclaw/nullbuilder"));
    try std.testing.expect(isRepositorySlug("NullClaw/null_Pantry-2"));
    try std.testing.expect(isRepositorySlug("null-claw/null.builder"));

    try std.testing.expect(!isRepositorySlug(""));
    try std.testing.expect(!isRepositorySlug("nullbuilder"));
    try std.testing.expect(!isRepositorySlug("/nullbuilder"));
    try std.testing.expect(!isRepositorySlug("nullclaw/"));
    try std.testing.expect(!isRepositorySlug("nullclaw/nullbuilder/extra"));
    try std.testing.expect(!isRepositorySlug("-owner/nullbuilder"));
    try std.testing.expect(!isRepositorySlug("owner-/nullbuilder"));
    try std.testing.expect(!isRepositorySlug("owner_name/nullbuilder"));
    try std.testing.expect(!isRepositorySlug("owner.name/nullbuilder"));
    try std.testing.expect(!isRepositorySlug("abcdefghijklmnopqrstuvwxyzabcdefghijklmn/nullbuilder"));
    try std.testing.expect(!isRepositorySlug("nullclaw/.hidden"));
    try std.testing.expect(!isRepositorySlug("nullclaw/trailing."));
    try std.testing.expect(!isRepositorySlug("nullclaw/double..dot"));
    try std.testing.expect(!isRepositorySlug("nullclaw/" ++ ("a" ** 101)));
    try std.testing.expect(!isRepositorySlug("nullclaw/nullbuilder.git"));
    try std.testing.expect(!isRepositorySlug("nullclaw/nullbuilder.GIT"));
}
