/**
 * Wyze Camera device — per-camera P2P connection + RFC 4571 streaming.
 *
 * Implements:
 *   - VideoCamera — live H264 stream via RFC 4571
 *   - Camera — takePicture (snapshot from live stream via ffmpeg)
 *   - MotionSensor — boa local or cloud polling (selectable)
 *   - Settings — camera controls + motion method + accessories
 *   - Online — connection status
 *   - DeviceProvider — sub-devices for siren/floodlight
 */

import sdk, {
  Camera,
  Device,
  DeviceProvider,
  MediaObject,
  MotionSensor,
  Online,
  RequestMediaStreamOptions,
  RequestPictureOptions,
  ResponseMediaStreamOptions,
  ResponsePictureOptions,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  ScryptedMimeTypes,
  Setting,
  Settings,
  VideoCamera,
} from "@scrypted/sdk";
import { spawn } from "child_process";
import type WyzeNativeProvider from "./main";
import { WyzeSiren, WyzeFloodlight, sirenSuffix, floodlightSuffix } from "./accessories";

interface WyzeRfc4571Server {
  host: string;
  port: number;
  sdp: string;
  videoType: string;
  connection: any; // WyzeDTLSConn
  close: () => Promise<void>;
  readonly clientCount: number;
  onClientDisconnect: (cb: (remaining: number) => void) => void;
}

