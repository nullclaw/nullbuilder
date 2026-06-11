const std = @import("std");

const action_args = @import("action_args");
const action_paths = @import("action_paths");
const action_values = @import("action_values");

const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_URL_BYTES = 4096;
const MAX_SHA256_LINE_BYTES = 512;
const SHA256_READ_BUFFER_BYTES = 64 * 1024;
const GITHUB_ACTIONS_RUN_PATH_PREFIX = "/actions/runs/";
const Sha256Digest = [std.crypto.hash.sha2.Sha256.digest_length]u8;

const PackageOptions = struct {
    binary_path: []const u8,
    target: []const u8,
    zig_target: []const u8,
    version: []const u8,
    repository: []const u8,
    commit: []const u8,
    run_id: []const u8,
    server_url: []const u8,
    built_at: []const u8,
};

const PackageValidationError = error{
    InvalidBinaryPath,
    InvalidTargetLabel,
    InvalidZigTarget,
    InvalidVersion,
    InvalidRepository,
    InvalidCommitSha,
    InvalidRunId,
    InvalidServerUrl,
    InvalidBuiltAt,
};

const PackageOption = enum {
    binary,
    target,
    zig_target,
    version,
    repository,
    commit,
    run_id,
    server_url,
    built_at,

    fn fromArg(arg: []const u8) ?PackageOption {
        return action_args.registeredOptionFromArg(PackageOption, package_options[0..], arg);
    }

    pub fn flag(self: PackageOption) []const u8 {
        return switch (self) {
            .binary => "--binary",
            .target => "--target",
            .zig_target => "--zig-target",
            .version => "--version",
            .repository => "--repository",
            .commit => "--commit",
            .run_id => "--run-id",
            .server_url => "--server-url",
            .built_at => "--built-at",
        };
    }
};

const package_options = [_]PackageOption{
    .binary,
    .target,
    .zig_target,
    .version,
    .repository,
    .commit,
    .run_id,
    .server_url,
    .built_at,
};

const PackageOptionValues = struct {
    binary_path: ?[]const u8 = null,
    target: ?[]const u8 = null,
    zig_target: ?[]const u8 = null,
    version: ?[]const u8 = null,
    repository: ?[]const u8 = null,
    commit: ?[]const u8 = null,
    run_id: ?[]const u8 = null,
    server_url: ?[]const u8 = null,
    built_at: ?[]const u8 = null,

    fn takeValue(
        self: *PackageOptionValues,
        iterator: *std.process.Args.Iterator,
        allocator: std.mem.Allocator,
        option: PackageOption,
    ) !void {
        const flag = option.flag();
        switch (option) {
            .binary => try action_args.takeValueOnce(iterator, allocator, &self.binary_path, flag),
            .target => try action_args.takeValueOnce(iterator, allocator, &self.target, flag),
            .zig_target => try action_args.takeValueOnce(iterator, allocator, &self.zig_target, flag),
            .version => try action_args.takeValueOnce(iterator, allocator, &self.version, flag),
            .repository => try action_args.takeValueOnce(iterator, allocator, &self.repository, flag),
            .commit => try action_args.takeValueOnce(iterator, allocator, &self.commit, flag),
            .run_id => try action_args.takeValueOnce(iterator, allocator, &self.run_id, flag),
            .server_url => try action_args.takeValueOnce(iterator, allocator, &self.server_url, flag),
            .built_at => try action_args.takeValueOnce(iterator, allocator, &self.built_at, flag),
        }
    }

    fn build(self: PackageOptionValues) !PackageOptions {
        return .{
            .binary_path = try action_args.required(self.binary_path, PackageOption.binary.flag()),
            .target = try action_args.required(self.target, PackageOption.target.flag()),
            .zig_target = try action_args.required(self.zig_target, PackageOption.zig_target.flag()),
            .version = try action_args.required(self.version, PackageOption.version.flag()),
            .repository = try action_args.required(self.repository, PackageOption.repository.flag()),
            .commit = try action_args.required(self.commit, PackageOption.commit.flag()),
            .run_id = try action_args.required(self.run_id, PackageOption.run_id.flag()),
            .server_url = try action_args.required(self.server_url, PackageOption.server_url.flag()),
            .built_at = try action_args.required(self.built_at, PackageOption.built_at.flag()),
        };
    }
};

const ManifestBuildError = error{
    InvalidManifestRunUrl,
    InvalidManifestBinaryPath,
    InvalidManifestMetadata,
};

const ArtifactNameError = error{
    InvalidArtifactBinaryPath,
};

const Sha256LineError = ArtifactNameError || error{
    InvalidSha256LineBuffer,
};

const ManifestRunUrlParts = struct {
    server_url: []const u8,
    repository: []const u8,
    run_id: []const u8,

    fn fromOptions(options: PackageOptions) ManifestBuildError!ManifestRunUrlParts {
        if (!action_values.isHttpUrlBase(options.server_url) or
            !action_values.isRepositorySlug(options.repository) or
            !action_values.isDecimalId(options.run_id))
        {
            return ManifestBuildError.InvalidManifestRunUrl;
        }

        return .{
            .server_url = options.server_url,
            .repository = options.repository,
            .run_id = options.run_id,
        };
    }

    fn byteLen(self: ManifestRunUrlParts) ManifestBuildError!usize {
        var length: usize = 0;
        try addManifestRunUrlBytes(&length, self.server_url.len);
        try addManifestRunUrlBytes(&length, "/".len);
        try addManifestRunUrlBytes(&length, self.repository.len);
        try addManifestRunUrlBytes(&length, GITHUB_ACTIONS_RUN_PATH_PREFIX.len);
        try addManifestRunUrlBytes(&length, self.run_id.len);
        return length;
    }
};

