const std = @import("std");

const arg_safety = @import("arg_safety");
const cli = @import("cli.zig");
const dashboard = @import("dashboard.zig");
const terminal = @import("terminal.zig");

const max_cli_path_bytes = 4096;
const max_forwarded_arg_count = 64;
const max_forwarded_arg_bytes = 4096;
const max_forwarded_args_total_bytes = 64 * 1024;
const max_app_arg_count = max_forwarded_arg_count + 1;
const max_app_arg_bytes = max_forwarded_arg_bytes;
const max_app_args_total_bytes = max_forwarded_args_total_bytes + max_cli_path_bytes;

const Command = union(enum) {
    dashboard,
    help,
    tag: []const []const u8,
    invalid,
};

pub fn run(
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    io: std.Io,
    out: *std.Io.Writer,
    cli_path: []const u8,
    no_color: bool,
    args: []const []const u8,
) !?u8 {
    if (!isSafeAppArgs(args)) {
        try out.writeAll("invalid command arguments\n");
        return 2;
    }

    switch (classifyCommand(args)) {
        .help => {
            try printHelp(out);
            return null;
        },
        .invalid => {
            try out.writeAll("invalid command\n");
            return 2;
        },
        .dashboard => {
            if (!isSafeCliPath(cli_path)) {
                try out.writeAll("invalid NULLBUILDER_NODE_CLI\n");
                return 2;
            }

            return renderDashboard(gpa, arena, io, out, cli_path, no_color);
        },
        .tag => |tag_args| {
            if (!isSafeCliPath(cli_path)) {
                try out.writeAll("invalid NULLBUILDER_NODE_CLI\n");
                return 2;
            }

            return forwardTagCommand(gpa, arena, io, out, cli_path, tag_args);
        },
    }
}

fn classifyCommand(args: []const []const u8) Command {
    if (args.len <= 1) return .dashboard;

    if (isHelpArg(args[1])) return .help;
    if (isTagCommand(args[1])) return .{ .tag = args[1..] };
    return .invalid;
}

fn isHelpArg(value: []const u8) bool {
    return std.mem.eql(u8, value, "--help") or std.mem.eql(u8, value, "help");
}

fn isTagCommand(value: []const u8) bool {
    return std.mem.eql(u8, value, "build-pr") or std.mem.eql(u8, value, "release-tag");
}

fn isSafeCliPath(value: []const u8) bool {
    if (value.len == 0 or value.len > max_cli_path_bytes) return false;
    if (std.mem.startsWith(u8, value, "-")) return false;
    return !terminal.hasUnsafeControl(value, .{});
}

fn isSafeForwardedArgs(args: []const []const u8) bool {
    return arg_safety.isSafeArgVector(args, .{
        .max_count = max_forwarded_arg_count,
        .max_arg_bytes = max_forwarded_arg_bytes,
        .max_total_bytes = max_forwarded_args_total_bytes,
        .allow_empty_vector = false,
    }, hasArgumentControl);
}

fn isSafeAppArgs(args: []const []const u8) bool {
    return arg_safety.isSafeArgVector(args, .{
        .max_count = max_app_arg_count,
        .max_arg_bytes = max_app_arg_bytes,
        .max_total_bytes = max_app_args_total_bytes,
    }, hasArgumentControl);
}

