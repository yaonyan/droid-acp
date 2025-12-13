# Droid CLI Protocol Quirks

**Droid Version:** `0.36.2` (Verified)

This document records observed non-standard behaviors or bugs in the Droid CLI's JSON-RPC implementation and how `droid-acp` handles them.

## 1. Out-of-Order "Idle" Notification

### Issue
When using `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`, the Droid CLI sometimes sends the `droid_working_state_changed: idle` notification *before* the final `create_message` notification for the assistant's response.

**Observed Sequence:**
1. `droid.session_notification` -> `droid_working_state_changed: streaming_assistant_message`
2. ... (streaming updates) ...
3. `droid.session_notification` -> `droid_working_state_changed: idle`  <-- PREMATURE IDLE
4. `droid.session_notification` -> `create_message` (role: assistant)

### Impact
If the client (adapter) completes the turn immediately upon receiving `idle`, the Assistant's final message might be missed or arrive after the turn has ended. In ACP, this causes the `session/prompt` to resolve with `stopReason: "end_turn"` before the final `agent_message_chunk` is sent.

### Workaround
The adapter implements a buffering mechanism in `handleNotification` (specifically for `droid_working_state_changed`):

- **Tracking State**: We track `isStreamingAssistant` when state becomes `streaming_assistant_message`.
- **Buffering Idle**: If `idle` is received while `isStreamingAssistant` is true, we set a `pendingIdle` flag instead of emitting `complete` immediately.
- **Flushing**: When the subsequent `create_message` (role: assistant) arrives, we check if `pendingIdle` is set. If so, we emit the `complete` event *after* processing the message.

```typescript
// src/droid-adapter.ts logic
if (n.newState === "idle") {
  if (isStreamingAssistant) {
    // Defer complete event until we get the actual message
    pendingIdle = true;
  } else {
    await emit({ type: "complete" });
  }
}
```

### Reproduction
You can reproduce this issue using the `test-droid-cli.mjs` script in the root of this repository. This script spawns the Droid CLI and prints the raw JSON-RPC messages, showing the exact timestamp and order of events.

## 2. Outdated Documentation Event Types

The official Droid documentation references event types that appear to be outdated or inconsistent with the actual CLI output.

- **Docs say:** `tool_call` and `tool_return`
- **Actual Output:** `message` (with `toolUse` property) and `tool_result`

The adapter handles the *actual* output format observed from the CLI, which aligns more closely with the Anthropic generic message format rather than the documented specific event types.
