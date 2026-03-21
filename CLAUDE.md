# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Scrypted plugin for Wyze IP cameras using the native P2P/DTLS protocol (TUTK IOTC). Provides local video streaming without the Wyze app or cloud RTSP. The repo contains two components:

- **Plugin** (`src/`) — Scrypted DeviceProvider plugin, bundled by `scrypted-webpack`
- **Library** (`wyze-bridge/`) — Wyze P2P/DTLS protocol implementation, consumed as a local file dependency (`file:./wyze-bridge`)

## Build Commands

### Plugin (root)
```bash
npm run build              # scrypted-webpack → dist/main.nodejs.js + dist/plugin.zip
npm run scrypted-deploy-debug  # build + deploy to debug Scrypted instance
```

### Library (wyze-bridge/)
```bash
cd wyze-bridge
npm run build              # tsup (ESM+CJS)
npm run typecheck           # tsc --noEmit
```

### Rebuild library and reinstall in plugin
```bash
./build-lib.sh             # builds library then runs npm install at root
```

After modifying `wyze-bridge/`, always run `./build-lib.sh` from the root before building/deploying the plugin.

## Architecture

### Plugin Entry Point
`src/main.ts` — `WyzeNativeProvider` is the root `DeviceProvider` and `DeviceCreator`. It manages:
- Wyze cloud credentials (shared across all cameras)
- Device discovery via Wyze Cloud API
- Device lifecycle

### Device Hierarchy
- `WyzeNativeProvider` (`main.ts`) — provider, manages credentials and discovery
- `WyzeNativeCamera` (`camera.ts`) — per-camera device, manages P2P connection lifecycle

### Connection Architecture
Each camera owns its own P2P connection:
- **Plugin level**: Cloud credentials (shared) — used only for discovery
- **Camera level**: P2P/DTLS connection (per-camera, on-demand)
  - UDP socket → IOTC session → DTLS 1.2 (ECDHE-PSK ChaCha20-Poly1305)
  - AV Login → K-Auth (XXTEA challenge/response)
  - RFC 4571 TCP server (localhost) for Scrypted

### Connection Lifecycle
- Created on-demand when `getVideoStream()` is called
- Shared across multiple concurrent viewers (single P2P, multiple TCP clients)
- Torn down after configurable idle timeout (default: 30s)
- Auto-reconnects on next stream request

### Key Library Classes
- `WyzeCloud` — Wyze cloud API (login, camera discovery)
- `WyzeDTLSConn` — Full P2P connection (discovery → DTLS → auth → frames)
- `createWyzeRfc4571Server()` — RFC 4571 TCP server wrapping WyzeDTLSConn

## TypeScript Configuration

- **Plugin**: `module: Node16`, `target: ES2021`, no strict mode
- **Library**: `target: ES2022`, `moduleResolution: Bundler`

## Debugging

VS Code launch config attaches to a Scrypted instance on port 10081 (configured via `scrypted.debugHost`). Pre-launch task runs `npm run scrypted-vscode-launch`.

## Key Local Dependencies

The plugin references sibling local repos via `file:` paths:
- `@scrypted/common` → `../../scrypted/common`
- `@scrypted/rtsp` → `../../scrypted/plugins/rtsp`
- `@camstack/wyze-bridge` → `./wyze-bridge`

These must exist on disk for `npm install` to succeed.
