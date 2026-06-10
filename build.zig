const std = @import("std");

const ZigBuildOptions = struct {
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
};

const SharedActionModules = struct {
    args: *std.Build.Module,
    paths: *std.Build.Module,
    text: *std.Build.Module,
    values: *std.Build.Module,
};

pub fn build(b: *std.Build) void {
    const options = ZigBuildOptions{
        .target = b.standardTargetOptions(.{}),
        .optimize = b.standardOptimizeOption(.{}),
    };

    const tui_module = createModule(b, options, "src/tui/main.zig");
    const tui = b.addExecutable(.{
        .name = "nullbuilder-tui",
        .root_module = tui_module,
    });

    b.installArtifact(tui);

    const run_tui = b.addRunArtifact(tui);
    if (b.args) |args| {
        run_tui.addArgs(args);
    }

    const tui_step = b.step("tui", "Run the nullbuilder Zig terminal dashboard");
    tui_step.dependOn(&run_tui.step);

    const test_step = b.step("test", "Run Zig tests");
    addModuleTest(b, test_step, tui_module);

    const action_text_module = createModule(b, options, ".github/actions/action_text.zig");
    const action_modules = SharedActionModules{
        .args = createModule(b, options, ".github/actions/action_args.zig"),
        .paths = createModule(b, options, ".github/actions/action_paths.zig"),
        .text = action_text_module,
        .values = createModule(b, options, ".github/actions/action_values.zig"),
    };
    action_modules.args.addImport("action_text", action_modules.text);
    action_modules.values.addImport("action_text", action_modules.text);
    addModuleTest(b, test_step, action_modules.args);
    addModuleTest(b, test_step, action_modules.paths);
    addModuleTest(b, test_step, action_modules.text);
    addModuleTest(b, test_step, action_modules.values);

    const nightly_decide_module = createActionModule(
        b,
        options,
        ".github/actions/nightly-decide/nightly_decide.zig",
        action_modules,
    );
    addModuleTest(b, test_step, nightly_decide_module);

    const package_artifact_module = createActionModule(
        b,
        options,
        ".github/actions/package-artifact/package_artifact.zig",
        action_modules,
    );
    addModuleTest(b, test_step, package_artifact_module);
}

fn createModule(b: *std.Build, options: ZigBuildOptions, root_source_file: []const u8) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = b.path(root_source_file),
        .target = options.target,
        .optimize = options.optimize,
    });
}

fn createActionModule(
    b: *std.Build,
    options: ZigBuildOptions,
    root_source_file: []const u8,
    action_modules: SharedActionModules,
) *std.Build.Module {
    const module = createModule(b, options, root_source_file);
    module.addImport("action_args", action_modules.args);
    module.addImport("action_paths", action_modules.paths);
    module.addImport("action_values", action_modules.values);
    return module;
}

fn addModuleTest(b: *std.Build, test_step: *std.Build.Step, module: *std.Build.Module) void {
    const tests = b.addTest(.{ .root_module = module });
    const run_tests = b.addRunArtifact(tests);
    test_step.dependOn(&run_tests.step);
}
