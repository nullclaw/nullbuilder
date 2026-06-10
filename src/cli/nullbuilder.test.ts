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

test('isCliEntrypoint matches only the invoked module path', () => {
  const cliPath = '/repo/src/cli/nullbuilder.ts';
  const cliUrl = pathToFileURL(cliPath).href;

  assert.equal(isCliEntrypoint(cliUrl, cliPath), true);
  assert.equal(isCliEntrypoint(cliUrl, '/repo/src/cli/runner.ts'), false);
  assert.equal(isCliEntrypoint(cliUrl, undefined), false);
});
