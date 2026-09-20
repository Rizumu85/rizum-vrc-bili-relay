import { RelayWorkerError } from "./worker-rpc";

/** Bounded NDJSON framing. Protocol overflow is fatal; diagnostic overflow is
 * discarded through the newline. A byte buffer also bounds overhead when the
 * underlying stream delivers many tiny chunks instead of whole lines.
 */
export async function readWorkerLines(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onLine: (line: string) => void,
  onDropped?: (bytes: number) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: !onDropped });
  let buffer = new Uint8Array(Math.min(limit, 4096));
  let length = 0;
  let dropped = 0;
  const finish = () => {
    if (dropped) {
      onDropped?.(dropped);
    } else if (length) {
      const line = decoder.decode(buffer.subarray(0, length)).trim();
      if (line) onLine(line);
    }
    length = 0;
    dropped = 0;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      while (start < value.length) {
        const newline = value.indexOf(10, start);
        const end = newline < 0 ? value.length : newline;
        const bytes = end - start;
        if (dropped || length + bytes > limit) {
          if (!onDropped) throw new RelayWorkerError("invalid_response", "Worker response exceeds the frame limit");
          dropped += length + bytes;
          length = 0;
        } else if (bytes) {
          if (length + bytes > buffer.length) {
            const grown = new Uint8Array(Math.min(limit, Math.max(buffer.length * 2, length + bytes)));
            grown.set(buffer.subarray(0, length));
            buffer = grown;
          }
          buffer.set(value.subarray(start, end), length);
          length += bytes;
        }
        if (newline >= 0) finish();
        start = newline < 0 ? value.length : newline + 1;
      }
    }
    if (length || dropped) {
      if (!onDropped) throw new RelayWorkerError("invalid_response", "Worker closed stdout in the middle of a response");
      finish();
    }
  } finally {
    reader.releaseLock();
  }
}