const PackageOutputPlan = struct {
    sha_path: []u8,
    manifest_path: []u8,
    manifest: []u8,

    fn deinit(self: PackageOutputPlan, allocator: std.mem.Allocator) void {
        allocator.free(self.sha_path);
        allocator.free(self.manifest_path);
        allocator.free(self.manifest);
    }
};

fn artifactNameFromPath(binary_path: []const u8) ArtifactNameError![]const u8 {
    try validateArtifactBinaryPath(binary_path);
    return std.Io.Dir.path.basename(binary_path);
}

fn validateArtifactBinaryPath(binary_path: []const u8) ArtifactNameError!void {
    if (!action_paths.isSafeRelativePath(binary_path)) return error.InvalidArtifactBinaryPath;
}

fn hashBytesSha256(bytes: []const u8) Sha256Digest {
    var digest: Sha256Digest = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return digest;
}

fn hashArtifactFileSha256(io: std.Io, dir: std.Io.Dir, binary_path: []const u8) !Sha256Digest {
    return hashArtifactFileSha256Limited(io, dir, binary_path, MAX_BINARY_BYTES);
}

fn hashArtifactFileSha256Limited(io: std.Io, dir: std.Io.Dir, binary_path: []const u8, max_bytes: u64) !Sha256Digest {
    try validateArtifactBinaryPath(binary_path);

    const stat = try dir.statFile(io, binary_path, .{});
    try validateArtifactFileSize(stat.size, max_bytes);

    var file = try dir.openFile(io, binary_path, .{ .allow_directory = false });
    defer file.close(io);

    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var buffer: [SHA256_READ_BUFFER_BYTES]u8 = undefined;
    var offset: u64 = 0;

    while (true) {
        if (offset >= max_bytes) return error.StreamTooLong;

        const chunk_len: usize = @intCast(@min(max_bytes - offset, buffer.len));
        const bytes_read = try file.readPositionalAll(io, buffer[0..chunk_len], offset);
        if (bytes_read == 0) break;

        hasher.update(buffer[0..bytes_read]);
        offset += bytes_read;
        if (bytes_read < chunk_len) break;
    }

    var digest: Sha256Digest = undefined;
    hasher.final(&digest);
    return digest;
}

fn validateArtifactFileSize(file_size: u64, max_bytes: u64) !void {
    if (file_size >= max_bytes) return error.StreamTooLong;
}

fn formatSha256Line(buffer: []u8, digest: Sha256Digest, binary_path: []const u8) Sha256LineError![]const u8 {
    const name = try artifactNameFromPath(binary_path);
    const hex_buf = std.fmt.bytesToHex(digest, .lower);
    return std.fmt.bufPrint(buffer, "{s}  {s}\n", .{ hex_buf[0..], name }) catch return error.InvalidSha256LineBuffer;
}

fn manifestRunUrlLength(options: PackageOptions) ManifestBuildError!usize {
    return (try ManifestRunUrlParts.fromOptions(options)).byteLen();
}

fn addManifestRunUrlBytes(length: *usize, bytes: usize) ManifestBuildError!void {
    if (bytes > MAX_MANIFEST_URL_BYTES - length.*) return ManifestBuildError.InvalidManifestRunUrl;
    length.* += bytes;
}

fn formatRunUrl(buffer: []u8, options: PackageOptions) ManifestBuildError![]const u8 {
    const parts = try ManifestRunUrlParts.fromOptions(options);
    const run_url_len = try parts.byteLen();
    if (buffer.len < run_url_len) return ManifestBuildError.InvalidManifestRunUrl;

    const run_url = std.fmt.bufPrint(buffer[0..run_url_len], "{s}/{s}{s}{s}", .{
        parts.server_url,
        parts.repository,
        GITHUB_ACTIONS_RUN_PATH_PREFIX,
        parts.run_id,
    }) catch return ManifestBuildError.InvalidManifestRunUrl;

    if (run_url.len != run_url_len or !action_values.isGitHubActionsRunUrl(run_url, MAX_MANIFEST_URL_BYTES)) {
        return ManifestBuildError.InvalidManifestRunUrl;
    }

    return run_url;
}

fn buildManifest(allocator: std.mem.Allocator, options: PackageOptions) ![]u8 {
    const binary_name = artifactNameFromPath(options.binary_path) catch return ManifestBuildError.InvalidManifestBinaryPath;
    try validateManifestMetadata(options);
    var run_url_buffer: [MAX_MANIFEST_URL_BYTES]u8 = undefined;
    const run_url = try formatRunUrl(run_url_buffer[0..], options);

    return try std.fmt.allocPrint(allocator,
        \\{{
        \\  "built_at": {f},
        \\  "commit": {f},
        \\  "name": {f},
        \\  "repository": {f},
        \\  "run_id": {f},
        \\  "run_url": {f},
        \\  "target": {f},
        \\  "version": {f},
        \\  "zig_target": {f}
        \\}}
        \\
    , .{
        std.json.fmt(options.built_at, .{}),
        std.json.fmt(options.commit, .{}),
        std.json.fmt(binary_name, .{}),
        std.json.fmt(options.repository, .{}),
        std.json.fmt(options.run_id, .{}),
        std.json.fmt(run_url, .{}),
        std.json.fmt(options.target, .{}),
        std.json.fmt(options.version, .{}),
        std.json.fmt(options.zig_target, .{}),
    });
}

