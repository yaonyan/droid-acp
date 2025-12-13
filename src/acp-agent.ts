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
import * as fs from "node:fs/promises";
import * as path from "node:path";
interface Session {
  id: string;
  droid: DroidAdapter;
  droidSessionId: string;
  model: string;
  mode: string; // ACP mode: "low", "medium", "high"
  cancelled: boolean;
  promptResolve: ((result: PromptResponse) => void) | null;
  activeToolCallIds: Set<string>;
  toolCallStatus: Map<string, "pending" | "in_progress" | "completed">;
  toolNames: Map<string, string>;
  mcpConfigPath: string | null; // Path to MCP config file (for cleanup)
  mcpServerKeys: string[]; // Server keys to remove during cleanup
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

    // Write MCP config file if mcpServers provided
    // Add session ID suffix to server names to avoid conflicts with concurrent sessions
    let mcpConfigPath: string | null = null;
    const mcpServerKeys: string[] = []; // Track keys for cleanup
    if (request.mcpServers && request.mcpServers.length > 0) {
      const configDir = path.join(cwd, ".factory");
      mcpConfigPath = path.join(configDir, "mcp.json");
      
      // Read existing config or create new one
      let existingConfig: { mcpServers?: Record<string, unknown> } = {};
      try {
        const content = await fs.readFile(mcpConfigPath, "utf-8");
        existingConfig = JSON.parse(content);
      } catch {
        // File doesn't exist, use empty config
      }
      
      // Convert ACP mcpServers to Droid format with unique keys
      const mcpConfig: Record<string, Record<string, unknown>> = existingConfig.mcpServers as Record<string, Record<string, unknown>> || {};
      for (const server of request.mcpServers) {
        // Cast to any to access properties - ACP SDK uses discriminated unions
        const s = server as any;
        const uniqueKey = `${server.name}-${sessionId}`;
        mcpServerKeys.push(uniqueKey);
        
        // Infer type from fields: command -> stdio, url -> http
        // ACP SDK may not always include explicit type field
        if (s.command) {
          mcpConfig[uniqueKey] = {
            type: "stdio",
            command: s.command,
            ...(s.args && { args: s.args }),
            ...(s.env && Object.keys(s.env).length > 0 && { env: s.env }),
            disabled: false,
          };
        } else if (s.url) {
          mcpConfig[uniqueKey] = {
            type: "http",
            url: s.url,
            ...(s.headers && { headers: s.headers }),
            disabled: false,
          };
        }
      }
      
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(mcpConfigPath, JSON.stringify({ mcpServers: mcpConfig }, null, 2));
      log("Wrote MCP config:", mcpConfigPath, mcpServerKeys);
    }

    const droid = createDroidAdapter({ cwd });
    const initResult: DroidInitResult = await droid.start();

