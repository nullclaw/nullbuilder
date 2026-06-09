const std = @import("std");

const MAX_BINARY_BYTES = 64 * 1024 * 1024;

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

fn formatSha256Line(allocator: std.mem.Allocator, bytes: []const u8, name: []const u8) ![]u8 {
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    const hex_buf = std.fmt.bytesToHex(digest, .lower);
    return try std.fmt.allocPrint(allocator, "{s}  {s}\n", .{ hex_buf[0..], name });
}

fn buildManifest(allocator: std.mem.Allocator, options: PackageOptions) ![]u8 {
    const binary_name = std.Io.Dir.path.basename(options.binary_path);
    const run_url = try std.fmt.allocPrint(allocator, "{s}/{s}/actions/runs/{s}", .{
        options.server_url,
        options.repository,
        options.run_id,
    });
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

fn isSafeArtifactLabel(value: []const u8) bool {
    if (value.len == 0) return false;

    var previous_dot = false;
    for (value, 0..) |byte, index| {
        const is_alpha = (byte >= 'a' and byte <= 'z') or (byte >= 'A' and byte <= 'Z');
        const is_digit = byte >= '0' and byte <= '9';
        const is_safe_symbol = byte == '.' or byte == '_' or byte == '-';

        if (!is_alpha and !is_digit and !is_safe_symbol) return false;
        if (index == 0 and !is_alpha and !is_digit) return false;
        if (byte == '.' and previous_dot) return false;
        previous_dot = byte == '.';
    }

    return true;
}

fn printUsage(io: std.Io) !u8 {
    var err_buf: [2048]u8 = undefined;
    var err = std.Io.File.stderr().writer(io, &err_buf);
    try err.interface.writeAll(
        \\usage:
        \\  zig run package_artifact.zig -- --binary PATH --target TARGET --zig-target ZIG_TARGET --version VERSION --repository REPO --commit SHA --run-id ID --server-url URL --built-at ISO8601
        \\
    );
    try err.interface.flush();
    return 2;
}

fn takeValue(
    iterator: *std.process.Args.Iterator,
    allocator: std.mem.Allocator,
    flag: []const u8,
) ![]const u8 {
    const value = iterator.next() orelse {
        std.debug.print("missing value for {s}\n", .{flag});
        return error.InvalidArguments;
    };
    return try allocator.dupe(u8, value);
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
            binary_path = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--target")) {
            target = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--zig-target")) {
            zig_target = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--version")) {
            version = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--repository")) {
            repository = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--commit")) {
            commit = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--run-id")) {
            run_id = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--server-url")) {
            server_url = try takeValue(iterator, allocator, arg);
        } else if (std.mem.eql(u8, arg, "--built-at")) {
            built_at = try takeValue(iterator, allocator, arg);
        } else {
            std.debug.print("unknown option: {s}\n", .{arg});
            return error.InvalidArguments;
        }
    }

    return .{
        .binary_path = binary_path orelse return error.InvalidArguments,
        .target = target orelse return error.InvalidArguments,
        .zig_target = zig_target orelse return error.InvalidArguments,
        .version = version orelse return error.InvalidArguments,
        .repository = repository orelse return error.InvalidArguments,
        .commit = commit orelse return error.InvalidArguments,
        .run_id = run_id orelse return error.InvalidArguments,
        .server_url = server_url orelse return error.InvalidArguments,
        .built_at = built_at orelse return error.InvalidArguments,
    };
}

fn runPackage(io: std.Io, allocator: std.mem.Allocator, options: PackageOptions) !void {
    if (!isSafeArtifactLabel(options.target)) {
        std.debug.print("invalid target label: {s}\n", .{options.target});
        return error.InvalidArguments;
    }

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

    const sha_path = try std.fmt.allocPrint(allocator, "{s}.sha256", .{options.binary_path});
    defer allocator.free(sha_path);

    const artifact_dir = std.Io.Dir.path.dirname(options.binary_path) orelse ".";
    const manifest_path = try std.fmt.allocPrint(allocator, "{s}/manifest-{s}.json", .{
        artifact_dir,
        options.target,
    });
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
    const options = parseArgs(&iterator, allocator) catch return try printUsage(init.io);
    try runPackage(init.io, allocator, options);
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
        .commit = "abcdef012345",
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

test "package artifact rejects unsafe manifest target labels" {
    try std.testing.expect(isSafeArtifactLabel("linux-x86_64"));
    try std.testing.expect(!isSafeArtifactLabel("../outside"));
    try std.testing.expect(!isSafeArtifactLabel("linux/amd64"));
    try std.testing.expect(!isSafeArtifactLabel(".."));
    try std.testing.expect(!isSafeArtifactLabel("-leading-dash"));
}
