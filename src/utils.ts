import { Readable, Writable } from "node:stream";

/**
 * Pushable async iterable - allows pushing values to be consumed asynchronously
 */
export class Pushable<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T) {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        break;
      } else {
        const value = await new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
        if (value.done) break;
        yield value.value;
      }
    }
  }

  close() {
    this.done = true;
    this.resolvers.forEach((r) => r({ value: undefined as T, done: true }));
    this.resolvers = [];
  }
}

/**
 * Convert Node.js Readable stream to Web ReadableStream
 */
export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => {
        controller.enqueue(chunk);
      });
      nodeStream.on("end", () => {
        controller.close();
      });
      nodeStream.on("error", (err) => {
        controller.error(err);
      });
    },
  });
}

/**
 * Convert Node.js Writable stream to Web WritableStream
 */
export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        nodeStream.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  });
}

/**
 * Generate unique ID
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Log to stderr (stdout reserved for ACP protocol)
 */
export function log(...args: unknown[]): void {
  console.error("[droid-acp]", ...args);
}
