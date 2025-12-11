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
import { createDroidAdapter, type DroidAdapter } from "./droid-adapter.js";
import { log, generateId } from "./utils.js";
import type {
  DroidEvent,
  DroidSystemEvent,
  AutonumyLevel,
} from "./types.js";

/**
 * Session data structure
 */
interface Session {
  id: string;
  cwd: string;
  droid: DroidAdapter;
  droidSessionId?: string;
  model?: string;
  mode: AutonumyLevel;
  cancelled: boolean;
}

/**
 * Droid ACP Agent implementation
 * Bridges ACP protocol with Factory Droid CLI
 */
export class DroidAcpAgent implements Agent {
  private sessions: Map<string, Session> = new Map();
  private client: AgentSideConnection;

  constructor(client: AgentSideConnection) {
    this.client = client;
    log("DroidAcpAgent initialized");
  }

  /**
   * Initialize the agent and return capabilities
   */
  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    log("initialize called with:", request);

    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          image: false, // Droid doesn't support image input yet
          embeddedContext: true,
        },
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

  /**
   * Authenticate with the provided method
   * For Factory, we check FACTORY_API_KEY environment variable
   */
  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse> {
    log("authenticate called with method:", request.methodId);

    if (request.methodId === "factory-api-key") {
      const apiKey = process.env.FACTORY_API_KEY;
      if (!apiKey) {
        throw new Error("FACTORY_API_KEY environment variable is not set");
      }
      // API key is set, authentication successful
      return {};
    }

    throw new Error(`Unknown authentication method: ${request.methodId}`);
  }

  /**
   * Create a new session
   */
  async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = generateId();
    const cwd = request.cwd || process.cwd();
    const defaultMode: AutonumyLevel = "low";

    log("newSession called, cwd:", cwd);

    // Create droid adapter
    const droid = createDroidAdapter({
      cwd,
      autoLevel: defaultMode,
    });

    // Start droid process and wait for init
    const initEvent = (await droid.start()) as DroidSystemEvent;

    // Set up event handler for this session
    droid.onEvent((event) => {
      this.handleDroidEvent(sessionId, event);
    });

    // Create session
    const session: Session = {
      id: sessionId,
      cwd,
      droid,
      droidSessionId: initEvent.session_id,
      model: initEvent.model,
      mode: defaultMode,
      cancelled: false,
    };

    this.sessions.set(sessionId, session);
    log("Session created:", sessionId, "droid session:", initEvent.session_id);

    // Build available models list
    const models = [
      { modelId: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", description: "Most capable model" },
      { modelId: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", description: "Balanced performance" },
      { modelId: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", description: "Fast and efficient" },
      { modelId: "gpt-5.1-codex", name: "GPT 5.1 Codex", description: "OpenAI coding model" },
      { modelId: "gemini-3-pro-preview", name: "Gemini 3 Pro", description: "Google's model" },
    ];

    return {
      sessionId,
      models: {
        availableModels: models,
        currentModelId: initEvent.model,
      },
      modes: {
        currentModeId: defaultMode,
        availableModes: [
          { id: "low", name: "Low Risk", description: "Read-only + low-risk edits" },
          { id: "medium", name: "Medium Risk", description: "Development operations" },
          { id: "high", name: "High Risk", description: "Production operations" },
        ],
      },
    };
  }

  /**
   * Handle user prompt
   */
  async prompt(request: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${request.sessionId}`);
    }

    if (session.cancelled) {
      throw new Error("Session was cancelled");
    }

    log("prompt called, session:", request.sessionId);

    // Send message to droid - extract text from prompt content blocks
    const promptText = request.prompt
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    session.droid.sendMessage(promptText);

    // Wait for completion event
    return new Promise((resolve, reject) => {
      const onEvent = (event: DroidEvent) => {
        if (event.type === "completion") {
          resolve({ stopReason: "end_turn" });
        } else if (event.type === "error") {
          reject(new Error(event.message));
        }
      };

      session.droid.onEvent(onEvent);

      // Timeout after 10 minutes
      setTimeout(() => {
        reject(new Error("Prompt timeout"));
      }, 10 * 60 * 1000);
    });
  }

  /**
   * Cancel current execution
   */
  async cancel(request: CancelNotification): Promise<void> {
    const session = this.sessions.get(request.sessionId);
    if (session) {
      log("cancel called, session:", request.sessionId);
      session.cancelled = true;
      await session.droid.stop();
    }
  }

  /**
   * Set session model
   */
  async setSessionModel(request: SetSessionModelRequest): Promise<void> {
    const session = this.sessions.get(request.sessionId);
    if (session) {
      log("setSessionModel called:", request.modelId);
      session.model = request.modelId;
      // Note: Droid doesn't support model switching mid-session
      // Would need to restart the droid process
    }
  }

  /**
   * Set session mode (autonomy level)
   */
  async setSessionMode(request: SetSessionModeRequest): Promise<void> {
    const session = this.sessions.get(request.sessionId);
    if (session) {
      log("setSessionMode called:", request.modeId);
      const mode = request.modeId as AutonumyLevel;
      session.mode = mode;
      session.droid.setMode(mode);
    }
  }

  /**
   * Handle events from droid process and convert to ACP notifications
   */
  private async handleDroidEvent(sessionId: string, event: DroidEvent) {
    log("handleDroidEvent:", event.type);

    switch (event.type) {
      case "message":
        if (event.role === "assistant") {
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: event.text },
            },
          });
        }
        break;

      case "tool_call":
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: event.id,
            title: event.toolName,
            rawInput: JSON.stringify(event.parameters, null, 2),
            status: "in_progress",
          },
        });
        break;

      case "tool_result":
        // Use tool_call_update to report tool execution result
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: event.id,
            rawOutput: event.value,
            status: event.isError ? "failed" : "completed",
          },
        });
        break;

      case "completion":
        // Final message is already sent via message events
        break;

      case "error":
        log("Droid error:", event.message);
        break;
    }
  }

  /**
   * Cleanup all sessions
   */
  async cleanup() {
    for (const [_id, session] of this.sessions) {
      await session.droid.stop();
    }
    this.sessions.clear();
  }
}