export class WyzeNativeCamera
  extends ScryptedDeviceBase
  implements VideoCamera, Camera, MotionSensor, Settings, Online, DeviceProvider
{
  provider: WyzeNativeProvider;
  private rfcServer: WyzeRfc4571Server | null = null;
  private rfcServerPromise: Promise<WyzeRfc4571Server> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private eventPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventTs = 0;
  private boaMotionStopper: (() => void) | null = null;

  // Sub-devices
  private siren?: WyzeSiren;
  private floodlight?: WyzeFloodlight;

  constructor(nativeId: string, provider?: WyzeNativeProvider) {
    super(nativeId);
    if (provider) this.provider = provider;
    this.startEventPolling();
  }

  // ─── Public: expose P2P connection for accessories ─────────────

  async getConnection(): Promise<any> {
    const server = await this.ensureRfcServer();
    return server.connection;
  }

  // ─── Online ────────────────────────────────────────────────────

  checkOnline(): boolean {
    const info = this.provider.getCameraInfo(this.nativeId);
    return info?.isOnline ?? true;
  }

  // ─── DeviceProvider (sub-devices: siren, floodlight) ───────────

  async getDevice(nativeId: string): Promise<any> {
    if (nativeId.endsWith(sirenSuffix)) {
      if (!this.siren) this.siren = new WyzeSiren(this, nativeId);
      return this.siren;
    }
    if (nativeId.endsWith(floodlightSuffix)) {
      if (!this.floodlight) this.floodlight = new WyzeFloodlight(this, nativeId);
      return this.floodlight;
    }
    return undefined;
  }

  async releaseDevice(id: string, nativeId: string): Promise<void> {}

  /**
   * Probe camera capabilities and create sub-devices for siren/floodlight.
   * Called after first connection.
   */
  async discoverAccessories(): Promise<void> {
    if (!this.rfcServer?.connection) return;
    const conn = this.rfcServer.connection;

    try {
      this.console.log("Probing camera capabilities...");
      const caps = await conn.probeCapabilities();
      this.console.log(`Capabilities: ${JSON.stringify(caps)}`);

      const sirenNativeId = `${this.nativeId}${sirenSuffix}`;
      const floodlightNativeId = `${this.nativeId}${floodlightSuffix}`;

      if (caps.hasSiren) {
        const device: Device = {
          providerNativeId: this.nativeId,
          name: `${this.name} Siren`,
          nativeId: sirenNativeId,
          interfaces: [ScryptedInterface.OnOff],
          type: ScryptedDeviceType.Siren,
        };
        await sdk.deviceManager.onDeviceDiscovered(device);
        this.console.log(`✅ Siren accessory created`);
      }

      if (caps.hasSpotlight || caps.hasFloodlight) {
        const device: Device = {
          providerNativeId: this.nativeId,
          name: `${this.name} Floodlight`,
          nativeId: floodlightNativeId,
          interfaces: [ScryptedInterface.OnOff],
          type: ScryptedDeviceType.Light,
        };
        await sdk.deviceManager.onDeviceDiscovered(device);
        this.console.log(`✅ Floodlight accessory created`);
      }
    } catch (e: any) {
      this.console.error(`Capability probe failed: ${e?.message}`);
    }
  }

  // ─── Settings ──────────────────────────────────────────────────

  async getSettings(): Promise<Setting[]> {
    const info = this.provider.getCameraInfo(this.nativeId);
    const connected = !!this.rfcServer;

    return [
      {
        group: "Camera Info",
        key: "ip", title: "IP Address",
        value: info?.ip || "", readonly: !!info?.ip, type: "string",
      },
      {
        group: "Camera Info",
        key: "model", title: "Model",
        value: info?.productModel || "", readonly: true, type: "string",
      },
      {
        group: "Camera Info",
        key: "firmware", title: "Firmware",
        value: info?.firmwareVer || "", readonly: true, type: "string",
      },
      {
        group: "Stream",
        key: "resolution", title: "Resolution",
        value: this.storage.getItem("resolution") || "1080p",
        choices: ["1080p", "720p", "360p", "2K"], type: "string",
      },
      {
        group: "Stream",
        key: "bitrate", title: "Bitrate",
        value: this.storage.getItem("bitrate") || "max",
        choices: ["max", "sd"], type: "string",
      },
      {
        group: "Motion Detection",
        key: "motionMethod", title: "Motion Detection Method",
        description: "How to detect motion. 'boa' polls the SD card locally (fastest, needs SD). " +
          "'cloud' polls Wyze cloud API (needs internet). 'auto' tries boa first, falls back to cloud.",
        value: this.storage.getItem("motionMethod") || "auto",
        choices: ["auto", "boa", "cloud", "disabled"], type: "string",
      },
      {
        group: "Motion Detection",
        key: "eventPollInterval", title: "Poll Interval (seconds)",
        description: "Interval for motion polling (boa or cloud). 0 = default (3s boa, 30s cloud).",
        value: this.storage.getItem("eventPollInterval") || "0",
        type: "number",
      },
      {
        group: "Camera Controls",
        key: "nightVision", title: "Night Vision",
        value: this.storage.getItem("nightVision") || "auto",
        choices: ["on", "off", "auto"], type: "string",
      },
      {
        group: "Camera Controls",
        key: "statusLight", title: "Status Light",
        value: this.storage.getItem("statusLight") || "on",
        choices: ["on", "off"], type: "string",
      },
      {
        group: "Camera Controls",
        key: "motionDetection", title: "Motion Detection (on camera)",
        value: this.storage.getItem("motionDetection") || "on",
        choices: ["on", "off"], type: "string",
      },
      {
        group: "Status",
        key: "status", title: "Connection Status",
        value: connected ? "🟢 Connected (P2P/DTLS)" : "⚪ Disconnected",
        readonly: true, type: "string",
      },
      {
        group: "Diagnostics",
        key: "runDiagnostics", title: "Run Diagnostics",
        description: "Query all camera parameters and log JSON report.",
        type: "button",
      },
      {
        group: "Diagnostics",
        key: "discoverAccessories", title: "Discover Accessories",
        description: "Probe camera for siren/floodlight and create sub-devices.",
        type: "button",
      },
    ];
  }

  async putSetting(key: string, value: string): Promise<void> {
    this.storage.setItem(key, value);

    if (key === "runDiagnostics") { await this.doDiagnostics(); return; }
    if (key === "discoverAccessories") { await this.discoverAccessories(); return; }

    if (key === "resolution" || key === "bitrate") {
      this.console.log(`${key} changed to ${value}, restarting stream...`);
      await this.teardownConnection("settings changed");
    }

    if (key === "motionMethod" || key === "eventPollInterval") {
      this.startEventPolling();
    }

    // Send camera commands if connected
    if (this.rfcServer?.connection) {
      const conn = this.rfcServer.connection;
      try {
        switch (key) {
          case "nightVision":
            await conn.setNightVision(value === "on" ? 1 : value === "off" ? 2 : 3);
            this.console.log(`Night vision → ${value}`); break;
          case "statusLight":
            await conn.setStatusLight(value === "on");
            this.console.log(`Status light → ${value}`); break;
          case "motionDetection":
            await conn.setMotionAlarm(value === "on");
            this.console.log(`Motion detection → ${value}`); break;
        }
      } catch (e: any) { this.console.error(`Set ${key} failed: ${e?.message}`); }
    }
  }

  private getResolutionFrameSize(): number {
    const r = this.storage.getItem("resolution") || "1080p";
    return r === "360p" ? 1 : r === "720p" ? 2 : r === "2K" ? 3 : 0;
  }
  private getBitrateValue(): number {
    return (this.storage.getItem("bitrate") || "max") === "sd" ? 0x3C : 0xF0;
  }

  // ─── VideoCamera ───────────────────────────────────────────────

  async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
    return [{ id: "native-main", name: "Native P2P", container: "rtp", video: { codec: "h264" }, audio: null }];
  }

  async getVideoStream(_options?: RequestMediaStreamOptions): Promise<MediaObject> {
    const server = await this.ensureRfcServer();
    this.clearIdleTimer();
    // SDP from the RFC4571 server already includes audio track if detected
    const rfc = {
      url: new URL(`tcp://${server.host}:${server.port}`),
      sdp: server.sdp,
      mediaStreamOptions: { id: "native-main", name: "Native P2P", container: "rtp", video: { codec: server.videoType.toLowerCase() }, audio: null },
    };
    return await sdk.mediaManager.createMediaObject(Buffer.from(JSON.stringify(rfc)), "x-scrypted/x-rfc4571");
  }

  // ─── Camera (snapshot) ────────────────────────────────────────

  async takePicture(_options?: RequestPictureOptions): Promise<MediaObject> {
    const server = await this.ensureRfcServer();
    this.console.log("Taking snapshot...");
    const keyframeData = await server.connection.grabKeyframe(8000);
    const jpeg = await new Promise<Buffer>((resolve, reject) => {
      const ff = spawn("ffmpeg", ["-f", "h264", "-i", "pipe:0", "-frames:v", "1", "-q:v", "2", "-f", "image2", "pipe:1"],
        { stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      ff.stdout.on("data", (d: Buffer) => chunks.push(d));
      ff.on("close", (code) => code === 0 && chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`)));
      ff.on("error", reject);
      ff.stdin.write(keyframeData);
      ff.stdin.end();
    });
    return await sdk.mediaManager.createMediaObject(jpeg, "image/jpeg");
  }

  async getPictureOptions(): Promise<ResponsePictureOptions[]> { return []; }

  // ─── MotionSensor (selectable method) ─────────────────────────

  private startEventPolling(): void {
    // Stop existing
    if (this.eventPollTimer) { clearInterval(this.eventPollTimer); this.eventPollTimer = null; }
    if (this.boaMotionStopper) { this.boaMotionStopper(); this.boaMotionStopper = null; }

    const method = this.storage.getItem("motionMethod") || "auto";
    if (method === "disabled") return;

    const customInterval = parseInt(this.storage.getItem("eventPollInterval") || "0");

    if (method === "boa") {
      this.startBoaPolling(customInterval || 3000);
    } else if (method === "cloud") {
      this.startCloudPolling(customInterval || 30);
    } else {
      // auto: try boa, fallback to cloud
      this.startAutoPolling(customInterval);
    }
  }

  private async startAutoPolling(customInterval: number): Promise<void> {
    // Delay to wait for P2P connection
    setTimeout(async () => {
      if (this.rfcServer?.connection) {
        try {
          const result = await this.rfcServer.connection.startBoaMotionPolling(customInterval || 3000);
          if (result) {
            this.boaMotionStopper = result.stop;
            this.console.log("✅ Motion: boa local (SD card)");
            this.rfcServer.connection.on("motion", (ev: any) => {
              this.motionDetected = true;
              this.console.log(`🔔 Motion (local): ${ev.fileName}`);
              setTimeout(() => { this.motionDetected = false; }, 30000);
            });
            return;
          }
        } catch {}
      }
      this.console.log("Motion: falling back to cloud polling");
      this.startCloudPolling(customInterval || 30);
    }, 10000);
  }

  private startBoaPolling(intervalMs: number): void {
    setTimeout(async () => {
      if (!this.rfcServer?.connection) { this.console.warn("No P2P for boa"); return; }
      try {
        const result = await this.rfcServer.connection.startBoaMotionPolling(intervalMs);
        if (result) {
          this.boaMotionStopper = result.stop;
          this.console.log(`✅ Motion: boa local (${intervalMs}ms)`);
          this.rfcServer.connection.on("motion", (ev: any) => {
            this.motionDetected = true;
            this.console.log(`🔔 Motion (local): ${ev.fileName}`);
            setTimeout(() => { this.motionDetected = false; }, 30000);
          });
        } else {
          this.console.error("Boa not available (no SD card?)");
        }
      } catch (e: any) { this.console.error(`Boa failed: ${e?.message}`); }
    }, 10000);
  }

  private startCloudPolling(intervalSec: number): void {
    this.console.log(`Motion: cloud polling (${intervalSec}s)`);
    this.eventPollTimer = setInterval(() => this.pollCloudEvents().catch(() => {}), intervalSec * 1000);
    setTimeout(() => this.pollCloudEvents().catch(() => {}), 5000);
  }

  private async pollCloudEvents(): Promise<void> {
    const creds = this.provider.getCloudCredentials();
    if (!creds.apiKey || !creds.email) return;
    const info = this.provider.getCameraInfo(this.nativeId);
    if (!info?.mac) return;
    try {
      const { WyzeCloud } = await import("@apocaliss92/wyze-bridge-js");
      const cloud = new WyzeCloud(creds.apiKey, creds.apiId);
      await cloud.login(creds.email, creds.password);
      const events = await cloud.getEventList({ macs: [info.mac], beginTime: this.lastEventTs ? (this.lastEventTs + 1) : Date.now() - 60000, count: 5 });
      for (const ev of events) {
        if (ev.timestamp > this.lastEventTs) {
          this.lastEventTs = ev.timestamp;
          if (ev.alarmType === "motion") {
            this.motionDetected = true;
            this.console.log(`🔔 Motion (cloud) ${new Date(ev.timestamp).toISOString()}${ev.aiTags.length ? ` [${ev.aiTags.join(",")}]` : ""}`);
            setTimeout(() => { this.motionDetected = false; }, 30000);
          }
        }
      }
    } catch {}
  }

  // ─── Connection Lifecycle ─────────────────────────────────────

  private async ensureRfcServer(): Promise<WyzeRfc4571Server> {
    if (this.rfcServer) return this.rfcServer;
    if (this.rfcServerPromise) return this.rfcServerPromise;
    this.rfcServerPromise = this.createRfcServer();
    try { this.rfcServer = await this.rfcServerPromise; return this.rfcServer; }
    catch (e) { this.rfcServerPromise = null; throw e; }
  }

  private async createRfcServer(): Promise<WyzeRfc4571Server> {
    const info = this.provider.getCameraInfo(this.nativeId);
    if (!info?.ip || !info?.p2pId || !info?.enr || !info?.mac)
      throw new Error(`Incomplete camera info for ${this.nativeId}. Run discovery.`);

    this.console.log(`Connecting to ${info.nickname} (${info.ip})...`);
    const { createWyzeRfc4571Server } = await import("@apocaliss92/wyze-bridge-js");
    const server = await createWyzeRfc4571Server({
      camera: info, frameSize: this.getResolutionFrameSize(), bitrate: this.getBitrateValue(), logger: this.console,
    });
    this.console.log(`✅ P2P: tcp://${server.host}:${server.port} (${server.videoType})`);

    // Start idle timer when last TCP client disconnects
    server.onClientDisconnect((remaining) => {
      if (remaining === 0) {
        this.console.log("Last viewer disconnected, scheduling idle teardown");
        this.scheduleIdleTeardown();
      }
    });

    // Auto-discover accessories after first connection
    setTimeout(() => this.discoverAccessories().catch(() => {}), 3000);

    return server;
  }

  private scheduleIdleTeardown(): void {
    this.clearIdleTimer();
    const ms = this.provider.getIdleTimeoutMs();
    if (ms <= 0) return;
    // Only tear down if no TCP clients are connected
    this.idleTimer = setTimeout(async () => {
      if (this.rfcServer && this.rfcServer.clientCount > 0) {
        // Clients still connected — reschedule
        this.scheduleIdleTeardown();
        return;
      }
      await this.teardownConnection("idle");
    }, ms);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private async teardownConnection(reason: string): Promise<void> {
    if (this.rfcServer) {
      this.console.log(`Closing P2P (${reason})`);
      try { await this.rfcServer.close(); } catch {}
      this.rfcServer = null; this.rfcServerPromise = null;
    }
    this.clearIdleTimer();
  }

  // ─── Diagnostics ──────────────────────────────────────────────

  private async doDiagnostics(): Promise<void> {
    this.console.log("🔍 Running diagnostics...");
    try {
      const server = await this.ensureRfcServer();
      const diag = await server.connection.runDiagnostics();
      const info = this.provider.getCameraInfo(this.nativeId);
      if (info) diag._cloudInfo = { nickname: info.nickname, productModel: info.productModel, mac: info.mac, ip: info.ip, firmwareVer: info.firmwareVer };
      try {
        const creds = this.provider.getCloudCredentials();
        if (creds.apiKey && info?.mac) {
          const { WyzeCloud } = await import("@apocaliss92/wyze-bridge-js");
          const cloud = new WyzeCloud(creds.apiKey, creds.apiId);
          await cloud.login(creds.email, creds.password);
          diag._recentEvents = await cloud.getEventList({ macs: [info.mac], count: 5 });
        }
      } catch {}
      this.console.log("📋 Diagnostics:\n" + JSON.stringify(diag, null, 2));
    } catch (e: any) { this.console.error(`Diagnostics failed: ${e?.message}`); }
  }

  async release(): Promise<void> {
    if (this.eventPollTimer) { clearInterval(this.eventPollTimer); this.eventPollTimer = null; }
    if (this.boaMotionStopper) { this.boaMotionStopper(); this.boaMotionStopper = null; }
    await this.teardownConnection("release");
  }
}