fn validateManifestMetadata(options: PackageOptions) ManifestBuildError!void {
    if (!action_paths.isSafeLabel(options.target) or
        !action_values.isSafeMetadataToken(options.zig_target, 128) or
        !action_values.isSafeMetadataToken(options.version, 128) or
        !action_values.isFullHexSha(options.commit) or
        !action_values.isUtcTimestamp(options.built_at))
    {
        return ManifestBuildError.InvalidManifestMetadata;
    }
}

fn formatSha256Path(allocator: std.mem.Allocator, binary_path: []const u8) ![]u8 {
    if (!action_paths.isSafeRelativePath(binary_path)) return error.InvalidGeneratedPath;
    return allocGeneratedPath(allocator, "{s}.sha256", .{binary_path});
}

fn formatManifestPath(allocator: std.mem.Allocator, binary_path: []const u8, target: []const u8) ![]u8 {
    if (!action_paths.isSafeRelativePath(binary_path)) return error.InvalidGeneratedPath;
    if (!action_paths.isSafeLabel(target)) return error.InvalidGeneratedPath;

    if (std.Io.Dir.path.dirname(binary_path)) |artifact_dir| {
        return allocGeneratedPath(allocator, "{s}/manifest-{s}.json", .{
            artifact_dir,
            target,
        });
    }

    return allocGeneratedPath(allocator, "manifest-{s}.json", .{target});
}

fn allocGeneratedPath(
    allocator: std.mem.Allocator,
    comptime format: []const u8,
    args: anytype,
) ![]u8 {
    if (std.fmt.count(format, args) > action_paths.MAX_RELATIVE_PATH_BYTES) {
        return error.InvalidGeneratedPath;
    }

    const path = try std.fmt.allocPrint(allocator, format, args);
    errdefer allocator.free(path);
    try validateGeneratedPath(path);
    return path;
}

fn validateGeneratedPath(path: []const u8) error{InvalidGeneratedPath}!void {
    if (!action_paths.isSafeRelativePath(path)) return error.InvalidGeneratedPath;
}

fn validateGeneratedOutputPaths(binary_path: []const u8, sha_path: []const u8, manifest_path: []const u8) error{InvalidGeneratedPath}!void {
    try validateGeneratedPath(sha_path);
    try validateGeneratedPath(manifest_path);
    if (action_paths.eqlSafeRelativePath(binary_path, sha_path)) return error.InvalidGeneratedPath;
    if (action_paths.eqlSafeRelativePath(binary_path, manifest_path)) return error.InvalidGeneratedPath;
    if (action_paths.eqlSafeRelativePath(sha_path, manifest_path)) return error.InvalidGeneratedPath;
}

fn ensureGeneratedOutputPathIsNew(io: std.Io, dir: std.Io.Dir, path: []const u8) !void {
    try validateGeneratedPath(path);

    _ = dir.statFile(io, path, .{}) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };

    return error.PathAlreadyExists;
}

fn ensureGeneratedOutputsAreNew(io: std.Io, dir: std.Io.Dir, output_plan: PackageOutputPlan) !void {
    try ensureGeneratedOutputPathIsNew(io, dir, output_plan.sha_path);
    try ensureGeneratedOutputPathIsNew(io, dir, output_plan.manifest_path);
}

fn writeNewGeneratedFile(io: std.Io, dir: std.Io.Dir, path: []const u8, data: []const u8) !void {
    try validateGeneratedPath(path);

    try dir.writeFile(io, .{
        .sub_path = path,
        .data = data,
        .flags = .{ .exclusive = true },
    });
}

fn writePackageOutputs(io: std.Io, dir: std.Io.Dir, output_plan: PackageOutputPlan, sha_text: []const u8) !void {
    try writeNewGeneratedFile(io, dir, output_plan.sha_path, sha_text);
    errdefer dir.deleteFile(io, output_plan.sha_path) catch {};

    try writeNewGeneratedFile(io, dir, output_plan.manifest_path, output_plan.manifest);
}

fn preparePackageOutputPlan(allocator: std.mem.Allocator, options: PackageOptions) !PackageOutputPlan {
    const sha_path = try formatSha256Path(allocator, options.binary_path);
    errdefer allocator.free(sha_path);

    const manifest_path = try formatManifestPath(allocator, options.binary_path, options.target);
    errdefer allocator.free(manifest_path);
    try validateGeneratedOutputPaths(options.binary_path, sha_path, manifest_path);

    const manifest = try buildManifest(allocator, options);
    errdefer allocator.free(manifest);

    return .{
        .sha_path = sha_path,
        .manifest_path = manifest_path,
        .manifest = manifest,
    };
}

fn validatePackageOptions(options: PackageOptions) PackageValidationError!void {
    if (!action_paths.isSafeRelativePath(options.binary_path)) return error.InvalidBinaryPath;
    if (!action_paths.isSafeLabel(options.target)) return error.InvalidTargetLabel;
    if (!action_values.isSafeMetadataToken(options.zig_target, 128)) return error.InvalidZigTarget;
    if (!action_values.isSafeMetadataToken(options.version, 128)) return error.InvalidVersion;
    if (!action_values.isRepositorySlug(options.repository)) return error.InvalidRepository;
    if (!action_values.isFullHexSha(options.commit)) return error.InvalidCommitSha;
    if (!action_values.isDecimalId(options.run_id)) return error.InvalidRunId;
    if (!action_values.isHttpUrlBase(options.server_url)) return error.InvalidServerUrl;
    if (!action_values.isUtcTimestamp(options.built_at)) return error.InvalidBuiltAt;
}

