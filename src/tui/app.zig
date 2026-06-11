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

const HelpCommand = enum {
    long,
    short,
    word,

    fn fromArg(value: []const u8) ?HelpCommand {
        return registeredLabelFromArg(HelpCommand, help_commands[0..], value);
    }

    fn label(self: HelpCommand) []const u8 {
        return switch (self) {
            .long => "--help",
            .short => "-h",
            .word => "help",
        };
    }
};

const help_commands = [_]HelpCommand{ .long, .short, .word };

const TagCommandKind = enum {
    build_pr,
    release_tag,

    fn fromArg(value: []const u8) ?TagCommandKind {
        return registeredLabelFromArg(TagCommandKind, tag_command_kinds[0..], value);
    }

    fn label(self: TagCommandKind) []const u8 {
        return switch (self) {
            .build_pr => "build-pr",
            .release_tag => "release-tag",
        };
    }
};

const tag_command_kinds = [_]TagCommandKind{ .build_pr, .release_tag };

const TagCommand = struct {
    kind: TagCommandKind,
    args: []const []const u8,
};

const CliCommand = union(enum) {
    dashboard,
    tag: TagCommand,
};

const Command = union(enum) {
    help,
    cli: CliCommand,
    invalid,
};

const CliPathSegment = enum {
    root,
    current_dir_prefix,
    normal,
    empty,
    current_dir,
    parent_dir,

    fn isAllowed(self: CliPathSegment) bool {
        return switch (self) {
            .root, .current_dir_prefix, .normal => true,
            .empty, .current_dir, .parent_dir => false,
        };
    }
};

const CliPathValidation = enum {
    safe,
    empty,
    oversized,
    option_like,
    trailing_slash,
    backslash,
    windows_drive_prefix,
    unsafe_segment,
    unsafe_control,

    fn accepts(self: CliPathValidation) bool {
        return self == .safe;
    }
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
    if (TagCommandKind.fromArg(args[1])) |kind| {
        return .{ .cli = .{ .tag = .{
            .kind = kind,
            .args = args[1..],
        } } };
    }
    return .invalid;
}

fn isHelpArg(value: []const u8) bool {
    return HelpCommand.fromArg(value) != null;
}

fn isTagCommand(value: []const u8) bool {
    return TagCommandKind.fromArg(value) != null;
}

fn registeredLabelFromArg(
    comptime Label: type,
    registry: []const Label,
    value: []const u8,
) ?Label {
    for (registry) |candidate| {
        if (std.mem.eql(u8, value, candidate.label())) return candidate;
    }

    return null;
}

fn isSafeCliPath(value: []const u8) bool {
    return classifyCliPath(value).accepts();
}

fn classifyCliPath(value: []const u8) CliPathValidation {
    if (value.len == 0) return .empty;
    if (value.len > max_cli_path_bytes) return .oversized;
    if (isOptionLikeCliPath(value)) return .option_like;
    if (hasTrailingPathSeparator(value)) return .trailing_slash;
    if (hasWindowsPathSeparator(value)) return .backslash;
    if (hasWindowsDrivePrefix(value)) return .windows_drive_prefix;
    if (hasUnsafeCliPathSegment(value)) return .unsafe_segment;
    if (terminal.hasUnsafeControl(value, .{})) return .unsafe_control;
    return .safe;
}

fn hasUnsafeCliPathSegment(value: []const u8) bool {
    var segment_start: usize = 0;
    var segment_index: usize = 0;
    while (segment_start <= value.len) {
        var segment_end = segment_start;
        while (segment_end < value.len and value[segment_end] != '/') {
            segment_end += 1;
        }

        const segment = value[segment_start..segment_end];
        if (!classifyCliPathSegment(value, segment, segment_index, segment_end).isAllowed()) {
            return true;
        }

        if (segment_end == value.len) return false;
        segment_start = segment_end + 1;
        segment_index += 1;
    }

    return false;
}

fn isOptionLikeCliPath(value: []const u8) bool {
    return value.len > 0 and value[0] == '-';
}

fn hasTrailingPathSeparator(value: []const u8) bool {
    return value.len > 0 and value[value.len - 1] == '/';
}

