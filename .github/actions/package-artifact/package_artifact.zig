const std = @import("std");

const action_args = @import("action_args");
const action_paths = @import("action_paths");
const action_values = @import("action_values");

const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_URL_BYTES = 4096;

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

const ManifestBuildError = error{
    InvalidManifestRunUrl,
};

fn formatSha256Line(allocator: std.mem.Allocator, bytes: []const u8, name: []const u8) ![]u8 {
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    const hex_buf = std.fmt.bytesToHex(digest, .lower);
    return try std.fmt.allocPrint(allocator, "{s}  {s}\n", .{ hex_buf[0..], name });
}

fn formatRunUrl(allocator: std.mem.Allocator, options: PackageOptions) ![]u8 {
    if (!action_values.isHttpUrlBase(options.server_url) or
        !action_values.isRepositorySlug(options.repository) or
        !action_values.isDecimalId(options.run_id))
    {
        return ManifestBuildError.InvalidManifestRunUrl;
    }

    const run_url = try std.fmt.allocPrint(allocator, "{s}/{s}/actions/runs/{s}", .{
        options.server_url,
        options.repository,
        options.run_id,
    });
    errdefer allocator.free(run_url);

    if (!action_values.isHttpUrl(run_url, MAX_MANIFEST_URL_BYTES)) {
        return ManifestBuildError.InvalidManifestRunUrl;
    }

    return run_url;
}

fn buildManifest(allocator: std.mem.Allocator, options: PackageOptions) ![]u8 {
    const binary_name = std.Io.Dir.path.basename(options.binary_path);
    const run_url = try formatRunUrl(allocator, options);
    defer allocator.free(run_url);

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

fn formatSha256Path(allocator: std.mem.Allocator, binary_path: []const u8) ![]u8 {
    const path = try std.fmt.allocPrint(allocator, "{s}.sha256", .{binary_path});
    errdefer allocator.free(path);
    try validateGeneratedPath(path);
    return path;
}

fn formatManifestPath(allocator: std.mem.Allocator, binary_path: []const u8, target: []const u8) ![]u8 {
    if (std.Io.Dir.path.dirname(binary_path)) |artifact_dir| {
        const path = try std.fmt.allocPrint(allocator, "{s}/manifest-{s}.json", .{
            artifact_dir,
            target,
        });
        errdefer allocator.free(path);
        try validateGeneratedPath(path);
        return path;
    }

    const path = try std.fmt.allocPrint(allocator, "manifest-{s}.json", .{target});
    errdefer allocator.free(path);
    try validateGeneratedPath(path);
    return path;
}

fn validateGeneratedPath(path: []const u8) error{InvalidGeneratedPath}!void {
    if (!action_paths.isSafeRelativePath(path)) return error.InvalidGeneratedPath;
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
    var binary_path: ?[]const u8 = null;
    var target: ?[]const u8 = null;
    var zig_target: ?[]const u8 = null;
    var version: ?[]const u8 = null;
    var repository: ?[]const u8 = null;
    var commit: ?[]const u8 = null;
    var run_id: ?[]const u8 = null;
    var server_url: ?[]const u8 = null;
    var built_at: ?[]const u8 = null;

    while (iterator.next()) |arg| {
        if (std.mem.eql(u8, arg, "--binary")) {
            try action_args.takeValueOnce(iterator, allocator, &binary_path, arg);
        } else if (std.mem.eql(u8, arg, "--target")) {
            try action_args.takeValueOnce(iterator, allocator, &target, arg);
        } else if (std.mem.eql(u8, arg, "--zig-target")) {
            try action_args.takeValueOnce(iterator, allocator, &zig_target, arg);
        } else if (std.mem.eql(u8, arg, "--version")) {
            try action_args.takeValueOnce(iterator, allocator, &version, arg);
        } else if (std.mem.eql(u8, arg, "--repository")) {
            try action_args.takeValueOnce(iterator, allocator, &repository, arg);
        } else if (std.mem.eql(u8, arg, "--commit")) {
            try action_args.takeValueOnce(iterator, allocator, &commit, arg);
        } else if (std.mem.eql(u8, arg, "--run-id")) {
            try action_args.takeValueOnce(iterator, allocator, &run_id, arg);
        } else if (std.mem.eql(u8, arg, "--server-url")) {
            try action_args.takeValueOnce(iterator, allocator, &server_url, arg);
        } else if (std.mem.eql(u8, arg, "--built-at")) {
            try action_args.takeValueOnce(iterator, allocator, &built_at, arg);
        } else {
            return action_args.unexpectedOption(arg);
        }
    }

    return .{
        .binary_path = try action_args.required(binary_path, "--binary"),
        .target = try action_args.required(target, "--target"),
        .zig_target = try action_args.required(zig_target, "--zig-target"),
        .version = try action_args.required(version, "--version"),
        .repository = try action_args.required(repository, "--repository"),
        .commit = try action_args.required(commit, "--commit"),
        .run_id = try action_args.required(run_id, "--run-id"),
        .server_url = try action_args.required(server_url, "--server-url"),
        .built_at = try action_args.required(built_at, "--built-at"),
    };
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

    const binary_bytes = try std.Io.Dir.cwd().readFileAlloc(
        io,
        options.binary_path,
        allocator,
        .limited(MAX_BINARY_BYTES),
    );
    defer allocator.free(binary_bytes);

    const binary_name = std.Io.Dir.path.basename(options.binary_path);
    const sha_text = try formatSha256Line(allocator, binary_bytes, binary_name);
    defer allocator.free(sha_text);

    const sha_path = formatSha256Path(allocator, options.binary_path) catch |err| switch (err) {
        error.InvalidGeneratedPath => {
            action_args.printDiagnostic("invalid generated artifact path for: {s}\n", options.binary_path);
            return error.InvalidArguments;
        },
        else => return err,
    };
    defer allocator.free(sha_path);

    const manifest_path = formatManifestPath(allocator, options.binary_path, options.target) catch |err| switch (err) {
        error.InvalidGeneratedPath => {
            action_args.printDiagnostic("invalid generated artifact path for: {s}\n", options.binary_path);
            return error.InvalidArguments;
        },
        else => return err,
    };
    defer allocator.free(manifest_path);

    const manifest = try buildManifest(allocator, options);
    defer allocator.free(manifest);

    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = sha_path, .data = sha_text });
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = manifest_path, .data = manifest });
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
    const line = try formatSha256Line(std.testing.allocator, "", "empty.bin");
    defer std.testing.allocator.free(line);

    try std.testing.expectEqualStrings(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty.bin\n",
        line,
    );
}