fn printUsage(io: std.Io) !u8 {
    var err_buf: [2048]u8 = undefined;
    var err = std.Io.File.stderr().writer(io, &err_buf);
    try err.interface.writeAll(
        \\usage:
        \\  zig run package_artifact.zig -- --binary PATH --target TARGET --zig-target ZIG_TARGET --version VERSION --repository REPO --commit FULL_SHA --run-id ID --server-url URL --built-at ISO8601
        \\
    );
    try err.interface.flush();
    return 2;
}

fn parseArgs(iterator: *std.process.Args.Iterator, allocator: std.mem.Allocator) !PackageOptions {
    var values = PackageOptionValues{};
    var option_count: usize = 0;

    while (try action_args.nextOption(iterator, &option_count)) |arg| {
        const option = PackageOption.fromArg(arg) orelse return action_args.unexpectedOption(arg);
        try values.takeValue(iterator, allocator, option);
    }

    return values.build();
}

fn runPackage(io: std.Io, allocator: std.mem.Allocator, options: PackageOptions) !void {
    validatePackageOptions(options) catch |err| switch (err) {
        error.InvalidBinaryPath => {
            action_args.printDiagnostic("invalid binary path: {s}\n", options.binary_path);
            return error.InvalidArguments;
        },
        error.InvalidTargetLabel => {
            action_args.printDiagnostic("invalid target label: {s}\n", options.target);
            return error.InvalidArguments;
        },
        error.InvalidZigTarget => {
            action_args.printDiagnostic("invalid zig target: {s}\n", options.zig_target);
            return error.InvalidArguments;
        },
        error.InvalidVersion => {
            action_args.printDiagnostic("invalid version: {s}\n", options.version);
            return error.InvalidArguments;
        },
        error.InvalidRepository => {
            action_args.printDiagnostic("invalid repository: {s}\n", options.repository);
            return error.InvalidArguments;
        },
        error.InvalidCommitSha => {
            action_args.printDiagnostic("invalid commit sha: {s}\n", options.commit);
            return error.InvalidArguments;
        },
        error.InvalidRunId => {
            action_args.printDiagnostic("invalid run id: {s}\n", options.run_id);
            return error.InvalidArguments;
        },
        error.InvalidServerUrl => {
            action_args.printDiagnostic("invalid server url: {s}\n", options.server_url);
            return error.InvalidArguments;
        },
        error.InvalidBuiltAt => {
            action_args.printDiagnostic("invalid build timestamp: {s}\n", options.built_at);
            return error.InvalidArguments;
        },
    };

    const output_plan = preparePackageOutputPlan(allocator, options) catch |err| switch (err) {
        error.InvalidGeneratedPath => {
            action_args.printDiagnostic("invalid generated artifact path for: {s}\n", options.binary_path);
            return error.InvalidArguments;
        },
        else => return err,
    };
    defer output_plan.deinit(allocator);

    const cwd = std.Io.Dir.cwd();
    ensureGeneratedOutputsAreNew(io, cwd, output_plan) catch |err| switch (err) {
        error.PathAlreadyExists => {
            action_args.printDiagnostic("generated artifact path already exists for: {s}\n", options.binary_path);
            return error.InvalidArguments;
        },
        else => return err,
    };

    const digest = try hashArtifactFileSha256(io, cwd, options.binary_path);
    var sha_line_buffer: [MAX_SHA256_LINE_BYTES]u8 = undefined;
    const sha_text = try formatSha256Line(sha_line_buffer[0..], digest, options.binary_path);

    writePackageOutputs(io, cwd, output_plan, sha_text) catch |err| switch (err) {
        error.PathAlreadyExists => {
            action_args.printDiagnostic("generated artifact path already exists for: {s}\n", options.binary_path);
            return error.InvalidArguments;
        },
        else => return err,
    };
}

pub fn main(init: std.process.Init) !u8 {
    const allocator = init.arena.allocator();
    var iterator = try std.process.Args.Iterator.initAllocator(init.minimal.args, init.gpa);
    defer iterator.deinit();

    _ = iterator.next();
    const options = parseArgs(&iterator, allocator) catch |err| switch (err) {
        error.InvalidArguments => return try printUsage(init.io),
        else => return err,
    };
    runPackage(init.io, allocator, options) catch |err| {
        if (action_args.invalidArgumentExitCode(err)) |exit_code| return exit_code;
        return err;
    };
    return 0;
}

test "package artifact formats sha256 line" {
    const digest = hashBytesSha256("");
    var line_buffer: [MAX_SHA256_LINE_BYTES]u8 = undefined;
    const line = try formatSha256Line(line_buffer[0..], digest, "nightly-artifacts/empty.bin");

    try std.testing.expectEqualStrings(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty.bin\n",
        line,
    );

    var tiny_line_buffer: [8]u8 = undefined;
    try std.testing.expectError(
        error.InvalidSha256LineBuffer,
        formatSha256Line(tiny_line_buffer[0..], digest, "nightly-artifacts/empty.bin"),
    );
}

test "package artifact rejects unsafe checksum artifact paths" {
    const digest = hashBytesSha256("");
    var line_buffer: [MAX_SHA256_LINE_BYTES]u8 = undefined;

    try std.testing.expectEqualStrings(
        "empty.bin",
        try artifactNameFromPath("nightly-artifacts/empty.bin"),
    );
    try std.testing.expectError(error.InvalidArtifactBinaryPath, artifactNameFromPath("../empty.bin"));
    try std.testing.expectError(error.InvalidArtifactBinaryPath, formatSha256Line(line_buffer[0..], digest, "../empty.bin"));
}

