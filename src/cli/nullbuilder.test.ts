import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { isCliEntrypoint, readCliArgTail, writeCliRunResult } from './nullbuilder';

test('writeCliRunResult drains stdout and stderr explicitly', () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  writeCliRunResult(
    {
      stdout: ['line 1', 'line 2'],
      stderr: ['warning'],
      exitCode: 2
    },
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  );

  assert.deepEqual(stdout, ['line 1', 'line 2']);
  assert.deepEqual(stderr, ['warning']);
});

test('writeCliRunResult avoids user-controlled output iterators', () => {
  class UnsafeIteratorArray<T> extends Array<T> {
    override [Symbol.iterator](): ArrayIterator<T> {
      throw new Error('iterator should not be called');
    }
  }
  const stdout: string[] = [];
  const stderr: string[] = [];

  writeCliRunResult(
    {
      stdout: new UnsafeIteratorArray('line 1', 'line 2'),
      stderr: new UnsafeIteratorArray('warning'),
      exitCode: null
    },
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  );

  assert.deepEqual(stdout, ['line 1', 'line 2']);
  assert.deepEqual(stderr, ['warning']);
});

test('readCliArgTail avoids user-controlled argv slice methods', () => {
  class UnsafeSliceArray<T> extends Array<T> {
    override slice(): T[] {
      throw new Error('slice should not be called');
    }
  }
  const argv = new UnsafeSliceArray('node', 'nullbuilder', 'repos', '--json');

  assert.deepEqual(readCliArgTail(argv), ['repos', '--json']);
});

test('readCliArgTail copies argv tail before parsing', () => {
  let tailReads = 0;
  let prefixReads = 0;
  const argv = new Proxy(['node', 'nullbuilder', 'repos', '--json'], {
    get(target, property, receiver) {
      if (property === '0' || property === '1') {
        prefixReads += 1;
      }
      if (property === '2' || property === '3') {
        tailReads += 1;
        if (tailReads > 2) {
          throw new Error('tail should not be read after validation');
        }
      }

      return Reflect.get(target, property, receiver);
    }
  });

  assert.deepEqual(readCliArgTail(argv), ['repos', '--json']);
  assert.equal(prefixReads, 0);
  assert.equal(tailReads, 2);
});

test('readCliArgTail avoids global array push hooks', () => {
  const originalPush = Array.prototype.push;
  let pushCalls = 0;
  let args: string[] | undefined;

  Object.defineProperty(Array.prototype, 'push', {
    configurable: true,
    writable: true,
    value() {
      pushCalls += 1;
      throw new Error('push should not be called');
    }
  });

  try {
    args = readCliArgTail(['node', 'nullbuilder', 'repos', '--json']);
  } finally {
    Object.defineProperty(Array.prototype, 'push', {
      configurable: true,
      writable: true,
      value: originalPush
    });
  }

  assert.equal(pushCalls, 0);
  assert.deepEqual(args, ['repos', '--json']);
});

test('readCliArgTail rejects hostile argv traps without leaking details', () => {
  for (const argv of [
    new Proxy(['node', 'nullbuilder', 'repos'], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw new Error('secret length trap');
        }

        return Reflect.get(target, property, receiver);
      }
    }),
    new Proxy(['node', 'nullbuilder', 'repos'], {
      get(target, property, receiver) {
        if (property === '2') {
          throw new Error('secret item trap');
        }

        return Reflect.get(target, property, receiver);
      }
    })
  ]) {
    assert.throws(() => readCliArgTail(argv), (error) => {
      assert(error instanceof Error);
      assert.equal(error.message, 'Invalid CLI argument.');
      assert.doesNotMatch(error.message, /secret/u);
      return true;
    });
  }
});

test('isCliEntrypoint matches only the invoked module path', () => {
  const cliPath = '/repo/src/cli/nullbuilder.ts';
  const cliUrl = pathToFileURL(cliPath).href;

  assert.equal(isCliEntrypoint(cliUrl, cliPath), true);
  assert.equal(isCliEntrypoint(cliUrl, '/repo/src/cli/runner.ts'), false);
  assert.equal(isCliEntrypoint(cliUrl, undefined), false);
});
