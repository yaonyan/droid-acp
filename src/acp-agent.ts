import {
  type Agent,
  type AgentSideConnection,
  type InitializeRequest,
  type InitializeResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type SetSessionModelRequest,
  type SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { createDroidAdapter, type DroidAdapter, type DroidInitResult, type DroidNotification } from "./droid-adapter.js";
import { log, generateId } from "./utils.js";
import { ACP_TO_DROID_MODE, type AutonomyLevel } from "./types.js";

interface Session {
  id: string;
  droid: DroidAdapter;
  droidSessionId: string;
  model: string;
  cancelled: boolean;
  promptResolve: ((result: PromptResponse) => void) | null;
}

/**
 * Droid ACP Agent - bridges ACP protocol with Factory Droid CLI
 */
export class DroidAcpAgent implements Agent {
  private sessions: Map<string, Session> = new Map();
  private client: AgentSideConnection;

  constructor(client: AgentSideConnection) {
    this.client = client;
    log("DroidAcpAgent initialized");
  }

  async initialize(_request: InitializeRequest): Promise<InitializeResponse> {
    log("initialize");
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: false, embeddedContext: true },
      },
      agentInfo: {
        name: "droid-acp",
        title: "Factory Droid",
        version: "0.1.0",
      },
      authMethods: [
        {
          id: "factory-api-key",
          name: "Factory API Key",
          description: "Set FACTORY_API_KEY environment variable",
        },
      ],
    };
  }

  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse> {
    log("authenticate:", request.methodId);
    if (request.methodId === "factory-api-key") {
      if (!process.env.FACTORY_API_KEY) {
        throw new Error("FACTORY_API_KEY environment variable is not set");
      }
      return {};
    }
    throw new Error(`Unknown auth method: ${request.methodId}`);
  }

  async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = generateId();
    const cwd = request.cwd || process.cwd();
    log("newSession:", cwd);

    const droid = createDroidAdapter({ cwd });
    const initResult: DroidInitResult = await droid.start();

    const session: Session = {
      id: sessionId,
      droid,
      droidSessionId: initResult.sessionId,
      model: initResult.modelId,
      cancelled: false,
      promptResolve: null,
    };

    // Set up notification handler
    droid.onNotification((n) => this.handleNotification(session, n));

    // Forward raw events for debugging (enable with DROID_DEBUG=1)
    if (process.env.DROID_DEBUG) {
      droid.onRawEvent(async (event) => {
        await this.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `\n\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\`\n`,
            },
          },
        });
      });
    }

    this.sessions.set(sessionId, session);
    log("Session created:", sessionId);

    return {
      sessionId,
      models: {
        availableModels: initResult.availableModels.map((m) => ({
          modelId: m.id,
          name: m.displayName,
        })),
        currentModelId: initResult.modelId,
      },
      modes: {
        currentModeId: "medium",
        availableModes: [
          { id: "low", name: "Suggest", description: "Low - Safe file operations, requires confirmation" },
          { id: "medium", name: "Normal", description: "Medium - Development tasks with moderate autonomy" },
          { id: "high", name: "Full", description: "High - Production operations with full autonomy" },
        ],
      },
    };
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) throw new Error(`Session not found: ${request.sessionId}`);
    if (session.cancelled) throw new Error("Session cancelled");

    log("prompt:", request.sessionId);

    // Extract text from prompt content
    const text = request.prompt
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // Send message and wait for completion
    return new Promise((resolve) => {
      session.promptResolve = resolve;
      session.droid.sendMessage(text);

      // Timeout after 5 minutes
      setTimeout(() => {
        if (session.promptResolve) {
          session.promptResolve({ stopReason: "end_turn" });
          session.promptResolve = null;
        }
      }, 5 * 60 * 1000);
    });
  }

  async cancel(request: CancelNotification): Promise<void> {
    const session = this.sessions.get(request.sessionId);
    if (session) {
      log("cancel:", request.sessionId);
      session.cancelled = true;
      if (session.promptResolve) {
        session.promptResolve({ stopReason: "cancelled" });
        session.promptResolve = null;
      }
      await session.droid.stop();
    }
  }

  async setSessionModel(request: SetSessionModelRequest): Promise<void> {
    const session = this.sessions.get(request.sessionId);
    if (session) {
      log("setSessionModel:", request.modelId);
      session.model = request.modelId;
    }
  }

  async setSessionMode(request: SetSessionModeRequest): Promise<void> {
    const session = this.sessions.get(request.sessionId);
    if (session) {
      log("setSessionMode:", request.modeId);
      const droidMode = ACP_TO_DROID_MODE[request.modeId] as AutonomyLevel;
      if (droidMode) {
        session.droid.setMode(droidMode);
      }
    }
  }

  private async handleNotification(session: Session, n: DroidNotification) {
    log("notification:", n.type);

    switch (n.type) {
      case "message":
        if (n.role === "assistant") {
          // Send assistant message as ACP sessionUpdate
          await this.client.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: n.text },
            },
          });
        }
        break;

      case "error":
        // Send error as system message
        await this.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Error: ${n.message}` },
          },
        });
        break;

      case "complete":
        // Resolve the prompt when complete
        if (session.promptResolve) {
          session.promptResolve({ stopReason: "end_turn" });
          session.promptResolve = null;
        }
        break;
    }
  }

  async cleanup() {
    for (const [, session] of this.sessions) {
      await session.droid.stop();
    }
    this.sessions.clear();
  }
}