fn hasArgumentControl(value: []const u8) bool {
    return terminal.hasUnsafeControl(value, .{});
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
    if (!isSafeForwardedArgs(args)) {
        try out.writeAll("invalid command arguments\n");
        return 2;
    }

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

test "commands are classified without falling through to dashboard" {
    try std.testing.expectEqual(Command.dashboard, classifyCommand(&.{}));
    try std.testing.expectEqual(Command.dashboard, classifyCommand(&.{"nullbuilder-tui"}));
    try std.testing.expectEqual(Command.help, classifyCommand(&.{ "nullbuilder-tui", "--help" }));
    try std.testing.expectEqual(Command.help, classifyCommand(&.{ "nullbuilder-tui", "help" }));
    try std.testing.expectEqual(Command.invalid, classifyCommand(&.{ "nullbuilder-tui", "repos" }));
    try std.testing.expectEqual(Command.invalid, classifyCommand(&.{ "nullbuilder-tui", "unknown" }));

    const build_pr_args = &.{ "nullbuilder-tui", "build-pr", "nullclaw/nullbuilder", "--pr", "7" };
    switch (classifyCommand(build_pr_args)) {
        .tag => |tag_args| {
            try std.testing.expectEqualStrings("build-pr", tag_args[0]);
            try std.testing.expectEqualStrings("nullclaw/nullbuilder", tag_args[1]);
        },
        else => return error.UnexpectedCommand,
    }

    const release_tag_args = &.{ "nullbuilder-tui", "release-tag", "nullclaw/nullbuilder", "--tag", "v1.2.3" };
    switch (classifyCommand(release_tag_args)) {
        .tag => |tag_args| try std.testing.expectEqualStrings("release-tag", tag_args[0]),
        else => return error.UnexpectedCommand,
    }
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
    try std.testing.expect(isSafeCliPath("bin/\xd0\xbf\xd1\x83\xd1\x82\xd1\x8c/nullbuilder.js"));

    try std.testing.expect(!isSafeCliPath(""));
    try std.testing.expect(!isSafeCliPath("-e"));
    try std.testing.expect(!isSafeCliPath("--eval=process.exit(1)"));
    try std.testing.expect(!isSafeCliPath("bad\npath"));
    try std.testing.expect(!isSafeCliPath("bad\x00path"));
    try std.testing.expect(!isSafeCliPath("bad\xc2\x85path"));
    try std.testing.expect(!isSafeCliPath(oversized[0..]));
}

test "forwarded tag arguments are bounded before spawning node" {
    const oversized_arg = [_]u8{'a'} ** (max_forwarded_arg_bytes + 1);
    const total_excess = [_]u8{'b'} ** (max_forwarded_args_total_bytes - max_forwarded_arg_bytes + 1);
    const too_many_args = [_][]const u8{"--flag"} ** (max_forwarded_arg_count + 1);

    try std.testing.expect(isSafeForwardedArgs(&.{ "build-pr", "nullclaw/nullbuilder", "--pr", "7", "--tag", "build-pr-7" }));
    try std.testing.expect(isSafeForwardedArgs(&.{ "release-tag", "nullclaw/nullbuilder", "--tag", "v1.2.3", "--ref", "release/v1" }));
    try std.testing.expect(isSafeForwardedArgs(&.{ "release-tag", "nullclaw/nullbuilder", "--tag", "v1.2.3", "--ref", "release-\xd0\xbf\xd1\x83\xd1\x82\xd1\x8c" }));

    try std.testing.expect(!isSafeForwardedArgs(&.{}));
    try std.testing.expect(!isSafeForwardedArgs(&.{ "build-pr", "" }));
    try std.testing.expect(!isSafeForwardedArgs(too_many_args[0..]));
    try std.testing.expect(!isSafeForwardedArgs(&.{ "build-pr", oversized_arg[0..] }));
    try std.testing.expect(!isSafeForwardedArgs(&.{ "build-pr", "a", total_excess[0..] }));
    try std.testing.expect(!isSafeForwardedArgs(&.{ "build-pr", "bad\nrepo" }));
    try std.testing.expect(!isSafeForwardedArgs(&.{ "build-pr", "bad\xc2\x85repo" }));
}

test "top-level app arguments are bounded before command classification" {
    const max_arg = [_]u8{'a'} ** max_app_arg_bytes;
    const oversized_arg = [_]u8{'a'} ** (max_app_arg_bytes + 1);
    const total_excess = [_]u8{'b'} ** (max_app_args_total_bytes - max_app_arg_bytes + 1);
    const too_many_args = [_][]const u8{"--flag"} ** (max_app_arg_count + 1);

    try std.testing.expect(isSafeAppArgs(&.{}));
    try std.testing.expect(isSafeAppArgs(&.{"nullbuilder-tui"}));
    try std.testing.expect(isSafeAppArgs(&.{ "nullbuilder-tui", "--help" }));
    try std.testing.expect(isSafeAppArgs(&.{ "nullbuilder-tui", "build-pr", "nullclaw/nullbuilder", "--pr", "7" }));
    try std.testing.expect(isSafeAppArgs(&.{ "nullbuilder-tui", "release-tag", "nullclaw/nullbuilder", "--ref", "release-\xd0\xbf\xd1\x83\xd1\x82\xd1\x8c" }));

    try std.testing.expect(!isSafeAppArgs(too_many_args[0..]));
    try std.testing.expect(!isSafeAppArgs(&.{ "nullbuilder-tui", "" }));
    try std.testing.expect(!isSafeAppArgs(&.{ "nullbuilder-tui", oversized_arg[0..] }));
    try std.testing.expect(!isSafeAppArgs(&.{ "nullbuilder-tui", max_arg[0..], total_excess[0..] }));
    try std.testing.expect(!isSafeAppArgs(&.{ "nullbuilder-tui", "bad\ncommand" }));
    try std.testing.expect(!isSafeAppArgs(&.{ "nullbuilder-tui", "bad\xc2\x85command" }));
    try std.testing.expect(!isSafeAppArgs(&.{ "nullbuilder-tui", "bad\xe2\x80\xaecommand" }));
}

test "help command returns before validating node cli path" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const exit_code = try run(
        std.testing.allocator,
        std.testing.allocator,
        undefined,
        &out.writer,
        "-e",
        true,
        &.{ "nullbuilder-tui", "--help" },
    );

    try std.testing.expectEqual(@as(?u8, null), exit_code);
    try std.testing.expect(std.mem.indexOf(u8, out.writer.buffered(), "nullbuilder-tui") != null);
    try std.testing.expect(std.mem.indexOf(u8, out.writer.buffered(), "invalid NULLBUILDER_NODE_CLI") == null);
}

test "run rejects unsafe top-level arguments before command handling" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const exit_code = try run(
        std.testing.allocator,
        std.testing.allocator,
        undefined,
        &out.writer,
        "./bin/nullbuilder.js",
        true,
        &.{ "nullbuilder-tui", "--help\nhidden" },
    );

    try std.testing.expectEqual(@as(?u8, 2), exit_code);
    try std.testing.expectEqualStrings("invalid command arguments\n", out.writer.buffered());
}
