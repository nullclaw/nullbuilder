const std = @import("std");

const arg_safety = @import("src/zig/arg_safety.zig");
const text_safety = @import("src/zig/text_safety.zig");

const ZigBuildOptions = struct {
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
};

const SharedActionModules = struct {
    args: *std.Build.Module,
    json: *std.Build.Module,
    paths: *std.Build.Module,
    text: *std.Build.Module,
    values: *std.Build.Module,
};

const max_tui_run_arg_count = 64;
const max_tui_run_arg_bytes = 4096;
const max_tui_run_args_total_bytes = 64 * 1024;

pub fn build(b: *std.Build) void {
    const options = ZigBuildOptions{
        .target = b.standardTargetOptions(.{}),
        .optimize = b.standardOptimizeOption(.{}),
    };

    const arg_safety_module = createModule(b, options, "src/zig/arg_safety.zig");
    const repository_safety_module = createModule(b, options, "src/zig/repository_safety.zig");
    const text_safety_module = createModule(b, options, "src/zig/text_safety.zig");
    repository_safety_module.addImport("text_safety", text_safety_module);
    const tui_module = createModule(b, options, "src/tui/main.zig");
    tui_module.addImport("arg_safety", arg_safety_module);
    tui_module.addImport("repository_safety", repository_safety_module);
    tui_module.addImport("text_safety", text_safety_module);
    const tui = b.addExecutable(.{
        .name = "nullbuilder-tui",
        .root_module = tui_module,
    });

    b.installArtifact(tui);

    const run_tui = b.addRunArtifact(tui);
    if (b.args) |args| {
        if (!isSafeTuiRunArgs(args)) {
            std.log.err("invalid tui arguments", .{});
            b.invalid_user_input = true;
            return;
        }
        run_tui.addArgs(args);
    }

    const tui_step = b.step("tui", "Run the nullbuilder Zig terminal dashboard");
    tui_step.dependOn(&run_tui.step);

    const test_step = b.step("test", "Run Zig tests");
    addModuleTest(b, test_step, createModule(b, options, "build.zig"));
    addModuleTest(b, test_step, arg_safety_module);
    addModuleTest(b, test_step, repository_safety_module);
    addModuleTest(b, test_step, text_safety_module);
    addModuleTest(b, test_step, tui_module);

    const action_text_module = createModule(b, options, ".github/actions/action_text.zig");
    action_text_module.addImport("text_safety", text_safety_module);
    const action_values_module = createModule(b, options, ".github/actions/action_values.zig");
    action_values_module.addImport("action_text", action_text_module);
    action_values_module.addImport("repository_safety", repository_safety_module);
    action_values_module.addImport("text_safety", text_safety_module);
    const action_paths_module = createModule(b, options, ".github/actions/action_paths.zig");
    action_paths_module.addImport("text_safety", text_safety_module);
    const action_json_module = createModule(b, options, ".github/actions/action_json.zig");
    action_json_module.addImport("action_values", action_values_module);
    const action_modules = SharedActionModules{
        .args = createModule(b, options, ".github/actions/action_args.zig"),
        .json = action_json_module,
        .paths = action_paths_module,
        .text = action_text_module,
        .values = action_values_module,
    };
    action_modules.args.addImport("action_text", action_modules.text);
    addModuleTest(b, test_step, action_modules.args);
    addModuleTest(b, test_step, action_modules.json);
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
    module.addImport("action_json", action_modules.json);
    module.addImport("action_paths", action_modules.paths);
    module.addImport("action_values", action_modules.values);
    return module;
}

fn addModuleTest(b: *std.Build, test_step: *std.Build.Step, module: *std.Build.Module) void {
    const tests = b.addTest(.{ .root_module = module });
    const run_tests = b.addRunArtifact(tests);
    test_step.dependOn(&run_tests.step);
}

fn isSafeTuiRunArgs(args: []const []const u8) bool {
    return arg_safety.isSafeArgVector(args, .{
        .max_count = max_tui_run_arg_count,
        .max_arg_bytes = max_tui_run_arg_bytes,
        .max_total_bytes = max_tui_run_args_total_bytes,
    }, hasUnsafeText);
}

fn hasUnsafeText(value: []const u8) bool {
    return text_safety.hasControl(value);
}

test "tui run args are bounded before build runner forwarding" {
    const max_arg = [_]u8{'a'} ** max_tui_run_arg_bytes;
    const oversized_arg = [_]u8{'a'} ** (max_tui_run_arg_bytes + 1);
    const total_excess = [_]u8{'b'} ** (max_tui_run_args_total_bytes - max_tui_run_arg_bytes + 1);
    const too_many_args = [_][]const u8{"--flag"} ** (max_tui_run_arg_count + 1);

    try std.testing.expect(isSafeTuiRunArgs(&.{ "build-pr", "nullclaw/nullbuilder", "--pr", "7" }));
    try std.testing.expect(isSafeTuiRunArgs(&.{ "release-tag", max_arg[0..] }));
    try std.testing.expect(isSafeTuiRunArgs(&.{ "release-tag", "nullclaw/nullbuilder", "--ref", "release-\xd0\xbf\xd1\x83\xd1\x82\xd1\x8c" }));

    try std.testing.expect(!isSafeTuiRunArgs(&.{ "build-pr", "" }));
    try std.testing.expect(!isSafeTuiRunArgs(too_many_args[0..]));
    try std.testing.expect(!isSafeTuiRunArgs(&.{ "build-pr", oversized_arg[0..] }));
    try std.testing.expect(!isSafeTuiRunArgs(&.{ "build-pr", max_arg[0..], total_excess[0..] }));
    try std.testing.expect(!isSafeTuiRunArgs(&.{"bad\narg"}));
    try std.testing.expect(!isSafeTuiRunArgs(&.{"bad\x85arg"}));
    try std.testing.expect(!isSafeTuiRunArgs(&.{"bad\xe2\x80\xaearg"}));
    try std.testing.expect(!isSafeTuiRunArgs(&.{"bad\xc0\x85arg"}));
}
