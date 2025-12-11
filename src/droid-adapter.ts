import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { log, generateId } from "./utils.js";
import type {
  DroidEvent,
  DroidInput,
  AutonumyLevel,
} from "./types.js";

export interface DroidAdapterOptions {
  cwd: string;
  autoLevel?: AutonumyLevel;
  model?: string;
}

export interface DroidAdapter {
  /** Start the droid process */
  start(): Promise<DroidEvent>;
  /** Send a user message */
  sendMessage(text: string): void;
  /** Set autonomy mode */
  setMode(level: AutonumyLevel): void;
  /** Listen for events */
  onEvent(handler: (event: DroidEvent) => void): void;
  /** Stop the droid process */
  stop(): Promise<void>;
  /** Check if process is running */
  isRunning(): boolean;
}

/**
 * Create a Droid adapter that manages a `droid exec --stream-jsonrpc` subprocess
 */
export function createDroidAdapter(options: DroidAdapterOptions): DroidAdapter {
  let process: ChildProcess | null = null;
  let eventHandlers: Array<(event: DroidEvent) => void> = [];
  let initPromise: {
    resolve: (event: DroidEvent) => void;
    reject: (error: Error) => void;
  } | null = null;

  const emitEvent = (event: DroidEvent) => {
    eventHandlers.forEach((handler) => handler(event));
  };

  const sendToProcess = (input: DroidInput) => {
    if (process?.stdin?.writable) {
      const line = JSON.stringify(input) + "\n";
      process.stdin.write(line);
      log("Sent to droid:", input);
    }
  };

  return {
    async start(): Promise<DroidEvent> {
      const args = [
        "exec",
        "--input-format", "stream-jsonrpc",
        "--output-format", "stream-jsonrpc",
        "--cwd", options.cwd,
      ];

      if (options.autoLevel) {
        args.push("--auto", options.autoLevel);
      }

      if (options.model) {
        args.push("--model", options.model);
      }

      log("Starting droid with args:", args);

      process = spawn("droid", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: globalThis.process.env,
      });

      // Handle stderr for logging
      if (process.stderr) {
        const stderrReader = createInterface({ input: process.stderr });
        stderrReader.on("line", (line) => {
          log("[droid stderr]", line);
        });
      }

      // Handle stdout for JSON events
      if (process.stdout) {
        const stdoutReader = createInterface({ input: process.stdout });
        stdoutReader.on("line", (line) => {
          try {
            const event = JSON.parse(line) as DroidEvent;
            log("Received from droid:", event.type);

            // Resolve init promise if waiting
            if (event.type === "system" && event.subtype === "init" && initPromise) {
              initPromise.resolve(event);
              initPromise = null;
            }

            emitEvent(event);
          } catch (err) {
            log("Failed to parse droid output:", line, err);
          }
        });
      }

      // Handle process exit
      process.on("exit", (code, signal) => {
        log("Droid process exited with code:", code, "signal:", signal);
        process = null;
      });

      process.on("error", (err) => {
        log("Droid process error:", err);
        if (initPromise) {
          initPromise.reject(err);
          initPromise = null;
        }
      });

      // Wait for init event
      return new Promise((resolve, reject) => {
        initPromise = { resolve, reject };
        
        // Timeout after 30 seconds
        setTimeout(() => {
          if (initPromise) {
            initPromise.reject(new Error("Droid init timeout"));
            initPromise = null;
          }
        }, 30000);
      });
    },

    sendMessage(text: string) {
      sendToProcess({
        jsonrpc: "2.0",
        method: "message",
        params: {
          role: "user",
          text,
        },
        id: generateId(),
      });
    },

    setMode(level: AutonumyLevel) {
      sendToProcess({
        jsonrpc: "2.0",
        method: "set_mode",
        params: {
          mode: level,
        },
        id: generateId(),
      });
    },

    onEvent(handler: (event: DroidEvent) => void) {
      eventHandlers.push(handler);
    },

    async stop() {
      if (process) {
        process.stdin?.end();
        process.kill("SIGTERM");
        
        // Wait for process to exit
        await new Promise<void>((resolve) => {
          if (process) {
            process.on("exit", () => resolve());
          } else {
            resolve();
          }
        });
        
        process = null;
      }
      eventHandlers = [];
    },

    isRunning() {
      return process !== null && !process.killed;
    },
  };
}
