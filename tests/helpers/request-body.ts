/**
 * Request bodies for the F-78 byte-cap tests: a stream that is produced only
 * as it is read (`highWaterMark: 0`), so a test can tell how much of a body a
 * handler pulled, and whether it cancelled the rest.
 */
export interface MeteredBody {
  stream: ReadableStream<Uint8Array>;
  /** Chunks handed to the reader so far. */
  readonly pulled: number;
  /** Whether the reader cancelled the stream. */
  readonly cancelled: boolean;
}

/**
 * `chunks` chunks of `chunkBytes` spaces each (valid JSON whitespace, so a
 * handler that reads it all and parses gets a parse error, not a hang).
 */
export function meteredBody(chunkBytes: number, chunks: number): MeteredBody {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled === chunks) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    get pulled() {
      return pulled;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/** A stream of `text`'s UTF-8 bytes in `chunkBytes`-sized pieces. */
export function chunkedBody(text: string, chunkBytes: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkBytes));
      offset += chunkBytes;
    },
  });
}
