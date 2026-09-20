import { RelayWorkerError } from "./worker-rpc";

/** Read NDJSON without buffering a process's entire output or an unlimited line.
 * Protocol frames are strict; diagnostic frames may be dropped, never fatal.
 */
export async function readWorkerLines(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onLine: (line: string) => void,
  onDropped?: (bytes: number) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: !onDropped });
  let parts: Uint8Array[] = [];
  let length = 0;
  let dropped = 0;
  const finish = () => {
    if (dropped) {
      onDropped?.(dropped);
    } else if (length) {
      const line = decoder.decode(Buffer.concat(parts, length)).trim();
      if (line) onLine(line);
    }
    parts = [];
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
          parts = [];
        } else if (bytes) {
          // Copy only the retained bytes, not an otherwise consumed big chunk.
          parts.push(value.slice(start, end));
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
