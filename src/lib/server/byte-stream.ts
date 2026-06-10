export type BoundedByteStreamResult =
  | {
      ok: true;
      bytes: Uint8Array;
    }
  | {
      ok: false;
      reason: 'too-large';
    };

const EMPTY_BYTES = new Uint8Array();

export async function readBoundedByteStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<BoundedByteStreamResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a safe non-negative integer.');
  }

  if (!stream) {
    return {
      ok: true,
      bytes: EMPTY_BYTES
    };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value.byteLength === 0) {
        continue;
      }

      if (value.byteLength > maxBytes - totalBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          reason: 'too-large'
        };
      }

      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    ok: true,
    bytes: joinByteChunks(chunks, totalBytes)
  };
}

export function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function joinByteChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 0) {
    return EMPTY_BYTES;
  }

  if (chunks.length === 1 && chunks[0].byteLength === totalBytes) {
    return chunks[0];
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}