test "package artifact hashes binary files with bounded stack memory" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "artifact.bin",
        .data = "streamed bytes",
    });

    const expected = hashBytesSha256("streamed bytes");
    const actual = try hashArtifactFileSha256(std.testing.io, tmp.dir, "artifact.bin");
    try std.testing.expectEqualSlices(u8, expected[0..], actual[0..]);
}

test "package artifact rejects unsafe binary paths at hash boundary" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    for ([_][]const u8{
        "../artifact.bin",
        "/tmp/artifact.bin",
        "nightly-artifacts//artifact.bin",
        "C:\\temp\\artifact.bin",
    }) |path| {
        try std.testing.expectError(
            error.InvalidArtifactBinaryPath,
            hashArtifactFileSha256Limited(std.testing.io, tmp.dir, path, MAX_BINARY_BYTES),
        );
    }
}

test "package artifact preflights binary file size before hashing" {
    try validateArtifactFileSize(3, 4);
    try std.testing.expectError(error.StreamTooLong, validateArtifactFileSize(4, 4));
    try std.testing.expectError(error.StreamTooLong, validateArtifactFileSize(5, 4));
    try std.testing.expectError(error.StreamTooLong, validateArtifactFileSize(0, 0));
}

test "package artifact rejects binary files that reach the hash byte limit" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "artifact.bin",
        .data = "abcd",
    });

    const expected = hashBytesSha256("abcd");
    const actual = try hashArtifactFileSha256Limited(std.testing.io, tmp.dir, "artifact.bin", 5);
    try std.testing.expectEqualSlices(u8, expected[0..], actual[0..]);
    try std.testing.expectError(error.StreamTooLong, hashArtifactFileSha256Limited(std.testing.io, tmp.dir, "artifact.bin", 4));
    try std.testing.expectError(error.StreamTooLong, hashArtifactFileSha256Limited(std.testing.io, tmp.dir, "artifact.bin", 3));
}

fn validPackageOptions() PackageOptions {
    return packageOptionsForBinaryPath("nightly-artifacts/nullclaw-linux-x86_64");
}

fn packageOptionsForBinaryPath(binary_path: []const u8) PackageOptions {
    return .{
        .binary_path = binary_path,
        .target = "linux-x86_64",
        .zig_target = "x86_64-linux-musl",
        .version = "nightly-20260504-abcdef0",
        .repository = "nullclaw/nullclaw",
        .commit = "abcdef0123456789abcdef0123456789abcdef01",
        .run_id = "123",
        .server_url = "https://github.com",
        .built_at = "2026-05-04T02:23:00Z",
    };
}

test "package artifact builds parseable manifest" {
    const manifest = try buildManifest(std.testing.allocator, validPackageOptions());
    defer std.testing.allocator.free(manifest);

    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, manifest, .{});
    defer parsed.deinit();

    try std.testing.expectEqualStrings("linux-x86_64", parsed.value.object.get("target").?.string);
    try std.testing.expectEqualStrings(
        "https://github.com/nullclaw/nullclaw/actions/runs/123",
        parsed.value.object.get("run_url").?.string,
    );
}

test "package artifact validates manifest run URL fields at the formatter boundary" {
    const valid_options = validPackageOptions();

    const valid_parts = try ManifestRunUrlParts.fromOptions(valid_options);
    try std.testing.expectEqualStrings("https://github.com", valid_parts.server_url);
    try std.testing.expectEqualStrings("nullclaw/nullclaw", valid_parts.repository);
    try std.testing.expectEqualStrings("123", valid_parts.run_id);
    try std.testing.expectEqual(@as(usize, "https://github.com/nullclaw/nullclaw/actions/runs/123".len), try valid_parts.byteLen());
    try std.testing.expectEqual(@as(usize, "https://github.com/nullclaw/nullclaw/actions/runs/123".len), try manifestRunUrlLength(valid_options));

    var run_url_buffer: [MAX_MANIFEST_URL_BYTES]u8 = undefined;
    const run_url = try formatRunUrl(run_url_buffer[0..], valid_options);
    try std.testing.expectEqualStrings("https://github.com/nullclaw/nullclaw/actions/runs/123", run_url);

    var enterprise_url_options = valid_options;
    enterprise_url_options.server_url = "https://github.example.test";
    var enterprise_run_url_buffer: [MAX_MANIFEST_URL_BYTES]u8 = undefined;
    const enterprise_run_url = try formatRunUrl(enterprise_run_url_buffer[0..], enterprise_url_options);
    try std.testing.expectEqualStrings("https://github.example.test/nullclaw/nullclaw/actions/runs/123", enterprise_run_url);

    var tiny_run_url_buffer: [8]u8 = undefined;
    try std.testing.expectError(error.InvalidManifestRunUrl, formatRunUrl(tiny_run_url_buffer[0..], valid_options));

    var unsafe_url_options = valid_options;
    unsafe_url_options.server_url = "https://github.com/path";
    try std.testing.expectError(error.InvalidManifestRunUrl, ManifestRunUrlParts.fromOptions(unsafe_url_options));
    try std.testing.expectError(error.InvalidManifestRunUrl, formatRunUrl(run_url_buffer[0..], unsafe_url_options));

    var unsafe_repository_options = valid_options;
    unsafe_repository_options.repository = "nullclaw/nullclaw/extra";
    try std.testing.expectError(error.InvalidManifestRunUrl, ManifestRunUrlParts.fromOptions(unsafe_repository_options));
    try std.testing.expectError(error.InvalidManifestRunUrl, formatRunUrl(run_url_buffer[0..], unsafe_repository_options));

    var unsafe_run_options = valid_options;
    unsafe_run_options.run_id = "0";
    try std.testing.expectError(error.InvalidManifestRunUrl, ManifestRunUrlParts.fromOptions(unsafe_run_options));
    try std.testing.expectError(error.InvalidManifestRunUrl, formatRunUrl(run_url_buffer[0..], unsafe_run_options));
    unsafe_run_options.run_id = "01";
    try std.testing.expectError(error.InvalidManifestRunUrl, ManifestRunUrlParts.fromOptions(unsafe_run_options));
    try std.testing.expectError(error.InvalidManifestRunUrl, formatRunUrl(run_url_buffer[0..], unsafe_run_options));

    var unsafe_binary_options = valid_options;
    unsafe_binary_options.binary_path = "../nullclaw-linux-x86_64";
    try std.testing.expectError(error.InvalidManifestBinaryPath, buildManifest(std.testing.allocator, unsafe_binary_options));
}

