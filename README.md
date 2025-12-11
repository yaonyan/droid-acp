# Droid ACP Agent

ACP (Agent Client Protocol) adapter for [Factory Droid CLI](https://docs.factory.ai/cli/droid-exec/overview).

This agent bridges the ACP protocol with Factory Droid, allowing ACP clients (like Zed Editor) to use Droid as their AI coding backend.

## Installation

```bash
# From npm (after published)
npm install -g droid-acp

# From source
git clone <repo>
cd droid-acp
pnpm install
pnpm build
```

## Prerequisites

1. **Droid CLI** installed: `curl -fsSL https://app.factory.ai/cli | sh`
2. **Factory API Key**: Get from [Factory Settings](https://app.factory.ai/settings/api-keys)

```bash
export FACTORY_API_KEY=fk-...
```

## Usage

### With Zed Editor

Add to your Zed settings:

```json
{
  "agents": {
    "droid": {
      "command": "droid-acp",
      "env": {
        "FACTORY_API_KEY": "fk-..."
      }
    }
  }
}
```

### Standalone

```bash
# Run directly
node dist/index.mjs
```

## Features

- **Multi-model support**: Claude Opus/Sonnet/Haiku, GPT-5.1, Gemini 3 Pro
- **Autonomy levels**: Low (read-only), Medium (dev ops), High (production ops)
- **Session management**: Persistent sessions with conversation history
- **Tool execution**: File operations, command execution, code search

## Architecture

```
┌──────────────┐   ACP/NDJSON    ┌─────────────────┐
│  ACP Client  │ ◄─────────────► │  Droid ACP      │
│  (Zed/etc)   │                 │  Adapter        │
└──────────────┘                 └────────┬────────┘
                                          │ spawn
                                          ▼
                                 ┌─────────────────┐
                                 │  droid exec     │
                                 │  --stream-jsonrpc│
                                 └─────────────────┘
```

## Development

```bash
# Build
pnpm build

# Watch mode
pnpm dev

# Type check
pnpm typecheck

# Test
pnpm test
```

## License

MIT
