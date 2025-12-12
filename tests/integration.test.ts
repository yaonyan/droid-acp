import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface} from 'node:readline';

describe('Droid ACP Agent Integration', () => {
  let agent: ChildProcess;
  let requestId = 0;

  const sendRequest = (method: string, params: Record<string, unknown>) => {
    const req = { jsonrpc: "2.0", id: ++requestId, method, params };
    agent.stdin!.write(JSON.stringify(req) + '\n');
    return requestId;
  };

  const waitForResponse = (expectedId: number, timeout = 30000): Promise<any> => {
    return new Promise((resolve, reject) => {
      const reader = createInterface({ input: agent.stdout! });
      const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
      reader.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.id === expectedId) {
            clearTimeout(timer);
            reader.close();
            resolve(msg);
          }
        } catch {}
      });
    });
  };

  beforeAll(() => {
    agent = spawn('node', ['dist/index.mjs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
  });

  afterAll(() => {
    agent?.kill();
  });

  it('should initialize successfully', async () => {
    const id = sendRequest('initialize', {
      clientInfo: { name: 'vitest', version: '1.0' },
      capabilities: {},
      protocolVersion: 1,
    });
    const response = await waitForResponse(id);
    expect(response.result?.agentInfo?.name).toBe('droid-acp');
  });

  it('should create a new session', async () => {
    const id = sendRequest('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const response = await waitForResponse(id);
    expect(response.result?.sessionId).toBeDefined();
    expect(response.result?.models?.availableModels?.length).toBeGreaterThan(0);
  });
});
