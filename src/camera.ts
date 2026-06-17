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
  FFmpegInput,
  Intercom,
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

interface WyzeBackchannelConn {
  hasTwoWayStreaming: boolean;
  isBackchannelReady: boolean;
  startIntercom(): Promise<void>;
  stopIntercom(): void;
  writeAudio(codec: number, payload: Buffer, timestampUS: number, sampleRate: number, channels: number): void;
  getBackchannelCodec(): { codec: number; sampleRate: number; channels: number };
}

interface WyzeRfc4571Server {
  host: string;
  port: number;
  sdp: string;
  videoType: string;
  connection: any; // WyzeDTLSConn (implements WyzeBackchannelConn)
  close: () => Promise<void>;
  readonly clientCount: number;
  onClientDisconnect: (cb: (remaining: number) => void) => void;
}

export class WyzeNativeCamera
  extends ScryptedDeviceBase
  implements VideoCamera, Camera, MotionSensor, Settings, Online, DeviceProvider, Intercom
{
  provider: WyzeNativeProvider;
  private rfcServer: WyzeRfc4571Server | null = null;
  private rfcServerPromise: Promise<WyzeRfc4571Server> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private eventPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventTs = 0;
  private boaMotionStopper: (() => void) | null = null;
  private intercomFfmpeg: ReturnType<typeof spawn> | null = null;

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
    this.console.log(`[getConnection] Requested, rfcServer=${!!this.rfcServer}`);
    const server = await this.ensureRfcServer();
    this.console.log(`[getConnection] Connection ready`);
    return server.connection;
  }

  // ─── Online ────────────────────────────────────────────────────

  checkOnline(): boolean {
    const info = this.provider.getCameraInfo(this.nativeId);
    return info?.isOnline ?? true;
  }

  // ─── DeviceProvider (sub-devices: siren, floodlight) ───────────

  async getDevice(nativeId: string): Promise<any> {
    this.console.log(`[getDevice] nativeId=${nativeId}`);
    if (nativeId.endsWith(sirenSuffix)) {
      if (!this.siren) this.siren = new WyzeSiren(this, nativeId);
      this.console.log(`[getDevice] Returning siren`);
      return this.siren;
    }
    if (nativeId.endsWith(floodlightSuffix)) {
      if (!this.floodlight) this.floodlight = new WyzeFloodlight(this, nativeId);
      this.console.log(`[getDevice] Returning floodlight`);
      return this.floodlight;
    }
    this.console.log(`[getDevice] No match, returning undefined`);
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

  // ─── Intercom (two-way audio) ─────────────────────────────────
  // EXPERIMENTAL: relies on the hand-rolled backchannel DTLS server in
  // @apocaliss92/wyze-bridge-js. Needs validation on real hardware.

  async startIntercom(media: MediaObject): Promise<void> {
    await this.stopIntercom();

    const server = await this.ensureRfcServer();
    const conn = server.connection as WyzeBackchannelConn;
    if (!conn.hasTwoWayStreaming) {
      this.console.warn("Camera did not advertise two-way audio; attempting intercom anyway.");
    }

    const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(
      media,
      ScryptedMimeTypes.FFmpegInput,
    );

    this.console.log("Intercom: enabling return-audio channel…");
    await conn.startIntercom();

    // Pick a return codec the camera accepts (audioEncoderList = PCMU/PCMA/PCM).
    // Prefer the codec the camera sent us; fall back to PCMU 8 kHz mono.
    const SUPPORTED: Record<number, { fmt: string; acodec: string; bps: number }> = {
      0x89: { fmt: "mulaw", acodec: "pcm_mulaw", bps: 1 }, // PCMU
      0x8a: { fmt: "alaw", acodec: "pcm_alaw", bps: 1 }, // PCMA
      0x8c: { fmt: "s16le", acodec: "pcm_s16le", bps: 2 }, // PCM/L16
    };
    const detected = conn.getBackchannelCodec();
    let codec = detected.codec;
    let sampleRate = detected.sampleRate || 8000;
    let channels = detected.channels || 1;
    if (!SUPPORTED[codec]) {
      codec = 0x89;
      sampleRate = 8000;
      channels = 1;
    }
    const enc = SUPPORTED[codec]!;
    const FRAME_SAMPLES = 160;
    const frameBytes = FRAME_SAMPLES * enc.bps * channels;
    const frameDurationUS = Math.floor((FRAME_SAMPLES * 1_000_000) / sampleRate);
    this.console.log(
      `Intercom: codec=0x${codec.toString(16)} (${enc.fmt}) ${sampleRate}Hz x${channels}, frame=${frameBytes}B`,
    );

    const ff = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        ...ffmpegInput.inputArguments!,
        "-vn", "-sn", "-dn",
        "-acodec", enc.acodec,
        "-ar", String(sampleRate),
        "-ac", String(channels),
        "-f", enc.fmt,
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.intercomFfmpeg = ff;

    let backlog: Buffer = Buffer.alloc(0);
    let ts = 0;
    let framesSent = 0;
    let bytesSent = 0;
    let gotStdout = false;

    // Visibility: if ffmpeg never produces audio, the camera will be silent
    // and there is otherwise no signal. Warn after 3s of no output.
    const noDataTimer = setTimeout(() => {
      if (!gotStdout) {
        this.console.warn(
          "Intercom: ffmpeg produced no audio after 3s — does the source MediaObject have an audio track? (check the [intercom ffmpeg] lines above)",
        );
      }
    }, 3000);

    const statsTimer = setInterval(() => {
      if (framesSent > 0) {
        this.console.log(`Intercom: sent ${framesSent} frames / ${bytesSent}B (lastTs=${ts}us)`);
      }
    }, 2000);

    ff.stdout.on("data", (chunk: Buffer) => {
      if (!gotStdout) {
        gotStdout = true;
        this.console.log(`Intercom: first audio bytes from ffmpeg (${chunk.length}B) — pumping to camera`);
      }
      backlog = Buffer.concat([backlog, chunk]);
      while (backlog.length >= frameBytes) {
        const frame = backlog.subarray(0, frameBytes);
        backlog = backlog.subarray(frameBytes);
        try {
          conn.writeAudio(codec, Buffer.from(frame), ts >>> 0, sampleRate, channels);
          framesSent++;
          bytesSent += frame.length;
        } catch (e) {
          this.console.warn("Intercom writeAudio failed:", (e as Error)?.message);
        }
        ts = (ts + frameDurationUS) >>> 0;
      }
    });
    ff.stderr.on("data", (d: Buffer) => this.console.warn(`[intercom ffmpeg] ${d.toString().trim()}`));
    ff.on("close", (code) => {
      clearTimeout(noDataTimer);
      clearInterval(statsTimer);
      this.console.log(`Intercom ffmpeg exited (${code}) — sent ${framesSent} frames total`);
    });
  }

  async stopIntercom(): Promise<void> {
    if (this.intercomFfmpeg) {
      try { this.intercomFfmpeg.stdin?.end(); } catch {}
      try { this.intercomFfmpeg.kill("SIGKILL"); } catch {}
      this.intercomFfmpeg = null;
    }
    try {
      (this.rfcServer?.connection as WyzeBackchannelConn | undefined)?.stopIntercom();
    } catch (e) {
      this.console.warn("stopIntercom error:", (e as Error)?.message);
    }
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
    const info = this.provider.getCameraInfo(this.nativeId);
    if (!info?.mac) return;
    try {
      const cloud = await this.provider.getCloudClient();
      if (!cloud) return;
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
    // Refresh IPs from Wyze cloud — the API can return stale IPs after DHCP renewals.
    // Debounced to at most once per 5 minutes so retries don't spam the API.
    await this.provider.refreshCameraIps().catch(() => {});

    const info = this.provider.getCameraInfo(this.nativeId);
    if (!info?.ip || !info?.p2pId || !info?.enr || !info?.mac)
      throw new Error(`Incomplete camera info for ${this.nativeId}. Run discovery.`);

    const ipBefore = info.ip;
    this.console.log(`Connecting to ${info.nickname} (${info.ip})...`);
    const { createWyzeRfc4571Server } = await import("@apocaliss92/wyze-bridge-js");
    const server = await createWyzeRfc4571Server({
      camera: info, frameSize: this.getResolutionFrameSize(), bitrate: this.getBitrateValue(), logger: this.console,
    });
    // Persist updated IP if broadcast discovery found the camera at a different address
    if (info.ip !== ipBefore) {
      this.console.log(`Persisting updated IP for ${info.nickname}: ${ipBefore} → ${info.ip}`);
      this.provider.updateCameraIp(this.nativeId, info.ip);
    }
    this.console.log(`✅ P2P: tcp://${server.host}:${server.port} (${server.videoType})`);

    // Start idle timer when last TCP client disconnects
    server.onClientDisconnect((remaining) => {
      if (remaining === 0) {
        this.console.log("Last viewer disconnected, scheduling idle teardown");
        this.scheduleIdleTeardown();
      }
    });

    // If the library tears down the server from the inside (e.g. the P2P
    // health monitor detected a dead stream), clear our reference so the next
    // getVideoStream() call creates a fresh connection instead of reusing a
    // dead server.
    server.onServerClose((reason) => {
      this.console.log(`P2P server closed internally: ${reason} — releasing ref`);
      if (this.rfcServer === server) {
        this.rfcServer = null;
        this.rfcServerPromise = null;
      }
      this.clearIdleTimer();
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
        if (info?.mac) {
          const cloud = await this.provider.getCloudClient();
          if (cloud) diag._recentEvents = await cloud.getEventList({ macs: [info.mac], count: 5 });
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
