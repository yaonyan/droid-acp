import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDroidAdapter } from '../src/droid-adapter';
import { EventEmitter } from 'node:events';

// Mock child_process
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

import { PassThrough } from 'node:stream';

// ... imports ...

describe('DroidAdapter', () => {
  let mockProcess: any;
  let stdin: PassThrough;
  let stdout: PassThrough;
  let stderr: PassThrough;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    mockProcess = new EventEmitter();
    Object.assign(mockProcess, { stdin, stdout, stderr, kill: vi.fn(), killed: false });
    
    // Mock the spawn function result
    mockSpawn.mockReturnValue(mockProcess);
    
    // Spy on stdin write
    vi.spyOn(stdin, 'write');
  });
// ...

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should start droid process and wait for init', async () => {
    const adapter = createDroidAdapter({ cwd: '/test/cwd' });
    
    const startPromise = adapter.start();
    
    expect(mockSpawn).toHaveBeenCalledWith(
      'droid',
      ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc', '--cwd', '/test/cwd'],
      expect.any(Object)
    );

    // Simulate init event
    const initEvent = {
        type: "system",
        subtype: "init",
        cwd: "/test/cwd",
        session_id: "sess-1",
        tools: [],
        model: "model-1"
    };
    stdout.emit('data', JSON.stringify(initEvent) + '\n');
    
    const result = await startPromise;
    expect(result).toEqual(initEvent);
  });

  it('should send messages to stdin', async () => {
    const adapter = createDroidAdapter({ cwd: '/test/cwd' });
    // Start first to set up process
    const startPromise = adapter.start();
    stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
    await startPromise;

    adapter.sendMessage('hello');
    
    expect(stdin.write).toHaveBeenCalled();
    // @ts-ignore
    const writeArg = JSON.parse(stdin.write.mock.calls[0][0].trim());
    expect(writeArg).toMatchObject({
      jsonrpc: '2.0',
      method: 'message',
      params: { role: 'user', text: 'hello' }
    });
  });

  it('should emit events received from stdout', async () => {
    const adapter = createDroidAdapter({ cwd: '/test/cwd' });
    const startPromise = adapter.start();
    stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
    await startPromise;

    const onEvent = vi.fn();
    adapter.onEvent(onEvent);

    const event = { type: 'message', role: 'assistant', text: 'hi', id: '1', timestamp: 123, session_id: 's1' };
    stdout.emit('data', JSON.stringify(event) + '\n');

    expect(onEvent).toHaveBeenCalledWith(event);
  });
});
