import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MAX_CLI_ARGS, readCliArgVector } from './runtime-args';

test('readCliArgVector copies bounded string arrays', () => {
  assert.deepEqual(readCliArgVector(['repos', '--json']), ['repos', '--json']);
  assert.deepEqual(readCliArgVector(['node', 'nullbuilder', 'repos'], { start: 2 }), ['repos']);
  assert.deepEqual(readCliArgVector(['node'], { start: 2 }), []);
});

test('readCliArgVector avoids user-controlled array methods', () => {
  const argv = ['repos', '--json'];
  Object.defineProperty(argv, 'slice', {
    value() {
      throw new Error('slice should not be called');
    }
  });
  Object.defineProperty(argv, Symbol.iterator, {
    value() {
      throw new Error('iterator should not be called');
    }
  });

  assert.deepEqual(readCliArgVector(argv), ['repos', '--json']);
});

test('readCliArgVector avoids global array push hooks', () => {
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
    args = readCliArgVector(['repos', '--json']);
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

test('readCliArgVector rejects malformed runtime argument vectors', () => {
  assert.throws(() => readCliArgVector(null), /^Error: Invalid CLI argument\.$/);
  assert.throws(() => readCliArgVector(['repos', null]), /^Error: Invalid CLI argument\.$/);
  assert.throws(
    () => readCliArgVector(Array.from({ length: MAX_CLI_ARGS + 1 }, (_, index) => `arg-${index}`)),
    (error) => {
      assert(error instanceof Error);
      assert.equal(error.message, 'Too many CLI arguments.');
      assert.doesNotMatch(error.message, /arg-128/u);
      return true;
    }
  );
});

test('readCliArgVector rejects hostile runtime argument traps', () => {
  for (const argv of [
    new Proxy(['repos'], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw new Error('secret length trap');
        }

        return Reflect.get(target, property, receiver);
      }
    }),
    new Proxy(['repos', '--json'], {
      get(target, property, receiver) {
        if (property === '1') {
          throw new Error('secret item trap');
        }

        return Reflect.get(target, property, receiver);
      }
    })
  ]) {
    assert.throws(() => readCliArgVector(argv), (error) => {
      assert(error instanceof Error);
      assert.equal(error.message, 'Invalid CLI argument.');
      assert.doesNotMatch(error.message, /secret/u);
      return true;
    });
  }
});
