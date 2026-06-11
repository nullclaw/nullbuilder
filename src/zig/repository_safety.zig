const std = @import("std");
const text_safety = @import("text_safety");

pub const max_owner_segment_bytes = 39;
pub const max_repo_segment_bytes = 100;
pub const max_repository_slug_bytes = max_owner_segment_bytes + 1 + max_repo_segment_bytes;

pub const RepositorySlugParts = struct {
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

pub const OwnerSegmentValidation = enum {
    safe,
    empty,
    oversized,
    invalid_character,
    invalid_edge,

    pub fn accepts(self: OwnerSegmentValidation) bool {
        return self == .safe;
    }
};

pub const RepoSegmentValidation = enum {
    safe,
    empty,
    oversized,
    git_suffix,
    leading_symbol,
    invalid_character,
    repeated_dot,
    trailing_dot,

    pub fn accepts(self: RepoSegmentValidation) bool {
        return self == .safe;
    }
};

pub const RepositorySlugValidation = union(enum) {
    safe: RepositorySlugParts,
    empty,
    oversized,
    missing_separator,
    empty_owner,
    empty_repo,
    extra_separator,
    invalid_owner: OwnerSegmentValidation,
    invalid_repo: RepoSegmentValidation,

    pub fn accepts(self: RepositorySlugValidation) bool {
        return switch (self) {
            .safe => true,
            else => false,
        };
    }
};

pub fn isRepositorySlug(value: []const u8) bool {
    return parseRepositorySlug(value) != null;
}

fn parseRepositorySlug(value: []const u8) ?RepositorySlugParts {
    return switch (classifyRepositorySlug(value)) {
        .safe => |parts| parts,
        else => null,
    };
}

pub fn classifyRepositorySlug(value: []const u8) RepositorySlugValidation {
    const shape = classifyRepositorySlugShape(value);
    const parts = switch (shape) {
        .parts => |parts| parts,
        .empty => return .empty,
        .oversized => return .oversized,
        .missing_separator => return .missing_separator,
        .empty_owner => return .empty_owner,
        .empty_repo => return .empty_repo,
        .extra_separator => return .extra_separator,
    };

    const owner_validation = classifyOwnerSegment(parts.owner);
    if (!owner_validation.accepts()) return .{ .invalid_owner = owner_validation };

    const repo_validation = classifyRepoSegment(parts.repo);
    if (!repo_validation.accepts()) return .{ .invalid_repo = repo_validation };

    return .{ .safe = parts };
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
    return classifyOwnerSegment(value).accepts();
}

pub fn classifyOwnerSegment(value: []const u8) OwnerSegmentValidation {
    if (value.len == 0) return .empty;
    if (value.len > max_owner_segment_bytes) return .oversized;

    for (value, 0..) |byte, index| {
        const is_alphanumeric = std.ascii.isAlphabetic(byte) or std.ascii.isDigit(byte);
        if (!is_alphanumeric and byte != '-') return .invalid_character;
        if ((index == 0 or index == value.len - 1) and !is_alphanumeric) return .invalid_edge;
    }

    return .safe;
}

pub fn isRepoSegment(value: []const u8) bool {
    return classifyRepoSegment(value).accepts();
}

pub fn classifyRepoSegment(value: []const u8) RepoSegmentValidation {
    if (value.len == 0) return .empty;
    if (value.len > max_repo_segment_bytes) return .oversized;
    if (text_safety.endsWithAsciiIgnoreCase(value, ".git")) return .git_suffix;

    var previous_dot = false;
    for (value, 0..) |byte, index| {
        const is_alphanumeric = std.ascii.isAlphabetic(byte) or std.ascii.isDigit(byte);
        const is_safe_symbol = byte == '.' or byte == '_' or byte == '-';
        if (!is_alphanumeric and !is_safe_symbol) return .invalid_character;
        if (index == 0 and !is_alphanumeric) return .leading_symbol;
        if (byte == '.' and previous_dot) return .repeated_dot;
        previous_dot = byte == '.';
    }

    return if (previous_dot) .trailing_dot else .safe;
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

test "repository safety classifies complete repository slugs" {
    switch (classifyRepositorySlug("nullclaw/nullbuilder")) {
        .safe => |parts| {
            try std.testing.expectEqualStrings("nullclaw", parts.owner);
            try std.testing.expectEqualStrings("nullbuilder", parts.repo);
        },
        else => return error.ExpectedRepositorySlugParts,
    }

    try expectRepositorySlugValidation(.empty, "");
    try expectRepositorySlugValidation(.missing_separator, "nullbuilder");
    try expectRepositorySlugValidation(.empty_owner, "/nullbuilder");
    try expectRepositorySlugValidation(.empty_repo, "nullclaw/");
    try expectRepositorySlugValidation(.extra_separator, "nullclaw/nullbuilder/extra");
    try expectRepositorySlugValidation(
        .oversized,
        ("a" ** max_owner_segment_bytes) ++ "/" ++ ("b" ** max_repo_segment_bytes) ++ "x",
    );
    try expectInvalidOwnerSlug(.invalid_character, "owner_name/nullbuilder");
    try expectInvalidOwnerSlug(.invalid_edge, "-owner/nullbuilder");
    try expectInvalidRepoSlug(.leading_symbol, "nullclaw/.hidden");
    try expectInvalidRepoSlug(.repeated_dot, "nullclaw/double..dot");
    try expectInvalidRepoSlug(.git_suffix, "nullclaw/nullbuilder.git");

    try std.testing.expect((RepositorySlugValidation{ .safe = .{
        .owner = "nullclaw",
        .repo = "nullbuilder",
    } }).accepts());
    try std.testing.expect(!(RepositorySlugValidation{ .missing_separator = {} }).accepts());
    try std.testing.expect(!(RepositorySlugValidation{ .invalid_repo = .git_suffix }).accepts());
}

fn expectRepositorySlugValidation(
    expected: std.meta.Tag(RepositorySlugValidation),
    value: []const u8,
) !void {
    try std.testing.expectEqual(expected, std.meta.activeTag(classifyRepositorySlug(value)));
}

fn expectInvalidOwnerSlug(expected: OwnerSegmentValidation, value: []const u8) !void {
    switch (classifyRepositorySlug(value)) {
        .invalid_owner => |actual| try std.testing.expectEqual(expected, actual),
        else => return error.ExpectedInvalidOwner,
    }
}

fn expectInvalidRepoSlug(expected: RepoSegmentValidation, value: []const u8) !void {
    switch (classifyRepositorySlug(value)) {
        .invalid_repo => |actual| try std.testing.expectEqual(expected, actual),
        else => return error.ExpectedInvalidRepo,
    }
}

test "repository safety classifies owner segments" {
    try std.testing.expectEqual(OwnerSegmentValidation.safe, classifyOwnerSegment("null-claw"));
    try std.testing.expectEqual(OwnerSegmentValidation.safe, classifyOwnerSegment("NullClaw"));
    try std.testing.expectEqual(OwnerSegmentValidation.empty, classifyOwnerSegment(""));
    try std.testing.expectEqual(OwnerSegmentValidation.oversized, classifyOwnerSegment("a" ** (max_owner_segment_bytes + 1)));
    try std.testing.expectEqual(OwnerSegmentValidation.invalid_character, classifyOwnerSegment("owner_name"));
    try std.testing.expectEqual(OwnerSegmentValidation.invalid_character, classifyOwnerSegment("owner.name"));
    try std.testing.expectEqual(OwnerSegmentValidation.invalid_edge, classifyOwnerSegment("-owner"));
    try std.testing.expectEqual(OwnerSegmentValidation.invalid_edge, classifyOwnerSegment("owner-"));

    try std.testing.expect(OwnerSegmentValidation.safe.accepts());
    try std.testing.expect(!OwnerSegmentValidation.invalid_character.accepts());
}

test "repository safety classifies repository name segments" {
    try std.testing.expectEqual(RepoSegmentValidation.safe, classifyRepoSegment("nullbuilder"));
    try std.testing.expectEqual(RepoSegmentValidation.safe, classifyRepoSegment("null_Pantry-2"));
    try std.testing.expectEqual(RepoSegmentValidation.safe, classifyRepoSegment("null.builder"));
    try std.testing.expectEqual(RepoSegmentValidation.empty, classifyRepoSegment(""));
    try std.testing.expectEqual(RepoSegmentValidation.oversized, classifyRepoSegment("a" ** (max_repo_segment_bytes + 1)));
    try std.testing.expectEqual(RepoSegmentValidation.git_suffix, classifyRepoSegment("nullbuilder.git"));
    try std.testing.expectEqual(RepoSegmentValidation.git_suffix, classifyRepoSegment("nullbuilder.GIT"));
    try std.testing.expectEqual(RepoSegmentValidation.leading_symbol, classifyRepoSegment(".hidden"));
    try std.testing.expectEqual(RepoSegmentValidation.leading_symbol, classifyRepoSegment("-leading"));
    try std.testing.expectEqual(RepoSegmentValidation.invalid_character, classifyRepoSegment("bad/name"));
    try std.testing.expectEqual(RepoSegmentValidation.repeated_dot, classifyRepoSegment("double..dot"));
    try std.testing.expectEqual(RepoSegmentValidation.trailing_dot, classifyRepoSegment("trailing."));

    try std.testing.expect(RepoSegmentValidation.safe.accepts());
    try std.testing.expect(!RepoSegmentValidation.repeated_dot.accepts());
}
