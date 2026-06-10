const std = @import("std");

const cli = @import("cli.zig");
const dashboard = @import("dashboard.zig");

const max_cli_path_bytes = 4096;

pub fn run(
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    io: std.Io,
    out: *std.Io.Writer,
    cli_path: []const u8,
    no_color: bool,
    args: []const []const u8,
) !?u8 {
    if (isHelpCommand(args)) {
        try printHelp(out);
        return null;
    }

    if (!isSafeCliPath(cli_path)) {
        try out.writeAll("invalid NULLBUILDER_NODE_CLI\n");
        return 2;
    }

    if (args.len > 1 and isTagCommand(args[1])) {
        return forwardTagCommand(gpa, arena, io, out, cli_path, args[1..]);
    }

    return renderDashboard(gpa, arena, io, out, cli_path, no_color);
}

fn isHelpCommand(args: []const []const u8) bool {
    return args.len > 1 and (std.mem.eql(u8, args[1], "--help") or std.mem.eql(u8, args[1], "help"));
}

fn isTagCommand(value: []const u8) bool {
    return std.mem.eql(u8, value, "build-pr") or std.mem.eql(u8, value, "release-tag");
}

fn isSafeCliPath(value: []const u8) bool {
    if (value.len == 0 or value.len > max_cli_path_bytes) return false;
    if (std.mem.startsWith(u8, value, "-")) return false;

    for (value) |byte| {
        if (isPathControlByte(byte)) return false;
    }

    return true;
}

fn isPathControlByte(byte: u8) bool {
    return byte < 0x20 or (byte >= 0x7f and byte <= 0x9f);
}

fn printHelp(out: *std.Io.Writer) !void {
    try out.writeAll(
        \\nullbuilder-tui
        \\
        \\Usage:
        \\  zig build tui
        \\  zig build tui -- build-pr <repo> --pr <number> [--tag build-pr-*] [--confirm]
        \\  zig build tui -- release-tag <repo> --tag vX.Y.Z [--ref branch-or-sha] [--confirm]
        \\
        \\Environment:
        \\  NULLBUILDER_NODE_CLI  Path to bin/nullbuilder.js. Defaults to ./bin/nullbuilder.js
        \\  NULLBUILDER_GITHUB_TOKEN
        \\                       Token used by the underlying nullbuilder CLI
        \\
    );
}

fn renderDashboard(
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    io: std.Io,
    out: *std.Io.Writer,
    cli_path: []const u8,
    no_color: bool,
) !?u8 {
    const result = try cli.run(gpa, io, &.{ "node", cli_path, "repos", "--json" }, .{
        .stdout = dashboard.max_json_bytes,
    });
    defer cli.freeResult(gpa, result);

    if (try cli.exitCodeForFailure(out, result, &.{ 0, 2 })) |exit_code| {
        return exit_code;
    }

    try dashboard.render(arena, out, result.stdout, no_color);
    return null;
}

fn forwardTagCommand(
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    io: std.Io,
    out: *std.Io.Writer,
    cli_path: []const u8,
    args: []const []const u8,
) !?u8 {
    var argv = std.array_list.Managed([]const u8).init(arena);
    try argv.append("node");
    try argv.append(cli_path);
    try argv.appendSlice(args);

    const result = try cli.run(gpa, io, argv.items, .{});
    defer cli.freeResult(gpa, result);

    if (try cli.exitCodeForFailure(out, result, &.{0})) |exit_code| {
        return exit_code;
    }

    try cli.writeCaptured(out, result);
    return null;
}

test "tag commands are detected explicitly" {
    try std.testing.expect(isTagCommand("build-pr"));
    try std.testing.expect(isTagCommand("release-tag"));
    try std.testing.expect(!isTagCommand("repos"));
}

test "node cli path rejects option injection and controls" {
    const oversized = [_]u8{'a'} ** (max_cli_path_bytes + 1);

    try std.testing.expect(isSafeCliPath("./bin/nullbuilder.js"));
    try std.testing.expect(isSafeCliPath("/tmp/nullbuilder.js"));
    try std.testing.expect(isSafeCliPath("scripts/nullbuilder.js"));

    try std.testing.expect(!isSafeCliPath(""));
    try std.testing.expect(!isSafeCliPath("-e"));
    try std.testing.expect(!isSafeCliPath("--eval=process.exit(1)"));
    try std.testing.expect(!isSafeCliPath("bad\npath"));
    try std.testing.expect(!isSafeCliPath("bad\x00path"));
    try std.testing.expect(!isSafeCliPath("bad\xc2\x85path"));
    try std.testing.expect(!isSafeCliPath(oversized[0..]));
}