test "package artifact validates manifest metadata at the formatter boundary" {
    const valid_options = validPackageOptions();

    var unsafe_target_options = valid_options;
    unsafe_target_options.target = "../outside";
    try std.testing.expectError(error.InvalidManifestMetadata, buildManifest(std.testing.allocator, unsafe_target_options));

    var unsafe_version_options = valid_options;
    unsafe_version_options.version = "nightly\n20260504";
    try std.testing.expectError(error.InvalidManifestMetadata, buildManifest(std.testing.allocator, unsafe_version_options));

    var unsafe_commit_options = valid_options;
    unsafe_commit_options.commit = "not-a-sha";
    try std.testing.expectError(error.InvalidManifestMetadata, buildManifest(std.testing.allocator, unsafe_commit_options));

    var unsafe_timestamp_options = valid_options;
    unsafe_timestamp_options.built_at = "2026-05-04 02:23:00Z";
    try std.testing.expectError(error.InvalidManifestMetadata, buildManifest(std.testing.allocator, unsafe_timestamp_options));
}

test "package artifact formats safe generated paths" {
    const nested_sha_path = try formatSha256Path(std.testing.allocator, "nightly-artifacts/nullclaw-linux-x86_64");
    defer std.testing.allocator.free(nested_sha_path);
    try std.testing.expectEqualStrings("nightly-artifacts/nullclaw-linux-x86_64.sha256", nested_sha_path);
    try std.testing.expect(action_paths.isSafeRelativePath(nested_sha_path));

    const nested_manifest_path = try formatManifestPath(std.testing.allocator, "nightly-artifacts/nullclaw-linux-x86_64", "linux-x86_64");
    defer std.testing.allocator.free(nested_manifest_path);
    try std.testing.expectEqualStrings("nightly-artifacts/manifest-linux-x86_64.json", nested_manifest_path);
    try std.testing.expect(action_paths.isSafeRelativePath(nested_manifest_path));

    const root_manifest_path = try formatManifestPath(std.testing.allocator, "nullclaw-linux-x86_64", "linux-x86_64");
    defer std.testing.allocator.free(root_manifest_path);
    try std.testing.expectEqualStrings("manifest-linux-x86_64.json", root_manifest_path);
    try std.testing.expect(action_paths.isSafeRelativePath(root_manifest_path));

    try validateGeneratedOutputPaths("artifact.bin", "artifact.bin.sha256", "manifest-linux-x86_64.json");
    try std.testing.expectError(
        error.InvalidGeneratedPath,
        validateGeneratedOutputPaths("artifact.bin", "artifact.bin", "manifest-linux-x86_64.json"),
    );
    try std.testing.expectError(
        error.InvalidGeneratedPath,
        validateGeneratedOutputPaths("manifest-linux-x86_64.json", "manifest-linux-x86_64.json.sha256", "manifest-linux-x86_64.json"),
    );
    try std.testing.expectError(
        error.InvalidGeneratedPath,
        validateGeneratedOutputPaths("NIGHTLY-ARTIFACTS/MANIFEST-linux-x86_64.json", "nightly-artifacts/manifest-linux-x86_64.json.sha256", "nightly-artifacts/manifest-linux-x86_64.json"),
    );
    try std.testing.expectError(
        error.InvalidGeneratedPath,
        validateGeneratedOutputPaths("artifact.bin", "nightly-artifacts/MANIFEST-linux-x86_64.JSON", "nightly-artifacts/manifest-linux-x86_64.json"),
    );

    const long_safe_binary =
        ("a" ** 128) ++ "/" ++
        ("b" ** 128) ++ "/" ++
        ("c" ** 128) ++ "/" ++
        ("d" ** 128) ++ "/" ++
        ("e" ** 128) ++ "/" ++
        ("f" ** 128) ++ "/" ++
        ("g" ** 128) ++ "/" ++
        ("h" ** 115);
    try std.testing.expect(action_paths.isSafeRelativePath(long_safe_binary));
    try std.testing.expectError(error.InvalidGeneratedPath, formatSha256Path(std.testing.allocator, long_safe_binary));

    const long_safe_target = "t" ** 128;
    try std.testing.expect(action_paths.isSafeLabel(long_safe_target));
    try std.testing.expectError(error.InvalidGeneratedPath, formatManifestPath(std.testing.allocator, long_safe_binary, long_safe_target));
}

