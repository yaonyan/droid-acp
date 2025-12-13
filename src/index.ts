#!/usr/bin/env node

/**
 * Droid ACP Agent Entry Point
 * 
 * This agent bridges the ACP protocol with Factory Droid CLI,
 * allowing ACP clients (like Zed) to use Droid as their AI backend.
 */
// Redirect all console output to stderr (stdout is reserved for ACP protocol)
const _originalLog = console.log;
console.log = console.error;
console.info = console.error;
console.warn = console.error;

// Handle unhandled rejections
process.on("unhandledRejection", (reason, _promise) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

import {
  AgentSideConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { DroidAcpAgent } from "./acp-agent.js";
import { nodeToWebReadable, nodeToWebWritable, log } from "./utils.js";

function main() {
  log("Starting Droid ACP Agent...");

  // Create NDJSON stream from stdin/stdout
  const stream = ndJsonStream(
    nodeToWebWritable(process.stdout),
    nodeToWebReadable(process.stdin)
  );

  // Create ACP connection and track agent for cleanup
  let agent: DroidAcpAgent | null = null;
  new AgentSideConnection(
    (client: AgentSideConnection) => {
      agent = new DroidAcpAgent(client);
      return agent;
    },
    stream
  );

  // Cleanup on process exit
  const cleanup = async () => {
    log("Process exiting, cleaning up...");
    if (agent) {
      await agent.cleanup();
    }
    process.exit(0);
  };

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.stdin.on("close", cleanup);

  log("Droid ACP Agent ready, waiting for connections...");
}

main();

// Keep process running
process.stdin.resume();
