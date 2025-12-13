import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { log } from "./utils.js";
import type { AutonomyLevel } from "./types.js";

export interface DroidAdapterOptions {
  cwd: string;
}

export interface DroidAdapter {
  start(): Promise<DroidInitResult>;
  sendMessage(text: string): void;
  setMode(level: AutonomyLevel): void;
  onNotification(handler: (notification: DroidNotification) => void): void;
  onRawEvent(handler: (event: unknown) => void): void;
  onRequest(handler: (method: string, params: any) => Promise<any>): void;
  onExit(handler: (code: number | null) => void): void;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export interface DroidInitResult {
  sessionId: string;
  modelId: string;
  availableModels: Array<{ id: string; displayName: string }>;
}

// Droid notification types
export type DroidNotification =
  | { type: "working_state"; state: "idle" | "streaming_assistant_message" }
  | { type: "tool_result"; toolUseId: string; content: string }
  | { type: "message"; role: "user" | "assistant" | "system"; text?: string; id: string; toolUse?: any }
  | { type: "error"; message: string }
  | { type: "complete" };

/**
 * Factory API message format
 * 
 * NOTE: Droid CLI documentation for `stream-jsonrpc` format is outdated/inaccurate.
 * As of Droid v0.36.1, it uses the Factory API format (factoryApiVersion: "1.0.0")
 * via `droid.initialize_session`, `droid.session_notification` etc., instead of
 * the simplified JSON-RPC format described in the docs.
 */
interface FactoryRequest {
  jsonrpc: "2.0";
  factoryApiVersion: "1.0.0";
  type: "request";
  method: string;
  params: Record<string, unknown>;
  id: string;
}

/**
 * Create a Droid adapter using Factory API format
 */
export function createDroidAdapter(options: DroidAdapterOptions): DroidAdapter {
  let process: ChildProcess | null = null;
  let sessionId: string | null = null;
  const machineId = randomUUID();
  const notificationHandlers: Array<(n: DroidNotification) => void> = [];
  const rawEventHandlers: Array<(e: unknown) => void> = [];
  const exitHandlers: Array<(code: number | null) => void> = [];
  let requestHandler: ((method: string, params: any) => Promise<any>) | null = null;
  let initResolve: ((result: DroidInitResult) => void) | null = null;
  let initReject: ((error: Error) => void) | null = null;
  
  // State for message ordering
  let isStreamingAssistant = false;
  let pendingIdle = false;

  const send = (method: string, params: Record<string, unknown>) => {
    if (!process?.stdin?.writable) return;
    const msg: FactoryRequest = {
      jsonrpc: "2.0",
      factoryApiVersion: "1.0.0",
      type: "request",
      method,
      params,
      id: randomUUID(),
    };
    process.stdin.write(JSON.stringify(msg) + "\n");
    log("Sent:", method);
  };

  const emit = async (n: DroidNotification) => {
    for (const h of notificationHandlers) {
      await h(n);
    }
  };

  // Process queue sequentially using promise chain
  let processingChain: Promise<void> = Promise.resolve();

  const queueLine = (line: string) => {
    processingChain = processingChain.then(() => handleLine(line));
  };

  const handleLine = async (line: string) => {
    try {
      const msg = JSON.parse(line);
      
      // Emit raw event
      rawEventHandlers.forEach(h => h(msg));
      
      // Handle init response
      if (msg.type === "response" && msg.result?.sessionId && initResolve) {
        const r = msg.result;
        sessionId = r.sessionId;
        initResolve({
          sessionId: r.sessionId,
          modelId: r.settings?.modelId || "unknown",
          availableModels: r.availableModels || [],
        });
        initResolve = null;
        initReject = null;
        return;
      }

      // Handle error response
      if (msg.type === "response" && msg.error && initReject) {
        initReject(new Error(msg.error.message));
        initResolve = null;
        initReject = null;
        return;
      }

      // Handle notifications
      if (msg.type === "notification" && msg.method === "droid.session_notification") {
        const n = msg.params?.notification;
        if (!n) return;

        switch (n.type) {
          case "droid_working_state_changed":
            await emit({ type: "working_state", state: n.newState });
            
            if (n.newState === "streaming_assistant_message") {
              isStreamingAssistant = true;
              pendingIdle = false;
            } else if (n.newState === "idle") {
              // See docs/droid-quirks.md "Out-of-Order 'Idle' Notification"
              // Droid CLI (0.36.2) sometimes sends idle before the final assistant message
              if (isStreamingAssistant) {
                // Defer complete event until we get the actual message
                pendingIdle = true;
              } else {
                await emit({ type: "complete" });
              }
            }
            break;

          case "create_message":
            if (n.message) {
                const textContent = n.message.content?.find((c: any) => c.type === "text");
                const toolUseContent = n.message.content?.find((c: any) => c.type === "tool_use");

                if (textContent || toolUseContent) {
                    await emit({
                        type: "message",
                        role: n.message.role,
                        text: textContent?.text,
                        id: n.message.id,
                        toolUse: toolUseContent,
                    });
                    
                    // If we were waiting for this assistant message, now complete
                    if (n.message.role === "assistant") {
                      isStreamingAssistant = false;
                      if (pendingIdle) {
                        await emit({ type: "complete" });
                        pendingIdle = false;
                      }
                    }
                }
            }
            break;

          case "tool_result":
            await emit({
                type: "tool_result",
                toolUseId: n.toolUseId,
                content: n.content
            });
            break;

          case "error":
            isStreamingAssistant = false;
            pendingIdle = false;
            await emit({ type: "error", message: n.message });
            break;
        }
      }

      // Handle incoming requests (like permissions)
      if (msg.type === "request") {
        if (requestHandler) {
           try {
             const result = await requestHandler(msg.method, msg.params);
             const response = {
                jsonrpc: "2.0",
                factoryApiVersion: "1.0.0",
                type: "response",
                id: msg.id,
                result,
             };
             if (process?.stdin) {
                process.stdin.write(JSON.stringify(response) + "\n");
             }
           } catch (error: any) {
             const response = {
                jsonrpc: "2.0",
                factoryApiVersion: "1.0.0",
                type: "response",
                id: msg.id,
                error: {
                    code: -32603,
                    message: error.message || "Internal error",
                }
             };
             if (process?.stdin) {
                process.stdin.write(JSON.stringify(response) + "\n");
             }
           }
        } else if (msg.method === "droid.request_permission") {
          // Auto-approve as fallback if no handler (legacy behavior)
          const response = {
            jsonrpc: "2.0",
            factoryApiVersion: "1.0.0",
            type: "response",
            id: msg.id,
            result: { selectedOption: "proceed_once" },
          };
          if (process?.stdin) {
            process.stdin.write(JSON.stringify(response) + "\n");
          }
          log("Auto-approved permission request (fallback):", msg.id);
        }
      }
    } catch (err) {
      log("Parse error:", (err as Error).message);
    }
  };

  return {
    async start(): Promise<DroidInitResult> {
      const args = [
        "exec",
        "--input-format", "stream-jsonrpc",
        "--output-format", "stream-jsonrpc",
        "--cwd", options.cwd,
      ];

      log("Starting droid:", args);
      process = spawn("droid", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: globalThis.process.env,
      });

      if (process.stdout) {
        createInterface({ input: process.stdout }).on("line", queueLine);
      }
      if (process.stderr) {
        createInterface({ input: process.stderr }).on("line", (l) => log("[droid]", l));
      }

      process.on("error", (err) => {
        if (initReject) initReject(err);
      });
      process.on("exit", (code) => {
        log("Droid exit:", code);
        process = null;
        // Notify exit handlers for cleanup
        exitHandlers.forEach(h => h(code));
      });

      return new Promise((resolve, reject) => {
        initResolve = resolve;
        initReject = reject;
        send("droid.initialize_session", { machineId, cwd: options.cwd });
        const initTimeout = parseInt(globalThis.process.env.DROID_INIT_TIMEOUT || "60000", 10);
        setTimeout(() => {
          if (initReject) {
            initReject(new Error("Droid init timeout"));
            initResolve = null;
            initReject = null;
          }
        }, initTimeout);
      });
    },

    sendMessage(text: string) {
      if (!sessionId) return;
      send("droid.add_user_message", { sessionId, text });
    },

    setMode(level: AutonomyLevel) {
      if (!sessionId) return;
      send("droid.update_session_settings", {
        sessionId,
        settings: { autonomyLevel: level },
      });
    },

    onNotification(handler) {
      notificationHandlers.push(handler);
    },

    onRawEvent(handler) {
      rawEventHandlers.push(handler);
    },

    onRequest(handler) {
      requestHandler = handler;
    },

    onExit(handler) {
      exitHandlers.push(handler);
    },

    async stop() {
      if (process) {
        process.stdin?.end();
        process.kill("SIGTERM");
        process = null;
      }
    },

    isRunning() {
      return process !== null && !process.killed;
    },
  };
}