    const session: Session = {
      id: sessionId,
      droid,
      droidSessionId: initResult.sessionId,
      model: initResult.modelId,
      mode: "medium", // Default to medium mode
      cancelled: false,
      promptResolve: null,
      activeToolCallIds: new Set(),
      toolCallStatus: new Map(),
      toolNames: new Map(),
      mcpConfigPath,
      mcpServerKeys,
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
    
    // Handle permissions requests
    droid.onRequest(async (method, params) => {
        if (method === "droid.request_permission") {
            return this.handlePermission(session, params);
        }
        throw new Error("Method not supported");
    });

    // Handle droid process exit - cleanup MCP config
    droid.onExit(async () => {
      log("Droid exited, cleaning up session:", session.id);
      await this.cleanupSessionMcpConfig(session);
      this.sessions.delete(session.id);
    });

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
      await this.cleanupSessionMcpConfig(session);
      this.sessions.delete(request.sessionId);
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
      session.mode = request.modeId; // Update session mode
      const droidMode = ACP_TO_DROID_MODE[request.modeId] as AutonomyLevel;
      if (droidMode) {
        session.droid.setMode(droidMode);
      }
    }
  }

  private async handlePermission(session: Session, params: any): Promise<any> {
    const toolUse = params.toolUses?.[0]?.toolUse;
    if (!toolUse) {
         return { selectedOption: "proceed_once" }; // Default fallback
    }

    const toolCallId = toolUse.id;
    const toolName = toolUse.name;
    const command = toolUse.input?.command || JSON.stringify(toolUse.input);
    const riskLevel = toolUse.input?.riskLevel || "medium"; // low, medium, high

    log("Permission request for tool:", toolCallId, "risk:", riskLevel, "mode:", session.mode);

    // 1. Emit tool_call (pending)
    session.activeToolCallIds.add(toolCallId);
    session.toolNames.set(toolCallId, toolName);
    session.toolCallStatus.set(toolCallId, "pending");
    await this.client.sessionUpdate({
        sessionId: session.id,
        update: {
            sessionUpdate: "tool_call",
            toolCallId: toolCallId,
            kind: "execute",
            title: `Running ${toolName}: ${command}`,
            status: "pending",
        }
    });

    // 2. Auto-approve/reject based on session mode and risk level
    let decision: "proceed_once" | "proceed_always" | "cancel";
    
    if (session.mode === "high") {
      // High mode: auto-approve everything
      decision = "proceed_always";
      log("Auto-approved (high mode)");
    } else if (session.mode === "medium") {
      // Medium mode: approve low/medium risk, reject high risk
      if (riskLevel === "low" || riskLevel === "medium") {
        decision = "proceed_once";
        log("Auto-approved (medium mode, low/med risk)");
      } else {
        decision = "cancel";
        log("Auto-rejected (medium mode, high risk)");
      }
    } else {
      // Low mode: reject everything
      decision = "cancel";
      log("Auto-rejected (low mode)");
    }

    // Update status based on decision
    if (decision === "cancel") {
      session.toolCallStatus.set(toolCallId, "completed");
    } else {
      session.toolCallStatus.set(toolCallId, "in_progress");
    }

    return { selectedOption: decision };
  }

  private async handleNotification(session: Session, n: DroidNotification) {
    log("notification:", n.type);

    switch (n.type) {
      case "message":
        if (n.role === "assistant") {
          // Handle tool use in message
          if (n.toolUse) {
             const toolCallId = n.toolUse.id;
             if (!session.activeToolCallIds.has(toolCallId)) {
                 session.activeToolCallIds.add(toolCallId);
                 session.toolNames.set(toolCallId, n.toolUse.name);
                 session.toolCallStatus.set(toolCallId, "in_progress"); // Assume started if we see it late without permission req
                  await this.client.sessionUpdate({
                     sessionId: session.id,
                     update: {
                         sessionUpdate: "tool_call",
                         toolCallId: toolCallId,
                         kind: "execute",
                         title: `Running ${n.toolUse.name}`,
                         status: "in_progress",
                     }
                  });
             } else {
                 // Update status to in_progress if it was pending
                 const status = session.toolCallStatus.get(toolCallId);
                 if (status !== "completed") {
                     session.toolCallStatus.set(toolCallId, "in_progress");
                      await this.client.sessionUpdate({
                         sessionId: session.id,
                         update: {
                             sessionUpdate: "tool_call_update",
                             toolCallId: toolCallId,
                             status: "in_progress",
                         }
                      });
                 }
             }
          }

          // Handle text content
          if (n.text) {
              await this.client.sessionUpdate({
                sessionId: session.id,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: n.text },
                },
              });
          }
        }
        break;

      case "tool_result":
        // First, send the tool response content
        // TODO: This might be a temporary fix.
        // First, send the tool response content
        // TODO: This might be a temporary fix.
        await this.client.sessionUpdate({
            sessionId: session.id,
            update: {
                sessionUpdate: "tool_call_update",
                toolCallId: n.toolUseId,
                content: [
                    {
                        type: "content",
                        content: {
                            type: "text",
                            text: n.content
                        }
                    }
                ],
                _meta: {
                    claudeCode: {
                        toolName: session.toolNames.get(n.toolUseId) || "unknown",
                        toolResponse: [
                            {
                                type: "text",
                                text: n.content
                            }
                        ]
                    }
                }
            }
        });
        
        // Then, send the completion status separately
        session.toolCallStatus.set(n.toolUseId, "completed");
        await this.client.sessionUpdate({
            sessionId: session.id,
            update: {
                sessionUpdate: "tool_call_update",
                toolCallId: n.toolUseId,
                status: "completed"
            }
        });
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
        // Since emit() now awaits handlers, all sessionUpdate calls have completed
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
      await this.cleanupSessionMcpConfig(session);
    }
    this.sessions.clear();
  }

  /**
   * Clean up MCP config entries created for this session
   * Only removes this session's server keys, preserving other sessions' configs
   */
  private async cleanupSessionMcpConfig(session: Session): Promise<void> {
    if (session.mcpConfigPath && session.mcpServerKeys.length > 0) {
      try {
        // Read existing config
        const content = await fs.readFile(session.mcpConfigPath, "utf-8");
        const config = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
        
        if (config.mcpServers) {
          // Remove only this session's keys
          for (const key of session.mcpServerKeys) {
            delete config.mcpServers[key];
          }
          log("Cleaned up MCP config keys:", session.mcpServerKeys);
          
          // Write back or delete if empty
          if (Object.keys(config.mcpServers).length === 0) {
            await fs.unlink(session.mcpConfigPath);
            log("Removed empty MCP config:", session.mcpConfigPath);
            
            // Try to remove .factory dir if empty
            const configDir = path.dirname(session.mcpConfigPath);
            const files = await fs.readdir(configDir);
            if (files.length === 0) {
              await fs.rmdir(configDir);
              log("Removed empty .factory dir:", configDir);
            }
          } else {
            await fs.writeFile(session.mcpConfigPath, JSON.stringify(config, null, 2));
          }
        }
      } catch (err) {
        // Ignore errors (file may not exist)
        log("MCP config cleanup error (ignored):", (err as Error).message);
      }
    }
  }
}
