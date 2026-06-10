import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { arrayBufferFromBytes, contentLengthExceedsByteLimit, readBoundedByteStream } from './byte-stream';

const originalArrayIterator = Array.prototype[Symbol.iterator];

test('contentLengthExceedsByteLimit accepts only bounded decimal byte counts', () => {
  assert.equal(contentLengthExceedsByteLimit('0', 4, 8), false);
  assert.equal(contentLengthExceedsByteLimit('4', 4, 8), false);
  assert.equal(contentLengthExceedsByteLimit(' 4 ', 4, 8), false);

  for (const contentLength of ['5', '10junk', '1e9', '-1', '1.5', '', '9007199254740992', '1'.repeat(9)]) {
    assert.equal(contentLengthExceedsByteLimit(contentLength, 4, 8), true);
  }
});

test('contentLengthExceedsByteLimit rejects unsafe limit options', () => {
  assert.equal(contentLengthExceedsByteLimit('0', Number.NaN, 8), true);
  assert.equal(contentLengthExceedsByteLimit('0', -1, 8), true);
  assert.equal(contentLengthExceedsByteLimit('0', 4, Number.NaN), true);
});

test('readBoundedByteStream returns empty bytes for absent and empty streams', async () => {
  assert.deepEqual(await readBoundedByteStream(null, 16), {
    ok: true,
    bytes: new Uint8Array()
  });

  const result = await readBoundedByteStream(byteStream([]), 16);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.bytes, new Uint8Array());
  }
});

test('readBoundedByteStream skips empty chunks and borrows a single non-empty chunk', async () => {
  const chunk = new TextEncoder().encode('{"ok":true}');
  const result = await readBoundedByteStream(byteStream([new Uint8Array(), chunk, new Uint8Array()]), chunk.byteLength);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.bytes, chunk);
  }
});

test('readBoundedByteStream joins chunks without changing byte order', async () => {
  const first = new TextEncoder().encode('web');
  const second = new TextEncoder().encode('Token');
  const result = await readBoundedByteStream(byteStream([first, second]), 16);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(new TextDecoder().decode(result.bytes), 'webToken');
  }
});

test('readBoundedByteStream joins chunks without array iterators', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('web'));
      controller.enqueue(new TextEncoder().encode('Token'));
      controller.close();
    }
  });

  Array.prototype[Symbol.iterator] = function arrayIteratorShouldNotBeCalled(): ArrayIterator<unknown> {
    throw new Error('Array.prototype iterator should not be called.');
  };

  let result: Awaited<ReturnType<typeof readBoundedByteStream>>;
  try {
    result = await readBoundedByteStream(stream, 16);
  } finally {
    Array.prototype[Symbol.iterator] = originalArrayIterator;
  }

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(new TextDecoder().decode(result.bytes), 'webToken');
  }
});

test('readBoundedByteStream cancels over-limit streams without exposing cancel errors', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      throw new Error('private cancel detail');
    }
  });

  const result = await readBoundedByteStream(stream, 4);

  assert.deepEqual(result, {
    ok: false,
    reason: 'too-large'
  });
  assert.equal(stream.locked, false);
});

test('readBoundedByteStream does not wait for stalled stream cancellation', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
    },
    cancel() {
      return new Promise<void>(() => undefined);
    }
  });

  const result = await withTimeout(readBoundedByteStream(stream, 4), 100);

  assert.deepEqual(result, {
    ok: false,
    reason: 'too-large'
  });
  assert.equal(stream.locked, false);
});

test('readBoundedByteStream rejects unsafe byte limits before reading', async () => {
  const stream = byteStream([new Uint8Array(1)]);

  await assert.rejects(readBoundedByteStream(stream, Number.NaN), /safe non-negative integer/);
  assert.equal(stream.locked, false);
});

test('arrayBufferFromBytes returns an isolated exact-length buffer', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const buffer = arrayBufferFromBytes(bytes);
  const copied = new Uint8Array(buffer);

  assert.deepEqual(copied, bytes);
  bytes[0] = 9;
  assert.deepEqual(copied, new Uint8Array([1, 2, 3]));
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Timed out waiting for bounded stream read.')), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    }
  });
}
