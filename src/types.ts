/**
 * Droid stream-jsonrpc event types
 */

export interface DroidSystemEvent {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  model: string;
}

export interface DroidMessageEvent {
  type: "message";
  role: "user" | "assistant";
  id: string;
  text: string;
  timestamp: number;
  session_id: string;
}

export interface DroidToolCallEvent {
  type: "tool_call";
  id: string;
  messageId: string;
  toolId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  timestamp: number;
  session_id: string;
}

export interface DroidToolResultEvent {
  type: "tool_result";
  id: string;
  messageId: string;
  toolId: string;
  isError: boolean;
  value: string;
  timestamp: number;
  session_id: string;
}

export interface DroidCompletionEvent {
  type: "completion";
  finalText: string;
  numTurns: number;
  durationMs: number;
  session_id: string;
  timestamp: number;
}

export interface DroidErrorEvent {
  type: "error";
  message: string;
  session_id?: string;
}

export type DroidEvent =
  | DroidSystemEvent
  | DroidMessageEvent
  | DroidToolCallEvent
  | DroidToolResultEvent
  | DroidCompletionEvent
  | DroidErrorEvent;

/**
 * Droid JSONRPC input message types
 */
export interface DroidInputMessage {
  jsonrpc: "2.0";
  method: "message";
  params: {
    role: "user";
    text: string;
  };
  id?: string | number;
}

export interface DroidModeChangeMessage {
  jsonrpc: "2.0";
  method: "set_mode";
  params: {
    mode: "low" | "medium" | "high";
  };
  id?: string | number;
}

export type DroidInput = DroidInputMessage | DroidModeChangeMessage;

/**
 * Autonomy level mapping
 */
export type AutonumyLevel = "low" | "medium" | "high";

export const AUTONOMY_DESCRIPTIONS: Record<AutonumyLevel, string> = {
  low: "Read-only + low-risk file edits (whitespace, comments)",
  medium: "Development operations (create files, run dev commands)",
  high: "Production operations (delete files, run any commands)",
};
