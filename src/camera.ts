/**
 * Wyze Camera device — per-camera P2P connection + RFC 4571 streaming.
 *
 * Connection lifecycle:
 *   - Created on-demand when getVideoStream() is called
 *   - Shared across multiple concurrent viewers
 *   - Torn down after idle timeout (no active TCP clients)
 *   - Auto-reconnects on next getVideoStream() call
 *
 * Each camera owns its own:
 *   - UDP socket → IOTC session → DTLS connection → AV frames
 *   - RFC 4571 TCP server (localhost)
 */

import sdk, {
  Camera,
  MediaObject,
  Online,
  RequestMediaStreamOptions,
  ResponseMediaStreamOptions,
  ScryptedDeviceBase,
  ScryptedMimeTypes,
  Setting,
  Settings,
  VideoCamera,
} from "@scrypted/sdk";
import type WyzeNativeProvider from "./main";

interface WyzeRfc4571Server {
  host: string;
  port: number;
  sdp: string;
  videoType: string;
  close: () => Promise<void>;
}

export class WyzeNativeCamera
  extends ScryptedDeviceBase
  implements VideoCamera, Settings, Online
{
  provider: WyzeNativeProvider;
  private rfcServer: WyzeRfc4571Server | null = null;
  private rfcServerPromise: Promise<WyzeRfc4571Server> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeViewers = 0;

  constructor(nativeId: string, provider?: WyzeNativeProvider) {
    super(nativeId);
    if (provider) this.provider = provider;
  }

  // ─── Online ────────────────────────────────────────────────────

  checkOnline(): boolean {
    const info = this.provider.getCameraInfo(this.nativeId);
    return info?.isOnline ?? true;
  }

  // ─── Camera Settings (per-camera) ─────────────────────────────

  async getSettings(): Promise<Setting[]> {
    const info = this.provider.getCameraInfo(this.nativeId);
    const connected = !!this.rfcServer;

    return [
      {
        group: "Camera Info",
        key: "ip",
        title: "IP Address",
        description: "Local IP address (auto-discovered or manual)",
        value: info?.ip || this.storage.getItem("ip") || "",
        readonly: !!info?.ip,
        type: "string",
      },
      {
        group: "Camera Info",
        key: "p2pId",
        title: "P2P UID",
        value: info?.p2pId || "",
        readonly: true,
        type: "string",
      },
      {
        group: "Camera Info",
        key: "mac",
        title: "MAC Address",
        value: info?.mac || this.nativeId,
        readonly: true,
        type: "string",
      },
      {
        group: "Camera Info",
        key: "model",
        title: "Model",
        value: info?.productModel || "",
        readonly: true,
        type: "string",
      },
      {
        group: "Camera Info",
        key: "firmware",
        title: "Firmware",
        value: info?.firmwareVer || "",
        readonly: true,
        type: "string",
      },
      {
        group: "Stream",
        key: "resolution",
        title: "Resolution",
        description: "Video resolution preset",
        value: this.storage.getItem("resolution") || "1080p",
        choices: ["1080p", "720p", "360p", "2K"],
        type: "string",
      },
      {
        group: "Stream",
        key: "bitrate",
        title: "Bitrate",
        description: "Video bitrate preset",
        value: this.storage.getItem("bitrate") || "max",
        choices: ["max", "sd"],
        type: "string",
      },
      {
        group: "Status",
        key: "status",
        title: "Connection Status",
        value: connected ? "🟢 Connected (P2P/DTLS)" : "⚪ Disconnected",
        readonly: true,
        type: "string",
      },
      {
        group: "Status",
        key: "viewers",
        title: "Active Viewers",
        value: String(this.activeViewers),
        readonly: true,
        type: "string",
      },
    ];
  }

  async putSetting(key: string, value: string): Promise<void> {
    this.storage.setItem(key, value);

    // Restart stream on quality change
    if (key === "resolution" || key === "bitrate") {
      this.console.log(`${key} changed to ${value}, restarting stream...`);
      await this.teardownConnection("settings changed");
    }
  }

  private getResolutionFrameSize(): number {
    switch (this.storage.getItem("resolution") || "1080p") {
      case "360p": return 1;
      case "720p": return 2;
      case "2K": return 3;
      default: return 0; // 1080p
    }
  }

  private getBitrateValue(): number {
    return (this.storage.getItem("bitrate") || "max") === "sd" ? 0x3C : 0xF0;
  }

  // ─── VideoCamera ───────────────────────────────────────────────

  async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
    return [
      {
        id: "native-main",
        name: "Native P2P",
        container: "rtp",
        video: { codec: "h264" },
      },
    ];
  }

  async getVideoStream(
    _options?: RequestMediaStreamOptions
  ): Promise<MediaObject> {
    const server = await this.ensureRfcServer();

    this.activeViewers++;
    this.clearIdleTimer();

    const rfc = {
      url: new URL(`tcp://${server.host}:${server.port}`),
      sdp: server.sdp,
      mediaStreamOptions: {
        id: "native-main",
        name: "Native P2P",
        container: "rtp",
        video: { codec: server.videoType.toLowerCase() },
      },
    };

    // Schedule idle teardown when this viewer eventually disconnects.
    // The RFC4571 server tracks TCP clients internally; we use a simple
    // timer-based approach: after each getVideoStream call, reset the
    // idle timer. The server itself handles client connect/disconnect.
    this.scheduleIdleTeardown();

    return await sdk.mediaManager.createMediaObject(
      Buffer.from(JSON.stringify(rfc)),
      "x-scrypted/x-rfc4571"
    );
  }

  // ─── Connection Lifecycle ─────────────────────────────────────

  private async ensureRfcServer(): Promise<WyzeRfc4571Server> {
    if (this.rfcServer) return this.rfcServer;
    if (this.rfcServerPromise) return this.rfcServerPromise;

    this.rfcServerPromise = this.createRfcServer();
    try {
      this.rfcServer = await this.rfcServerPromise;
      return this.rfcServer;
    } catch (e: any) {
      this.rfcServerPromise = null;
      throw e;
    }
  }

  private async createRfcServer(): Promise<WyzeRfc4571Server> {
    const info = this.provider.getCameraInfo(this.nativeId);
    if (!info) {
      throw new Error(
        `Camera info not available for ${this.nativeId}. Run device discovery first.`
      );
    }

    if (!info.ip || !info.p2pId || !info.enr || !info.mac) {
      throw new Error(
        `Incomplete camera info for ${info.nickname || this.nativeId}. ` +
        `Missing: ${[!info.ip && "IP", !info.p2pId && "UID", !info.enr && "ENR", !info.mac && "MAC"].filter(Boolean).join(", ")}`
      );
    }

    const frameSize = this.getResolutionFrameSize();
    const bitrate = this.getBitrateValue();

    this.console.log(
      `Connecting to ${info.nickname} (${info.ip}) — ` +
      `resolution=${this.storage.getItem("resolution") || "1080p"}, ` +
      `bitrate=${this.storage.getItem("bitrate") || "max"}`
    );

    const { createWyzeRfc4571Server } = await import("@camstack/wyze-bridge");

    const server = await createWyzeRfc4571Server({
      camera: info,
      frameSize,
      bitrate,
      logger: this.console,
    });

    this.console.log(
      `✅ P2P stream ready: tcp://${server.host}:${server.port} (${server.videoType})`
    );

    return server;
  }

  private scheduleIdleTeardown(): void {
    this.clearIdleTimer();
    const timeoutMs = this.provider.getIdleTimeoutMs();
    if (timeoutMs <= 0) return;

    this.idleTimer = setTimeout(async () => {
      this.activeViewers = Math.max(0, this.activeViewers - 1);
      if (this.activeViewers === 0) {
        this.console.log(`Idle timeout (${timeoutMs / 1000}s), tearing down P2P connection...`);
        await this.teardownConnection("idle");
      }
    }, timeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async teardownConnection(reason: string): Promise<void> {
    if (this.rfcServer) {
      this.console.log(`Closing P2P connection (reason: ${reason})`);
      try { await this.rfcServer.close(); } catch {}
      this.rfcServer = null;
      this.rfcServerPromise = null;
    }
    this.clearIdleTimer();
    this.activeViewers = 0;
  }

  async release(): Promise<void> {
    await this.teardownConnection("release");
  }
}