test "package artifact builds parseable manifest" {
    const manifest = try buildManifest(std.testing.allocator, .{
        .binary_path = "nightly-artifacts/nullclaw-linux-x86_64",
        .target = "linux-x86_64",
        .zig_target = "x86_64-linux-musl",
        .version = "nightly-20260504-abcdef0",
        .repository = "nullclaw/nullclaw",
        .commit = "abcdef0123456789abcdef0123456789abcdef01",
        .run_id = "123",
        .server_url = "https://github.com",
        .built_at = "2026-05-04T02:23:00Z",
    });
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
    const valid_options = PackageOptions{
        .binary_path = "nightly-artifacts/nullclaw-linux-x86_64",
        .target = "linux-x86_64",
        .zig_target = "x86_64-linux-musl",
        .version = "nightly-20260504-abcdef0",
        .repository = "nullclaw/nullclaw",
        .commit = "abcdef0123456789abcdef0123456789abcdef01",
        .run_id = "123",
        .server_url = "https://github.com",
        .built_at = "2026-05-04T02:23:00Z",
    };

    const run_url = try formatRunUrl(std.testing.allocator, valid_options);
    defer std.testing.allocator.free(run_url);
    try std.testing.expectEqualStrings("https://github.com/nullclaw/nullclaw/actions/runs/123", run_url);

    var unsafe_url_options = valid_options;
    unsafe_url_options.server_url = "https://github.com/path";
    try std.testing.expectError(error.InvalidManifestRunUrl, formatRunUrl(std.testing.allocator, unsafe_url_options));

    var unsafe_repository_options = valid_options;
    unsafe_repository_options.repository = "nullclaw/nullclaw/extra";
    try std.testing.expectError(error.InvalidManifestRunUrl, formatRunUrl(std.testing.allocator, unsafe_repository_options));

    var unsafe_run_options = valid_options;
    unsafe_run_options.run_id = "0";
    try std.testing.expectError(error.InvalidManifestRunUrl, formatRunUrl(std.testing.allocator, unsafe_run_options));
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
    const valid_options = PackageOptions{
        .binary_path = "nightly-artifacts/nullclaw-linux-x86_64",
        .target = "linux-x86_64",
        .zig_target = "x86_64-linux-musl",
        .version = "nightly-20260504-abcdef0",
        .repository = "nullclaw/nullclaw",
        .commit = "abcdef0123456789abcdef0123456789abcdef01",
        .run_id = "123",
        .server_url = "https://github.com",
        .built_at = "2026-05-04T02:23:00Z",
    };

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
