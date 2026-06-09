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

    const tui_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/tui/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_tui_tests = b.addRunArtifact(tui_tests);

    const test_step = b.step("test", "Run Zig tests");
    test_step.dependOn(&run_tui_tests.step);

    const action_args_module = b.createModule(.{
        .root_source_file = b.path(".github/actions/action_args.zig"),
        .target = target,
        .optimize = optimize,
    });

    const action_args_tests = b.addTest(.{
        .root_module = action_args_module,
    });
    const run_action_args_tests = b.addRunArtifact(action_args_tests);
    test_step.dependOn(&run_action_args_tests.step);

    const action_paths_module = b.createModule(.{
        .root_source_file = b.path(".github/actions/action_paths.zig"),
        .target = target,
        .optimize = optimize,
    });

    const action_paths_tests = b.addTest(.{
        .root_module = action_paths_module,
    });
    const run_action_paths_tests = b.addRunArtifact(action_paths_tests);
    test_step.dependOn(&run_action_paths_tests.step);

    const nightly_decide_module = b.createModule(.{
        .root_source_file = b.path(".github/actions/nightly-decide/nightly_decide.zig"),
        .target = target,
        .optimize = optimize,
    });
    nightly_decide_module.addImport("action_args", action_args_module);
    nightly_decide_module.addImport("action_paths", action_paths_module);

    const nightly_decide_tests = b.addTest(.{
        .root_module = nightly_decide_module,
    });
    const run_nightly_decide_tests = b.addRunArtifact(nightly_decide_tests);
    test_step.dependOn(&run_nightly_decide_tests.step);

    const package_artifact_module = b.createModule(.{
        .root_source_file = b.path(".github/actions/package-artifact/package_artifact.zig"),
        .target = target,
        .optimize = optimize,
    });
    package_artifact_module.addImport("action_args", action_args_module);
    package_artifact_module.addImport("action_paths", action_paths_module);

    const package_artifact_tests = b.addTest(.{
        .root_module = package_artifact_module,
    });
    const run_package_artifact_tests = b.addRunArtifact(package_artifact_tests);
    test_step.dependOn(&run_package_artifact_tests.step);
}
