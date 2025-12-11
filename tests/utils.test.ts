import { describe, it, expect } from 'vitest';
import { Pushable, nodeToWebReadable, nodeToWebWritable } from '../src/utils';
import { Readable, Writable } from 'node:stream';

describe('utils', () => {
  describe('Pushable', () => {
    it('should push values and iterate over them', async () => {
      const p = new Pushable<number>();
      p.push(1);
      p.push(2);
      
      const iterator = p[Symbol.asyncIterator]();
      
      expect(await iterator.next()).toEqual({ value: 1, done: false });
      expect(await iterator.next()).toEqual({ value: 2, done: false });
      
      p.push(3);
      expect(await iterator.next()).toEqual({ value: 3, done: false });
      
      p.close();
      expect(await iterator.next()).toEqual({ value: undefined, done: true });
    });

    it('should handle values pushed after waiting', async () => {
      const p = new Pushable<string>();
      const iterator = p[Symbol.asyncIterator]();
      
      const nextPromise = iterator.next();
      p.push('hello');
      
      expect(await nextPromise).toEqual({ value: 'hello', done: false });
      p.close();
    });
  });

  describe('nodeToWebReadable', () => {
    it('should convert Node Readable to Web ReadableStream', async () => {
      const nodeStream = Readable.from(['chunk1', 'chunk2']);
      const webStream = nodeToWebReadable(nodeStream);
      const reader = webStream.getReader();
      
      expect((await reader.read()).value).toBe('chunk1');
      expect((await reader.read()).value).toBe('chunk2');
      expect((await reader.read()).done).toBe(true);
    });
  });

  // Basic check that it returns a WritableStream, deeper testing might require actual writing
  describe('nodeToWebWritable', () => {
    it('should return a WritableStream', () => {
      const nodeStream = new Writable({ write: (c, e, cb) => cb() });
      const webStream = nodeToWebWritable(nodeStream);
      expect(webStream).toBeInstanceOf(WritableStream);
    });
  });
});
