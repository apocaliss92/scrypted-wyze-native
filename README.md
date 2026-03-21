# Wyze Native

Scrypted plugin for Wyze cameras using the native P2P/DTLS protocol. Provides local video streaming without relying on the Wyze app or cloud RTSP.

## Features

- **Native P2P streaming** — connects directly to Wyze cameras on your LAN via TUTK/DTLS protocol
- **No cloud dependency for streaming** — cloud API is only used for initial device discovery (getting P2P connection parameters)
- **H264 1080p/720p/360p/2K** — configurable resolution per camera
- **Auto-discovery** — finds all cameras from your Wyze account
- **Multiple concurrent viewers** — single P2P connection shared across viewers
- **Idle teardown** — automatically disconnects when no viewers are active

## Requirements

- Wyze camera on the same local network
- Wyze account credentials (email + password)
- Wyze Developer API Key and Key ID from [Wyze Developer Portal](https://support.wyze.com/hc/en-us/articles/16129834216731)

## Setup

1. Install the plugin in Scrypted
2. Configure your Wyze account credentials in plugin settings
3. Configure your Wyze Developer API Key and Key ID
4. Click "Discover Devices" to find your cameras

## Supported Cameras

Tested with DTLS-enabled Wyze cameras. The plugin uses the same P2P protocol as the go2rtc Wyze integration.

## Technical Details

- Protocol: TUTK IOTC → DTLS 1.2 (ECDHE-PSK + ChaCha20-Poly1305) → AV frames
- Video: H264/H265 via FrameHandler parsing
- Audio: PCM 16-bit LE (receive only, for now)
- Streaming: RFC 4571 (RTP over TCP) to Scrypted

## Credits

- Based on the [go2rtc Wyze implementation](https://github.com/AlexxIT/go2rtc/tree/master/pkg/wyze)
- Uses `@camstack/wyze-bridge` library for P2P protocol

[For requests and bugs](https://github.com/apocaliss92/scrypted-wyze-native)

☕️ If this extension works well for you, consider buying me a coffee. Thanks!
[Buy me a coffee!](https://buymeacoffee.com/apocaliss92)
