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
  | { type: "message"; role: "user" | "assistant" | "system"; text: string; id: string }
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
  let initResolve: ((result: DroidInitResult) => void) | null = null;
  let initReject: ((error: Error) => void) | null = null;

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

  const emit = (n: DroidNotification) => {
    notificationHandlers.forEach((h) => h(n));
  };

  const handleLine = (line: string) => {
    try {
      const msg = JSON.parse(line);
      
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
            emit({ type: "working_state", state: n.newState });
            if (n.newState === "idle") {
              emit({ type: "complete" });
            }
            break;

          case "create_message":
            const content = n.message?.content?.[0];
            if (content?.type === "text") {
              emit({
                type: "message",
                role: n.message.role,
                text: content.text,
                id: n.message.id,
              });
            }
            break;

          case "error":
            emit({ type: "error", message: n.message });
            break;
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
        createInterface({ input: process.stdout }).on("line", handleLine);
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
      });

      return new Promise((resolve, reject) => {
        initResolve = resolve;
        initReject = reject;
        send("droid.initialize_session", { machineId, cwd: options.cwd });
        setTimeout(() => {
          if (initReject) {
            initReject(new Error("Droid init timeout"));
            initResolve = null;
            initReject = null;
          }
        }, 30000);
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
