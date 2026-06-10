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
    defer stdout_writer.interface.flush() catch {};
    const out = &stdout_writer.interface;

    const args = try init.args.toSlice(arena);
    const cli_path = environ_map.get("NULLBUILDER_NODE_CLI") orelse "./bin/nullbuilder.js";
    const no_color = environ_map.get("NO_COLOR") != null;

    if (try app.run(gpa, arena, io, out, cli_path, no_color, args)) |exit_code| {
        std.process.exit(exit_code);
    }
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
