/**
 * Droid event types (for internal use, actual format depends on Factory API)
 */

// Simplified event types - the actual Factory API responses are more complex
// but we normalize them for ACP compatibility
export interface DroidEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Autonomy level - maps to Factory's autonomyLevel setting
 */
export type AutonomyLevel = "suggest" | "normal" | "full";

// ACP mode to Droid autonomy mapping
export const ACP_TO_DROID_MODE: Record<string, AutonomyLevel> = {
  low: "suggest",
  medium: "normal", 
  high: "full",
};
