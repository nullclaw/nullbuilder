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
  const maxTotalArgs = Array.from({ length: 32 }, () => 'x'.repeat(4096));
  const overTotalArgs = [...maxTotalArgs, 'x'];

  assert.equal(buildChildArgs(paths, [''], true), null);
  assert.equal(buildChildArgs(paths, ['bad\nrepo'], true), null);
  assert.equal(buildChildArgs(paths, ['bad\u202erepo'], true), null);
  assert.equal(buildChildArgs(paths, ['bad\uD800repo'], true), null);
  assert.equal(buildChildArgs(paths, ['repo-🙂'], true)?.at(-1), 'repo-🙂');
  assert.equal(buildChildArgs(paths, ['x'.repeat(4097)], true), null);
  assert.equal(buildChildArgs(paths, maxTotalArgs, true)?.length, maxTotalArgs.length + 1);
  assert.equal(buildChildArgs(paths, overTotalArgs, true), null);
  assert.equal(buildChildArgs(paths, Array.from({ length: 129 }, (_, index) => `arg-${index}`), true), null);
});

test('buildChildArgs rejects hostile forwarded argument array traps', () => {
  const paths = {
    bundledCli: '/repo/dist/cli/nullbuilder.js',
    sourceCli: '/repo/src/cli/nullbuilder.ts'
  };
  const hostileLength = new Proxy(['repos'], {
    get(target, property, receiver) {
      if (property === 'length') {
        throw new Error('secret length trap');
      }

      return Reflect.get(target, property, receiver);
    }
  });
  const hostileItem = new Proxy(['repos'], {
    get(target, property, receiver) {
      if (property === '0') {
        throw new Error('secret item trap');
      }

      return Reflect.get(target, property, receiver);
    }
  });

  assert.equal(buildChildArgs(paths, hostileLength, true), null);
  assert.equal(buildChildArgs(paths, hostileItem, true), null);
});

test('buildChildArgs copies forwarded args before prefixing', () => {
  const paths = {
    bundledCli: '/repo/dist/cli/nullbuilder.js',
    sourceCli: '/repo/src/cli/nullbuilder.ts'
  };
  let argReads = 0;
  const args = new Proxy(['repos', '--json'], {
    get(target, property, receiver) {
      if (property === '0' || property === '1') {
        argReads += 1;
        if (argReads > 2) {
          throw new Error('forwarded args should not be read after validation');
        }
      }

      return Reflect.get(target, property, receiver);
    }
  });

  assert.deepEqual(buildChildArgs(paths, args, true), ['/repo/dist/cli/nullbuilder.js', 'repos', '--json']);
  assert.equal(argReads, 2);
});

test('buildChildArgs avoids user-controlled forwarded argument iterators', () => {
  const paths = {
    bundledCli: '/repo/dist/cli/nullbuilder.js',
    sourceCli: '/repo/src/cli/nullbuilder.ts'
  };
  const args = ['repos', '--json'];
  Object.defineProperty(args, Symbol.iterator, {
    value() {
      throw new Error('iterator should not be called');
    }
  });

  assert.deepEqual(buildChildArgs(paths, args, true), ['/repo/dist/cli/nullbuilder.js', 'repos', '--json']);
});

test('buildChildArgs avoids global array push hooks', () => {
  const paths = {
    bundledCli: '/repo/dist/cli/nullbuilder.js',
    sourceCli: '/repo/src/cli/nullbuilder.ts'
  };
  const originalPush = Array.prototype.push;
  let pushCalls = 0;
  let childArgs;

  Object.defineProperty(Array.prototype, 'push', {
    configurable: true,
    writable: true,
    value() {
      pushCalls += 1;
      throw new Error('push should not be called');
    }
  });

  try {
    childArgs = buildChildArgs(paths, ['repos', '--json'], false);
  } finally {
    Object.defineProperty(Array.prototype, 'push', {
      configurable: true,
      writable: true,
      value: originalPush
    });
  }

  assert.equal(pushCalls, 0);
  assert.deepEqual(childArgs, ['--import', 'tsx', '/repo/src/cli/nullbuilder.ts', 'repos', '--json']);
});

