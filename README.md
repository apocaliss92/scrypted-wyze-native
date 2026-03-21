# Wyze Native

Scrypted plugin for Wyze cameras using the native P2P/DTLS protocol. Streams video directly from the camera over your local network — the Wyze cloud is only used for initial device discovery.

## Features

- **Local P2P streaming** — H264 1080p/720p/360p/2K directly from camera
- **No cloud streaming dependency** — cloud API used only for discovery
- **Auto-discovery** — finds all cameras from your Wyze account
- **Multiple concurrent viewers** — single P2P connection shared
- **Idle teardown** — auto-disconnects when no viewers (configurable)
- **Two-way audio** — detected automatically (playback coming soon)

## Requirements

- Wyze camera(s) on the same local network as Scrypted
- Wyze account with **email + password** login (Google/Apple sign-in not supported by API)
- Wyze Developer API Key and Key ID

## Setup

1. Install the plugin in Scrypted
2. Configure credentials in plugin settings:
   - **Email** — your Wyze account email
   - **Password** — your Wyze account password
   - **API Key** — from [Wyze Developer Portal](https://support.wyze.com/hc/en-us/articles/16129834216731)
   - **Key ID** — associated with the API Key
3. Click **Discover Devices**

### If you signed up with Google/Apple/Facebook

You need to add a password to your Wyze account:
1. Open the **Wyze app** → Account → Security → Password
2. Or go to [wyze.com](https://www.wyze.com) → sign in → Account Settings → set a password

**Documentation:** [https://advanced-notifier-docs.zentik.app/docs/wyze-native](https://advanced-notifier-docs.zentik.app/docs/wyze-native)

[For requests and bugs](https://github.com/apocaliss92/scrypted-wyze-native)

☕️ If this extension works well for you, consider buying me a coffee. Thanks!
[Buy me a coffee!](https://buymeacoffee.com/apocaliss92)
