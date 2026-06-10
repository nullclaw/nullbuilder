const std = @import("std");

const app = @import("app.zig");

pub fn main(init: std.process.Init.Minimal) !void {
    var debug_allocator: std.heap.DebugAllocator(.{}) = .init;
    defer std.debug.assert(debug_allocator.deinit() == .ok);
    const gpa = debug_allocator.allocator();

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var environ_map = try init.environ.createMap(gpa);
    defer environ_map.deinit();

    var threaded: std.Io.Threaded = .init(gpa, .{
        .argv0 = .init(init.args),
        .environ = init.environ,
    });
    defer threaded.deinit();
    const io = threaded.io();

    var stdout_buffer: [8192]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(io, &stdout_buffer);
    const out = &stdout_writer.interface;

    const args = try init.args.toSlice(arena);
    const cli_path = environ_map.get("NULLBUILDER_NODE_CLI") orelse "./bin/nullbuilder.js";
    const no_color = environ_map.get("NO_COLOR") != null;

    if (try runAppAndFlush(gpa, arena, io, out, cli_path, no_color, args)) |exit_code| {
        std.process.exit(exit_code);
    }
}

fn runAppAndFlush(
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    io: std.Io,
    out: *std.Io.Writer,
    cli_path: []const u8,
    no_color: bool,
    args: []const []const u8,
) !?u8 {
    const exit_code = try app.run(gpa, arena, io, out, cli_path, no_color, args);
    try out.flush();
    return exit_code;
}

test "main helper flushes app output before returning exit code" {
    var help_out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer help_out.deinit();

    const help_exit_code = try runAppAndFlush(
        std.testing.allocator,
        std.testing.allocator,
        undefined,
        &help_out.writer,
        "./bin/nullbuilder.js",
        true,
        &.{ "nullbuilder-tui", "--help" },
    );

    try std.testing.expectEqual(@as(?u8, null), help_exit_code);
    try std.testing.expect(std.mem.indexOf(u8, help_out.writer.buffered(), "nullbuilder-tui") != null);

    var invalid_out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer invalid_out.deinit();

    const invalid_exit_code = try runAppAndFlush(
        std.testing.allocator,
        std.testing.allocator,
        undefined,
        &invalid_out.writer,
        "./bin/nullbuilder.js",
        true,
        &.{ "nullbuilder-tui", "unknown" },
    );

    try std.testing.expectEqual(@as(?u8, 2), invalid_exit_code);
    try std.testing.expectEqualStrings("invalid command\n", invalid_out.writer.buffered());
}

test {
    std.testing.refAllDecls(@import("app.zig"));
    std.testing.refAllDecls(@import("cli.zig"));
    std.testing.refAllDecls(@import("dashboard.zig"));
    std.testing.refAllDecls(@import("dashboard_json.zig"));
    std.testing.refAllDecls(@import("dashboard_model.zig"));
    std.testing.refAllDecls(@import("dashboard_runs.zig"));
    std.testing.refAllDecls(@import("repository_safety"));
    std.testing.refAllDecls(@import("terminal.zig"));
    std.testing.refAllDecls(@import("text_safety"));
}
