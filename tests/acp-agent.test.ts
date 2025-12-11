import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DroidAcpAgent } from '../src/acp-agent';

// Mock DroidAdapter
const mockDroidAdapter = {
  start: vi.fn(),
  sendMessage: vi.fn(),
  setMode: vi.fn(),
  onEvent: vi.fn(),
  stop: vi.fn(),
  isRunning: vi.fn(),
};

vi.mock('../src/droid-adapter', () => ({
  createDroidAdapter: () => mockDroidAdapter,
}));

// Mock AgentSideConnection
const mockClient = {
  sessionUpdate: vi.fn(),
};

describe('DroidAcpAgent', () => {
    let agent: DroidAcpAgent;

    beforeEach(() => {
        vi.clearAllMocks();
        agent = new DroidAcpAgent(mockClient as any);
    });

    it('should initialize correctly', async () => {
        const response = await agent.initialize({} as any);
        expect(response.agentInfo?.name).toBe('droid-acp');
        expect(response.authMethods).toHaveLength(1);
    });

    it('should authenticate with correct API key', async () => {
        process.env.FACTORY_API_KEY = 'test-key';
        await expect(agent.authenticate({ methodId: 'factory-api-key' } as any)).resolves.toEqual({});
    });

    it('should fail authentication with missing API key', async () => {
        delete process.env.FACTORY_API_KEY;
        await expect(agent.authenticate({ methodId: 'factory-api-key' } as any))
            .rejects.toThrow('FACTORY_API_KEY environment variable is not set');
    });

    it('should verify creating a new session', async () => {
        mockDroidAdapter.start.mockResolvedValue({
            type: 'system', subtype: 'init', session_id: 'droid-sess', model: 'claude'
        });

        const response = await agent.newSession({ cwd: '/tmp' } as any);
        
        expect(response.sessionId).toBeDefined();
        expect(mockDroidAdapter.start).toHaveBeenCalled();
    });
});