test "package artifact rejects unsafe generated path inputs before allocation" {
    try std.testing.expectError(
        error.InvalidGeneratedPath,
        formatSha256Path(std.testing.failing_allocator, "../nullclaw-linux-x86_64"),
    );
    try std.testing.expectError(
        error.InvalidGeneratedPath,
        formatManifestPath(std.testing.failing_allocator, "../nullclaw-linux-x86_64", "linux-x86_64"),
    );
    try std.testing.expectError(
        error.InvalidGeneratedPath,
        formatManifestPath(std.testing.failing_allocator, "nightly-artifacts/nullclaw-linux-x86_64", "../linux-x86_64"),
    );

    const long_safe_binary =
        ("a" ** 128) ++ "/" ++
        ("b" ** 128) ++ "/" ++
        ("c" ** 128) ++ "/" ++
        ("d" ** 128) ++ "/" ++
        ("e" ** 128) ++ "/" ++
        ("f" ** 128) ++ "/" ++
        ("g" ** 128) ++ "/" ++
        ("h" ** 115);
    try std.testing.expect(action_paths.isSafeRelativePath(long_safe_binary));
    try std.testing.expectError(
        error.InvalidGeneratedPath,
        formatSha256Path(std.testing.failing_allocator, long_safe_binary),
    );

    const long_safe_target = "t" ** 128;
    try std.testing.expect(action_paths.isSafeLabel(long_safe_target));
    try std.testing.expectError(
        error.InvalidGeneratedPath,
        formatManifestPath(std.testing.failing_allocator, long_safe_binary, long_safe_target),
    );
}

test "package artifact prepares output metadata before reading binary bytes" {
    const valid_options = validPackageOptions();

    const output_plan = try preparePackageOutputPlan(std.testing.allocator, valid_options);
    defer output_plan.deinit(std.testing.allocator);

    try std.testing.expectEqualStrings("nightly-artifacts/nullclaw-linux-x86_64.sha256", output_plan.sha_path);
    try std.testing.expectEqualStrings("nightly-artifacts/manifest-linux-x86_64.json", output_plan.manifest_path);
    try std.testing.expect(std.mem.indexOf(u8, output_plan.manifest, "\"run_url\"") != null);

    const long_safe_binary =
        ("a" ** 128) ++ "/" ++
        ("b" ** 128) ++ "/" ++
        ("c" ** 128) ++ "/" ++
        ("d" ** 128) ++ "/" ++
        ("e" ** 128) ++ "/" ++
        ("f" ** 128) ++ "/" ++
        ("g" ** 128) ++ "/" ++
        ("h" ** 115);
    var unsafe_generated_options = valid_options;
    unsafe_generated_options.binary_path = long_safe_binary;
    try std.testing.expectError(error.InvalidGeneratedPath, preparePackageOutputPlan(std.testing.allocator, unsafe_generated_options));

    var self_overwriting_manifest_options = valid_options;
    self_overwriting_manifest_options.binary_path = "nightly-artifacts/manifest-linux-x86_64.json";
    try std.testing.expectError(
        error.InvalidGeneratedPath,
        preparePackageOutputPlan(std.testing.allocator, self_overwriting_manifest_options),
    );

    var case_insensitive_self_overwriting_options = valid_options;
    case_insensitive_self_overwriting_options.binary_path = "nightly-artifacts/MANIFEST-linux-x86_64.JSON";
    try std.testing.expectError(
        error.InvalidGeneratedPath,
        preparePackageOutputPlan(std.testing.allocator, case_insensitive_self_overwriting_options),
    );
}

test "package artifact preflights generated outputs before writing" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const output_plan = try preparePackageOutputPlan(std.testing.allocator, packageOptionsForBinaryPath("artifact.bin"));
    defer output_plan.deinit(std.testing.allocator);

    try ensureGeneratedOutputsAreNew(std.testing.io, tmp.dir, output_plan);

    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = output_plan.manifest_path,
        .data = "existing manifest",
    });
    try std.testing.expectError(error.PathAlreadyExists, ensureGeneratedOutputsAreNew(std.testing.io, tmp.dir, output_plan));
}

test "package artifact rejects unsafe generated paths at filesystem boundaries" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    for ([_][]const u8{
        "../artifact.bin.sha256",
        "/tmp/artifact.bin.sha256",
        "nightly-artifacts//artifact.bin.sha256",
        "C:\\temp\\artifact.bin.sha256",
    }) |path| {
        try std.testing.expectError(
            error.InvalidGeneratedPath,
            ensureGeneratedOutputPathIsNew(std.testing.io, tmp.dir, path),
        );
        try std.testing.expectError(
            error.InvalidGeneratedPath,
            writeNewGeneratedFile(std.testing.io, tmp.dir, path, "data"),
        );
    }
}

test "package artifact removes partial checksum output when manifest write fails" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const output_plan = try preparePackageOutputPlan(std.testing.allocator, packageOptionsForBinaryPath("artifact.bin"));
    defer output_plan.deinit(std.testing.allocator);

    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = output_plan.manifest_path,
        .data = "existing manifest",
    });

    try std.testing.expectError(
        error.PathAlreadyExists,
        writePackageOutputs(std.testing.io, tmp.dir, output_plan, "checksum text"),
    );
    try std.testing.expectError(error.FileNotFound, tmp.dir.statFile(std.testing.io, output_plan.sha_path, .{}));

    const manifest = try tmp.dir.readFileAlloc(
        std.testing.io,
        output_plan.manifest_path,
        std.testing.allocator,
        .limited(32),
    );
    defer std.testing.allocator.free(manifest);
    try std.testing.expectEqualStrings("existing manifest", manifest);
}

