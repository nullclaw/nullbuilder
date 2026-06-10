import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildChildArgs, resolveLauncherPaths, runLauncher } from './nullbuilder-launcher.js';

test('resolveLauncherPaths derives bundled and source cli paths from module url', () => {
  const paths = resolveLauncherPaths(new URL('./nullbuilder-launcher.js', import.meta.url).href);

  assert.equal(paths.root.endsWith('/nullbuilder'), true);
  assert.equal(paths.bundledCli.endsWith('/nullbuilder/dist/cli/nullbuilder.js'), true);
  assert.equal(paths.sourceCli.endsWith('/nullbuilder/src/cli/nullbuilder.ts'), true);
});

test('buildChildArgs selects bundled cli when available', () => {
  const paths = {
    bundledCli: '/repo/dist/cli/nullbuilder.js',
    sourceCli: '/repo/src/cli/nullbuilder.ts'
  };

  assert.deepEqual(buildChildArgs(paths, ['repos', '--json'], true), [
    '/repo/dist/cli/nullbuilder.js',
    'repos',
    '--json'
  ]);
});

test('buildChildArgs falls back to tsx source cli when bundle is missing', () => {
  const paths = {
    bundledCli: '/repo/dist/cli/nullbuilder.js',
    sourceCli: '/repo/src/cli/nullbuilder.ts'
  };

  assert.deepEqual(buildChildArgs(paths, ['repos'], false), ['--import', 'tsx', '/repo/src/cli/nullbuilder.ts', 'repos']);
});

test('buildChildArgs rejects unsafe forwarded arguments before spawning', () => {
  const paths = {
    bundledCli: '/repo/dist/cli/nullbuilder.js',
    sourceCli: '/repo/src/cli/nullbuilder.ts'
  };

  assert.equal(buildChildArgs(paths, ['bad\nrepo'], true), null);
  assert.equal(buildChildArgs(paths, ['bad\u202erepo'], true), null);
  assert.equal(buildChildArgs(paths, ['bad\uD800repo'], true), null);
  assert.equal(buildChildArgs(paths, ['repo-🙂'], true)?.at(-1), 'repo-🙂');
  assert.equal(buildChildArgs(paths, ['x'.repeat(4097)], true), null);
  assert.equal(buildChildArgs(paths, Array.from({ length: 129 }, (_, index) => `arg-${index}`), true), null);
});

test('runLauncher returns child status and forwards current working directory', () => {
  const spawned = [];
  const status = runLauncher({
    argv: ['node', 'bin/nullbuilder.js', 'repos'],
    cwd: '/worktree',
    execPath: '/usr/bin/node',
    moduleUrl: new URL('./nullbuilder-launcher.js', import.meta.url).href,
    exists: () => true,
    stderr: writableBuffer(),
    spawn: (execPath, args, options) => {
      spawned.push({ execPath, args, options });
      return { status: 7 };
    }
  });

  assert.equal(status, 7);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].execPath, '/usr/bin/node');
  assert.equal(spawned[0].args.at(-1), 'repos');
  assert.deepEqual(spawned[0].options, {
    cwd: '/worktree',
    stdio: 'inherit'
  });
});

test('runLauncher rejects invalid argv without spawning', () => {
  const stderr = writableBuffer();
  let spawned = false;
  const status = runLauncher({
    argv: ['node', 'bin/nullbuilder.js', 'bad\x1b[31mrepo'],
    moduleUrl: new URL('./nullbuilder-launcher.js', import.meta.url).href,
    exists: () => true,
    stderr,
    spawn: () => {
      spawned = true;
      return { status: 0 };
    }
  });

  assert.equal(status, 2);
  assert.equal(spawned, false);
  assert.equal(stderr.value, 'Invalid command arguments.\n');
});

test('runLauncher maps spawn errors to a generic failure exit', () => {
  const stderr = writableBuffer();
  const status = runLauncher({
    argv: ['node', 'bin/nullbuilder.js', 'repos'],
    moduleUrl: new URL('./nullbuilder-launcher.js', import.meta.url).href,
    exists: () => true,
    stderr,
    spawn: () => ({ error: new Error('spawn failed /private/path/token\x1b[31m') })
  });

  assert.equal(status, 1);
  assert.equal(stderr.value, 'Failed to launch nullbuilder CLI.\n');
  assert.doesNotMatch(stderr.value, /private|token|\x1b/);
});

function writableBuffer() {
  return {
    value: '',
    write(chunk) {
      this.value += chunk;
    }
  };
}
