const std = @import("std");

const arg_safety = @import("arg_safety");
const cli = @import("cli.zig");
const dashboard = @import("dashboard.zig");
const terminal = @import("terminal.zig");

const max_cli_path_bytes = 4096;
const max_forwarded_arg_count = 64;
const max_forwarded_arg_bytes = 4096;
const max_forwarded_args_total_bytes = 64 * 1024;
const node_cli_prefix_arg_count = 2;
const max_node_cli_arg_count = max_forwarded_arg_count + node_cli_prefix_arg_count;
const max_app_arg_count = max_forwarded_arg_count + 1;
const max_app_arg_bytes = max_forwarded_arg_bytes;
const max_app_args_total_bytes = max_forwarded_args_total_bytes + max_cli_path_bytes;

const CliCommand = union(enum) {
    dashboard,
    tag: []const []const u8,
};

const Command = union(enum) {
    help,
    cli: CliCommand,
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

    const command = classifyCommand(args);
    switch (command) {
        .help => {
            try printHelp(out);
            return null;
        },
        .invalid => {
            try out.writeAll("invalid command\n");
            return 2;
        },
        .cli => |cli_command| return runCliCommand(gpa, arena, io, out, cli_path, no_color, cli_command),
    }
}

fn classifyCommand(args: []const []const u8) Command {
    if (args.len <= 1) return .{ .cli = .dashboard };

    if (isHelpArg(args[1])) return .help;
    if (isTagCommand(args[1])) return .{ .cli = .{ .tag = args[1..] } };
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
    if (hasUnsafeCliPathSyntax(value)) return false;
    return !terminal.hasUnsafeControl(value, .{});
}

fn hasUnsafeCliPathSyntax(value: []const u8) bool {
    if (std.mem.endsWith(u8, value, "/")) return true;
    if (std.mem.indexOfScalar(u8, value, '\\') != null) return true;
    if (hasWindowsDrivePrefix(value)) return true;

    var segment_start: usize = 0;
    var segment_index: usize = 0;
    while (segment_start <= value.len) {
        var segment_end = segment_start;
        while (segment_end < value.len and value[segment_end] != '/') {
            segment_end += 1;
        }

        const segment = value[segment_start..segment_end];
        if (!isSafeCliPathSegment(value, segment, segment_index, segment_end)) {
            return true;
        }

        if (segment_end == value.len) return false;
        segment_start = segment_end + 1;
        segment_index += 1;
    }

    return false;
}

fn isSafeCliPathSegment(
    path: []const u8,
    segment: []const u8,
    segment_index: usize,
    segment_end: usize,
) bool {
    if (segment.len == 0) {
        return segment_index == 0 and path[0] == '/';
    }
    if (std.mem.eql(u8, segment, "..")) return false;
    if (std.mem.eql(u8, segment, ".")) {
        return segment_index == 0 and segment_end < path.len;
    }
    return true;
}