test "package artifact writes generated outputs with exclusive creation" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try writeNewGeneratedFile(std.testing.io, tmp.dir, "artifact.bin.sha256", "first");
    try std.testing.expectError(
        error.PathAlreadyExists,
        writeNewGeneratedFile(std.testing.io, tmp.dir, "artifact.bin.sha256", "second"),
    );

    const contents = try tmp.dir.readFileAlloc(
        std.testing.io,
        "artifact.bin.sha256",
        std.testing.allocator,
        .limited(16),
    );
    defer std.testing.allocator.free(contents);

    try std.testing.expectEqualStrings("first", contents);
}

test "package artifact option registry maps parser flags" {
    try std.testing.expectEqual(@as(usize, 9), package_options.len);
    for (package_options) |option| {
        try std.testing.expectEqual(option, PackageOption.fromArg(option.flag()).?);
    }

    try std.testing.expectEqual(@as(?PackageOption, null), PackageOption.fromArg("--unknown"));
}

test "package artifact parses registered options" {
    const argv = [_][*:0]const u8{
        "package_artifact",
        "--binary",
        "nightly-artifacts/nullclaw-linux-x86_64",
        "--target",
        "linux-x86_64",
        "--zig-target",
        "x86_64-linux-musl",
        "--version",
        "nightly-20260504-abcdef0",
        "--repository",
        "nullclaw/nullclaw",
        "--commit",
        "abcdef0123456789abcdef0123456789abcdef01",
        "--run-id",
        "123",
        "--server-url",
        "https://github.com",
        "--built-at",
        "2026-05-04T02:23:00Z",
    };
    var iterator = std.process.Args.Iterator.init(.{ .vector = &argv });
    _ = iterator.next();

    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();

    const options = try parseArgs(&iterator, arena_state.allocator());
    try std.testing.expectEqualStrings("nightly-artifacts/nullclaw-linux-x86_64", options.binary_path);
    try std.testing.expectEqualStrings("linux-x86_64", options.target);
    try std.testing.expectEqualStrings("x86_64-linux-musl", options.zig_target);
    try std.testing.expectEqualStrings("nightly-20260504-abcdef0", options.version);
    try std.testing.expectEqualStrings("nullclaw/nullclaw", options.repository);
    try std.testing.expectEqualStrings("abcdef0123456789abcdef0123456789abcdef01", options.commit);
    try std.testing.expectEqualStrings("123", options.run_id);
    try std.testing.expectEqualStrings("https://github.com", options.server_url);
    try std.testing.expectEqualStrings("2026-05-04T02:23:00Z", options.built_at);
}

test "package artifact rejects duplicate options" {
    const argv = [_][*:0]const u8{
        "package_artifact",
        "--binary",
        "nightly-artifacts/nullclaw-linux-x86_64",
        "--binary",
        "nightly-artifacts/other",
    };
    var iterator = std.process.Args.Iterator.init(.{ .vector = &argv });
    _ = iterator.next();

    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();

    try std.testing.expectError(error.InvalidArguments, parseArgs(&iterator, arena_state.allocator()));
}

test "package artifact validates package options before filesystem writes" {
    const valid_options = validPackageOptions();

    try validatePackageOptions(valid_options);

    var unsafe_path_options = valid_options;
    unsafe_path_options.binary_path = "../outside";
    try std.testing.expectError(error.InvalidBinaryPath, validatePackageOptions(unsafe_path_options));

    var unsafe_target_options = valid_options;
    unsafe_target_options.target = "../outside";
    try std.testing.expectError(error.InvalidTargetLabel, validatePackageOptions(unsafe_target_options));

    var unsafe_zig_target_options = valid_options;
    unsafe_zig_target_options.zig_target = "x86_64/linux";
    try std.testing.expectError(error.InvalidZigTarget, validatePackageOptions(unsafe_zig_target_options));

    var unsafe_version_options = valid_options;
    unsafe_version_options.version = "nightly\"20260504";
    try std.testing.expectError(error.InvalidVersion, validatePackageOptions(unsafe_version_options));

    var unsafe_repository_options = valid_options;
    unsafe_repository_options.repository = "nullclaw/nullbuilder/extra";
    try std.testing.expectError(error.InvalidRepository, validatePackageOptions(unsafe_repository_options));

    var unsafe_commit_options = valid_options;
    unsafe_commit_options.commit = "not-a-sha";
    try std.testing.expectError(error.InvalidCommitSha, validatePackageOptions(unsafe_commit_options));

    var unsafe_run_options = valid_options;
    unsafe_run_options.run_id = "0";
    try std.testing.expectError(error.InvalidRunId, validatePackageOptions(unsafe_run_options));
    unsafe_run_options.run_id = "01";
    try std.testing.expectError(error.InvalidRunId, validatePackageOptions(unsafe_run_options));

    var unsafe_url_options = valid_options;
    unsafe_url_options.server_url = "https://github.com/path";
    try std.testing.expectError(error.InvalidServerUrl, validatePackageOptions(unsafe_url_options));

    var unsafe_metadata_options = valid_options;
    unsafe_metadata_options.built_at = "2026-05-04T02:23:00Z\ninjected";
    try std.testing.expectError(error.InvalidBuiltAt, validatePackageOptions(unsafe_metadata_options));

    var unsafe_timestamp_options = valid_options;
    unsafe_timestamp_options.built_at = "2026-05-04 02:23:00Z";
    try std.testing.expectError(error.InvalidBuiltAt, validatePackageOptions(unsafe_timestamp_options));
}
