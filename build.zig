const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const tui = b.addExecutable(.{
        .name = "nullbuilder-tui",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/tui/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    b.installArtifact(tui);

    const run_tui = b.addRunArtifact(tui);
    if (b.args) |args| {
        run_tui.addArgs(args);
    }

    const tui_step = b.step("tui", "Run the nullbuilder Zig terminal dashboard");
    tui_step.dependOn(&run_tui.step);
}
