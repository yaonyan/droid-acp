import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

describe('Droid ACP Agent Integration', () => {
  let agent: ChildProcess;
  let requestId = 0;
  let sessionId: string;

  const sendRequest = (method: string, params: Record<string, unknown>) => {
    const req = { jsonrpc: "2.0", id: ++requestId, method, params };
    agent.stdin!.write(JSON.stringify(req) + '\n');
    return requestId;
  };

  const waitForResponse = (expectedId: number, timeout = 60000): Promise<any> => {
    return new Promise((resolve, reject) => {
      // Create a NEW reader for each wait is risky if lines are missed.
      // Better to have a global line handler. 
      // But for this simple sequential test it might be ok if we don't miss data.
      // To be safe, we should attach the listener once.
    });
  };
  
  // Re-implementing with a persistent listener
  let msgHandlers: Map<number, (msg: any) => void> = new Map();
  let notificationHandler: ((msg: any) => void) | null = null;

  beforeAll(() => {
    agent = spawn('node', ['dist/index.mjs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const reader = createInterface({ input: agent.stdout! });
    reader.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        // Print notifications for debugging
        if (msg.method === 'notifications/session/update') {
           const content = msg.params?.update?.content;
           if (content?.type === 'text') {
             console.log('[AGENT_MSG]', content.text);
           }
        }
        
        if (msg.id && msgHandlers.has(msg.id)) {
          msgHandlers.get(msg.id)!(msg);
          msgHandlers.delete(msg.id);
        } else if (!msg.id && notificationHandler) {
          notificationHandler(msg);
        }
      } catch (e) {
        console.log('[RAW]', line);
      }
    });
    
    // Also print stderr
    const errReader = createInterface({ input: agent.stderr! });
    errReader.on('line', l => console.log('[STDERR]', l));
  });

  afterAll(() => {
    agent?.kill();
  });

  const request = (method: string, params: any) => {
    return new Promise<any>((resolve, reject) => {
      const id = ++requestId;
      msgHandlers.set(id, resolve);
      agent.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (msgHandlers.has(id)) {
          msgHandlers.delete(id);
          reject(new Error(`Timeout waiting for ${method} (id=${id})`));
        }
      }, 30000);
    });
  };

  it('should initialize', async () => {
    const res = await request('initialize', {
      clientInfo: { name: 'vitest', version: '1.0' },
      capabilities: {},
      protocolVersion: 1,
    });
    expect(res.result?.agentInfo?.name).toBe('droid-acp');
  });

  it('should create session', async () => {
    const res = await request('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    });
    expect(res.result?.sessionId).toBeDefined();
    sessionId = res.result.sessionId;
  });

  it('should handle tool call (run echo 1)', async () => {
    console.log('\n--- Sending prompt: run echo 1 ---\n');
    const res = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'run echo 1' }]
    });
    console.log('\n--- Prompt finished ---\n', res);
    expect(res.result?.stopReason).toBe('end_turn');
  }, 120000); // Long timeout for tool execution
});