fn hasWindowsDrivePrefix(value: []const u8) bool {
    return value.len >= 2 and std.ascii.isAlphabetic(value[0]) and value[1] == ':';
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

fn runCliCommand(
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    io: std.Io,
    out: *std.Io.Writer,
    cli_path: []const u8,
    no_color: bool,
    command: CliCommand,
) !?u8 {
    if (!isSafeCliPath(cli_path)) {
        try out.writeAll("invalid NULLBUILDER_NODE_CLI\n");
        return 2;
    }

    return switch (command) {
        .dashboard => renderDashboard(gpa, arena, io, out, cli_path, no_color),
        .tag => |tag_args| forwardTagCommand(gpa, io, out, cli_path, tag_args),
    };
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
    io: std.Io,
    out: *std.Io.Writer,
    cli_path: []const u8,
    args: []const []const u8,
) !?u8 {
    if (!isSafeForwardedArgs(args)) {
        try out.writeAll("invalid command arguments\n");
        return 2;
    }

    var argv_buffer: [max_node_cli_arg_count][]const u8 = undefined;
    const argv = buildNodeCliArgv(&argv_buffer, cli_path, args) orelse {
        try out.writeAll("invalid command arguments\n");
        return 2;
    };

    const result = try cli.run(gpa, io, argv, .{});
    defer cli.freeResult(gpa, result);

    if (try cli.exitCodeForFailure(out, result, &.{0})) |exit_code| {
        return exit_code;
    }

    try cli.writeCaptured(out, result);
    return null;
}

fn buildNodeCliArgv(
    buffer: *[max_node_cli_arg_count][]const u8,
    cli_path: []const u8,
    args: []const []const u8,
) ?[]const []const u8 {
    if (args.len > max_forwarded_arg_count) return null;

    buffer[0] = "node";
    buffer[1] = cli_path;

    for (args, 0..) |arg, index| {
        buffer[node_cli_prefix_arg_count + index] = arg;
    }

    return buffer[0 .. node_cli_prefix_arg_count + args.len];
}

test "commands are classified without falling through to dashboard" {
    try expectDashboardCommand(classifyCommand(&.{}));
    try expectDashboardCommand(classifyCommand(&.{"nullbuilder-tui"}));
    try std.testing.expectEqual(Command.help, classifyCommand(&.{ "nullbuilder-tui", "--help" }));
    try std.testing.expectEqual(Command.help, classifyCommand(&.{ "nullbuilder-tui", "help" }));
    try std.testing.expectEqual(Command.invalid, classifyCommand(&.{ "nullbuilder-tui", "repos" }));
    try std.testing.expectEqual(Command.invalid, classifyCommand(&.{ "nullbuilder-tui", "unknown" }));

    const build_pr_args = &.{ "nullbuilder-tui", "build-pr", "nullclaw/nullbuilder", "--pr", "7" };
    const build_pr_tag_args = try expectTagCommand(classifyCommand(build_pr_args));
    try std.testing.expectEqualStrings("build-pr", build_pr_tag_args[0]);
    try std.testing.expectEqualStrings("nullclaw/nullbuilder", build_pr_tag_args[1]);

    const release_tag_args = &.{ "nullbuilder-tui", "release-tag", "nullclaw/nullbuilder", "--tag", "v1.2.3" };
    const release_tag_command_args = try expectTagCommand(classifyCommand(release_tag_args));
    try std.testing.expectEqualStrings("release-tag", release_tag_command_args[0]);
}

fn expectDashboardCommand(command: Command) !void {
    switch (command) {
        .cli => |cli_command| switch (cli_command) {
            .dashboard => {},
            else => return error.UnexpectedCommand,
        },
        else => return error.UnexpectedCommand,
    }
}

fn expectTagCommand(command: Command) ![]const []const u8 {
    return switch (command) {
        .cli => |cli_command| switch (cli_command) {
            .tag => |tag_args| tag_args,
            else => error.UnexpectedCommand,
        },
        else => error.UnexpectedCommand,
    };
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

test "node cli path rejects traversal and ambiguous path segments" {
    try std.testing.expect(isSafeCliPath("./bin/nullbuilder.js"));
    try std.testing.expect(isSafeCliPath("/tmp/nullbuilder.js"));
    try std.testing.expect(isSafeCliPath("scripts/nullbuilder.js"));

    try std.testing.expect(!isSafeCliPath("."));
    try std.testing.expect(!isSafeCliPath("./"));
    try std.testing.expect(!isSafeCliPath("/"));
    try std.testing.expect(!isSafeCliPath("../bin/nullbuilder.js"));
    try std.testing.expect(!isSafeCliPath("./../bin/nullbuilder.js"));
    try std.testing.expect(!isSafeCliPath("bin/../nullbuilder.js"));
    try std.testing.expect(!isSafeCliPath("bin/./nullbuilder.js"));
    try std.testing.expect(!isSafeCliPath("bin//nullbuilder.js"));
    try std.testing.expect(!isSafeCliPath("//tmp/nullbuilder.js"));
    try std.testing.expect(!isSafeCliPath("/tmp//nullbuilder.js"));
    try std.testing.expect(!isSafeCliPath("/tmp/../nullbuilder.js"));
    try std.testing.expect(!isSafeCliPath("/tmp/./nullbuilder.js"));
    try std.testing.expect(!isSafeCliPath("/tmp/nullbuilder.js/"));
    try std.testing.expect(!isSafeCliPath("C:/tmp/nullbuilder.js"));
    try std.testing.expect(!isSafeCliPath("C:\\tmp\\nullbuilder.js"));
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

test "node cli argv uses caller owned bounded storage" {
    var buffer: [max_node_cli_arg_count][]const u8 = undefined;
    const argv = buildNodeCliArgv(&buffer, "./bin/nullbuilder.js", &.{
        "release-tag",
        "nullclaw/nullbuilder",
        "--tag",
        "v1.2.3",
    }) orelse return error.UnexpectedNull;

    try std.testing.expectEqual(@as(usize, 6), argv.len);
    try std.testing.expectEqualStrings("node", argv[0]);
    try std.testing.expectEqualStrings("./bin/nullbuilder.js", argv[1]);
    try std.testing.expectEqualStrings("release-tag", argv[2]);
    try std.testing.expectEqualStrings("nullclaw/nullbuilder", argv[3]);
    try std.testing.expectEqualStrings("--tag", argv[4]);
    try std.testing.expectEqualStrings("v1.2.3", argv[5]);

    const too_many_args = [_][]const u8{"--flag"} ** (max_forwarded_arg_count + 1);
    try std.testing.expect(buildNodeCliArgv(&buffer, "./bin/nullbuilder.js", too_many_args[0..]) == null);
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

test "cli-backed commands validate node cli path before spawning" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();

    const exit_code = try run(
        std.testing.allocator,
        std.testing.allocator,
        undefined,
        &out.writer,
        "-e",
        true,
        &.{ "nullbuilder-tui", "release-tag", "nullclaw/nullbuilder", "--tag", "v1.2.3" },
    );

    try std.testing.expectEqual(@as(?u8, 2), exit_code);
    try std.testing.expectEqualStrings("invalid NULLBUILDER_NODE_CLI\n", out.writer.buffered());
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
