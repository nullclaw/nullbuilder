const std = @import("std");
const text_safety = @import("text_safety");

pub const max_owner_segment_bytes = 39;
pub const max_repo_segment_bytes = 100;
pub const max_repository_slug_bytes = max_owner_segment_bytes + 1 + max_repo_segment_bytes;

const RepositorySlugParts = struct {
    owner: []const u8,
    repo: []const u8,
};

const RepositorySlugShape = union(enum) {
    parts: RepositorySlugParts,
    empty,
    oversized,
    missing_separator,
    empty_owner,
    empty_repo,
    extra_separator,
};

pub fn isRepositorySlug(value: []const u8) bool {
    return parseRepositorySlug(value) != null;
}

fn parseRepositorySlug(value: []const u8) ?RepositorySlugParts {
    const shape = classifyRepositorySlugShape(value);
    const parts = switch (shape) {
        .parts => |parts| parts,
        else => return null,
    };

    return if (isOwnerSegment(parts.owner) and isRepoSegment(parts.repo)) parts else null;
}

fn classifyRepositorySlugShape(value: []const u8) RepositorySlugShape {
    if (value.len == 0) return .empty;
    if (value.len > max_repository_slug_bytes) return .oversized;

    const slash_index = std.mem.indexOfScalar(u8, value, '/') orelse return .missing_separator;
    if (slash_index == 0) return .empty_owner;
    if (slash_index == value.len - 1) return .empty_repo;
    if (std.mem.indexOfScalar(u8, value[slash_index + 1 ..], '/') != null) return .extra_separator;

    return .{ .parts = .{
        .owner = value[0..slash_index],
        .repo = value[slash_index + 1 ..],
    } };
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
    if (text_safety.endsWithAsciiIgnoreCase(value, ".git")) return false;

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

test "repository safety validates repository slugs" {
    try std.testing.expect(isRepositorySlug("nullclaw/nullbuilder"));
    try std.testing.expect(isRepositorySlug("NullClaw/null_Pantry-2"));
    try std.testing.expect(isRepositorySlug("null-claw/null.builder"));
    try std.testing.expect(isRepositorySlug(("a" ** max_owner_segment_bytes) ++ "/" ++ ("b" ** max_repo_segment_bytes)));

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
    try std.testing.expect(!isRepositorySlug(("a" ** max_owner_segment_bytes) ++ "/" ++ ("b" ** max_repo_segment_bytes) ++ "x"));
    try std.testing.expect(!isRepositorySlug("nullclaw/nullbuilder.git"));
    try std.testing.expect(!isRepositorySlug("nullclaw/nullbuilder.GIT"));
}

test "repository safety classifies repository slug shape before validating segments" {
    switch (classifyRepositorySlugShape("nullclaw/nullbuilder")) {
        .parts => |parts| {
            try std.testing.expectEqualStrings("nullclaw", parts.owner);
            try std.testing.expectEqualStrings("nullbuilder", parts.repo);
        },
        else => return error.ExpectedRepositorySlugParts,
    }

    try expectRepositorySlugShape(.empty, "");
    try expectRepositorySlugShape(.missing_separator, "nullbuilder");
    try expectRepositorySlugShape(.empty_owner, "/nullbuilder");
    try expectRepositorySlugShape(.empty_repo, "nullclaw/");
    try expectRepositorySlugShape(.extra_separator, "nullclaw/nullbuilder/extra");
    try expectRepositorySlugShape(
        .oversized,
        ("a" ** max_owner_segment_bytes) ++ "/" ++ ("b" ** max_repo_segment_bytes) ++ "x",
    );

    switch (classifyRepositorySlugShape("owner_name/nullbuilder")) {
        .parts => |parts| {
            try std.testing.expect(!isOwnerSegment(parts.owner));
            try std.testing.expect(isRepoSegment(parts.repo));
        },
        else => return error.ExpectedRepositorySlugParts,
    }
}

fn expectRepositorySlugShape(expected: std.meta.Tag(RepositorySlugShape), value: []const u8) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyRepositorySlugShape(value)));
}
