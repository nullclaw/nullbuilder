import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { arrayBufferFromBytes, readBoundedByteStream } from './byte-stream';

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