test('buildChildArgs rejects unsafe cli paths before spawning', () => {
  assert.equal(
    buildChildArgs(
      {
        bundledCli: '--eval=process.exit(1)',
        sourceCli: '/repo/src/cli/nullbuilder.ts'
      },
      ['repos'],
      true
    ),
    null
  );
  assert.equal(
    buildChildArgs(
      {
        bundledCli: '/repo/dist/cli/nullbuilder.js',
        sourceCli: '/repo/src/cli/bad\npath.ts'
      },
      ['repos'],
      false
    ),
    null
  );
  assert.equal(
    buildChildArgs(
      {
        bundledCli: '/repo/dist/cli/nullbuilder.js',
        sourceCli: '/repo/src/cli/nullbuilder.ts'
      },
      ['repos'],
      true
    )?.at(0),
    '/repo/dist/cli/nullbuilder.js'
  );
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

test('runLauncher avoids user-controlled argv slice before spawning', () => {
  const argv = ['node', 'bin/nullbuilder.js', 'repos'];
  Object.defineProperty(argv, 'slice', {
    value() {
      throw new Error('slice should not be called');
    }
  });
  const spawned = [];
  const status = runLauncher({
    argv,
    cwd: '/worktree',
    execPath: '/usr/bin/node',
    moduleUrl: new URL('./nullbuilder-launcher.js', import.meta.url).href,
    exists: () => true,
    stderr: writableBuffer(),
    spawn: (execPath, args, options) => {
      spawned.push({ execPath, args, options });
      return { status: 0 };
    }
  });

  assert.equal(status, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args.at(-1), 'repos');
});

test('runLauncher avoids global array push hooks before spawning', () => {
  const originalPush = Array.prototype.push;
  let pushCalls = 0;
  let spawned;
  let status;

  Object.defineProperty(Array.prototype, 'push', {
    configurable: true,
    writable: true,
    value() {
      pushCalls += 1;
      throw new Error('push should not be called');
    }
  });

  try {
    status = runLauncher({
      argv: ['node', 'bin/nullbuilder.js', 'repos'],
      cwd: '/worktree',
      execPath: '/usr/bin/node',
      moduleUrl: new URL('./nullbuilder-launcher.js', import.meta.url).href,
      exists: () => true,
      stderr: writableBuffer(),
      spawn: (execPath, args, options) => {
        spawned = { execPath, args, options };
        return { status: 0 };
      }
    });
  } finally {
    Object.defineProperty(Array.prototype, 'push', {
      configurable: true,
      writable: true,
      value: originalPush
    });
  }

  assert.equal(pushCalls, 0);
  assert.equal(status, 0);
  assert.equal(spawned?.args.at(-1), 'repos');
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

test('runLauncher rejects hostile argv traps without spawning', () => {
  for (const argv of [
    new Proxy(['node', 'bin/nullbuilder.js', 'repos'], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw new Error('secret argv length');
        }

        return Reflect.get(target, property, receiver);
      }
    }),
    new Proxy(['node', 'bin/nullbuilder.js', 'repos'], {
      get(target, property, receiver) {
        if (property === '2') {
          throw new Error('secret argv item');
        }

        return Reflect.get(target, property, receiver);
      }
    })
  ]) {
    const stderr = writableBuffer();
    let spawned = false;
    const status = runLauncher({
      argv,
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
    assert.doesNotMatch(stderr.value, /secret/u);
  }
});

test('runLauncher rejects unsafe launcher environment without spawning', () => {
  for (const unsafeEnvironment of [
    { execPath: '--eval=process.exit(1)', cwd: '/worktree' },
    { execPath: '/usr/bin/node', cwd: '/worktree\u202e' },
    { execPath: '/usr/bin/no\x00de', cwd: '/worktree' }
  ]) {
    const stderr = writableBuffer();
    let spawned = false;
    const status = runLauncher({
      argv: ['node', 'bin/nullbuilder.js', 'repos'],
      moduleUrl: new URL('./nullbuilder-launcher.js', import.meta.url).href,
      exists: () => true,
      stderr,
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
      ...unsafeEnvironment
    });

    assert.equal(status, 2);
    assert.equal(spawned, false);
    assert.equal(stderr.value, 'Invalid launcher environment.\n');
    assert.doesNotMatch(stderr.value, /eval|worktree|\x00|\u202e/u);
  }
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