fn hasWindowsPathSeparator(value: []const u8) bool {
    return std.mem.indexOfScalar(u8, value, '\\') != null;
}

fn classifyCliPathSegment(
    path: []const u8,
    segment: []const u8,
    segment_index: usize,
    segment_end: usize,
) CliPathSegment {
    if (segment.len == 0) {
        return if (segment_index == 0 and path.len > 0 and path[0] == '/') .root else .empty;
    }
    if (std.mem.eql(u8, segment, "..")) return .parent_dir;
    if (std.mem.eql(u8, segment, ".")) {
        return if (segment_index == 0 and segment_end < path.len) .current_dir_prefix else .current_dir;
    }
    return .normal;
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
        .tag => |tag_command| forwardTagCommand(gpa, io, out, cli_path, tag_command),
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

    if (try cli.exitCodeForFailure(out, result, .success_or_read_errors)) |exit_code| {
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
    command: TagCommand,
) !?u8 {
    if (!hasMatchingTagCommandLabel(command) or !isSafeForwardedArgs(command.args)) {
        try out.writeAll("invalid command arguments\n");
        return 2;
    }

    var argv_buffer: [max_node_cli_arg_count][]const u8 = undefined;
    const argv = buildNodeCliArgv(&argv_buffer, cli_path, command.args) orelse {
        try out.writeAll("invalid command arguments\n");
        return 2;
    };

    const result = try cli.run(gpa, io, argv, .{});
    defer cli.freeResult(gpa, result);

    if (try cli.exitCodeForFailure(out, result, .success_only)) |exit_code| {
        return exit_code;
    }

    try cli.writeCaptured(out, result);
    return null;
}

fn hasMatchingTagCommandLabel(command: TagCommand) bool {
    return command.args.len > 0 and std.mem.eql(u8, command.args[0], command.kind.label());
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
    try std.testing.expectEqual(Command.help, classifyCommand(&.{ "nullbuilder-tui", "-h" }));
    try std.testing.expectEqual(Command.help, classifyCommand(&.{ "nullbuilder-tui", "help" }));
    try std.testing.expectEqual(Command.invalid, classifyCommand(&.{ "nullbuilder-tui", "repos" }));
    try std.testing.expectEqual(Command.invalid, classifyCommand(&.{ "nullbuilder-tui", "unknown" }));

    const build_pr_args = &.{ "nullbuilder-tui", "build-pr", "nullclaw/nullbuilder", "--pr", "7" };
    const build_pr_tag_command = try expectTagCommand(classifyCommand(build_pr_args));
    try std.testing.expectEqual(TagCommandKind.build_pr, build_pr_tag_command.kind);
    try std.testing.expectEqualStrings("build-pr", build_pr_tag_command.args[0]);
    try std.testing.expectEqualStrings("nullclaw/nullbuilder", build_pr_tag_command.args[1]);

    const release_tag_args = &.{ "nullbuilder-tui", "release-tag", "nullclaw/nullbuilder", "--tag", "v1.2.3" };
    const release_tag_command = try expectTagCommand(classifyCommand(release_tag_args));
    try std.testing.expectEqual(TagCommandKind.release_tag, release_tag_command.kind);
    try std.testing.expectEqualStrings("release-tag", release_tag_command.args[0]);
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

fn expectTagCommand(command: Command) !TagCommand {
    return switch (command) {
        .cli => |cli_command| switch (cli_command) {
            .tag => |tag_command| tag_command,
            else => error.UnexpectedCommand,
        },
        else => error.UnexpectedCommand,
    };
}

test "command registries map labels to typed command kinds" {
    try std.testing.expectEqual(@as(usize, 3), help_commands.len);
    for (help_commands) |command| {
        try std.testing.expectEqual(command, HelpCommand.fromArg(command.label()).?);
    }
    try std.testing.expectEqual(@as(?HelpCommand, null), HelpCommand.fromArg("build-pr"));

    try std.testing.expectEqual(@as(usize, 2), tag_command_kinds.len);
    for (tag_command_kinds) |kind| {
        try std.testing.expectEqual(kind, TagCommandKind.fromArg(kind.label()).?);
    }
    try std.testing.expectEqual(@as(?TagCommandKind, null), TagCommandKind.fromArg("repos"));
}

test "tag command payloads match their typed command kind" {
    try std.testing.expect(hasMatchingTagCommandLabel(.{
        .kind = .build_pr,
        .args = &.{ "build-pr", "nullclaw/nullbuilder", "--pr", "7" },
    }));
    try std.testing.expect(hasMatchingTagCommandLabel(.{
        .kind = .release_tag,
        .args = &.{ "release-tag", "nullclaw/nullbuilder", "--tag", "v1.2.3" },
    }));

    try std.testing.expect(!hasMatchingTagCommandLabel(.{
        .kind = .build_pr,
        .args = &.{ "release-tag", "nullclaw/nullbuilder", "--tag", "v1.2.3" },
    }));
    try std.testing.expect(!hasMatchingTagCommandLabel(.{
        .kind = .release_tag,
        .args = &.{},
    }));
}

test "tag commands are detected explicitly" {
    try std.testing.expect(isTagCommand("build-pr"));
    try std.testing.expect(isTagCommand("release-tag"));
    try std.testing.expect(!isTagCommand("repos"));
    try std.testing.expect(isHelpArg("--help"));
    try std.testing.expect(isHelpArg("-h"));
    try std.testing.expect(isHelpArg("help"));
    try std.testing.expect(!isHelpArg("build-pr"));
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

test "node cli path validation classifies rejection reasons" {
    const oversized = [_]u8{'a'} ** (max_cli_path_bytes + 1);

    try expectCliPathValidation(.safe, "./bin/nullbuilder.js");
    try expectCliPathValidation(.empty, "");
    try expectCliPathValidation(.oversized, oversized[0..]);
    try expectCliPathValidation(.option_like, "-e");
    try expectCliPathValidation(.option_like, "--eval=process.exit(1)");
    try expectCliPathValidation(.trailing_slash, "./");
    try expectCliPathValidation(.trailing_slash, "/");
    try expectCliPathValidation(.backslash, "C:\\tmp\\nullbuilder.js");
    try expectCliPathValidation(.windows_drive_prefix, "C:/tmp/nullbuilder.js");
    try expectCliPathValidation(.unsafe_segment, "../bin/nullbuilder.js");
    try expectCliPathValidation(.unsafe_segment, "bin/./nullbuilder.js");
    try expectCliPathValidation(.unsafe_segment, "bin//nullbuilder.js");
    try expectCliPathValidation(.unsafe_control, "bad\npath");

    try std.testing.expect(CliPathValidation.safe.accepts());
    try std.testing.expect(!CliPathValidation.empty.accepts());
    try std.testing.expect(!CliPathValidation.unsafe_control.accepts());
}

fn expectCliPathValidation(expected: CliPathValidation, value: []const u8) !void {
    try std.testing.expectEqual(expected, classifyCliPath(value));
}

test "node cli path segments classify traversal and roots explicitly" {
    try std.testing.expectEqual(CliPathSegment.current_dir_prefix, classifyCliPathSegment("./bin/nullbuilder.js", ".", 0, 1));
    try std.testing.expectEqual(CliPathSegment.root, classifyCliPathSegment("/tmp/nullbuilder.js", "", 0, 0));
    try std.testing.expectEqual(CliPathSegment.normal, classifyCliPathSegment("bin/nullbuilder.js", "bin", 0, 3));
    try std.testing.expectEqual(CliPathSegment.current_dir, classifyCliPathSegment("bin/./nullbuilder.js", ".", 1, 5));
    try std.testing.expectEqual(CliPathSegment.parent_dir, classifyCliPathSegment("../bin/nullbuilder.js", "..", 0, 2));
    try std.testing.expectEqual(CliPathSegment.empty, classifyCliPathSegment("bin//nullbuilder.js", "", 1, 4));

    try std.testing.expect(CliPathSegment.current_dir_prefix.isAllowed());
    try std.testing.expect(CliPathSegment.root.isAllowed());
    try std.testing.expect(CliPathSegment.normal.isAllowed());
    try std.testing.expect(!CliPathSegment.current_dir.isAllowed());
    try std.testing.expect(!CliPathSegment.parent_dir.isAllowed());
    try std.testing.expect(!CliPathSegment.empty.isAllowed());
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
