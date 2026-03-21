/**
 * Scrypted Wyze Native Plugin — Provider.
 *
 * Plugin-level:
 *   - Wyze cloud credentials (email, password, API key/ID)
 *   - Device discovery via cloud API
 *
 * Camera-level:
 *   - Each camera has its own P2P/DTLS connection
 *   - Connection is created on-demand when stream is requested
 *   - Connection is torn down after idle timeout (no viewers)
 */

import sdk, {
  AdoptDevice,
  DeviceCreator,
  DeviceCreatorSettings,
  DeviceDiscovery,
  DeviceProvider,
  DiscoveredDevice,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  Setting,
  Settings,
} from "@scrypted/sdk";
import { WyzeNativeCamera } from "./camera";

const { deviceManager } = sdk;

export default class WyzeNativeProvider
  extends ScryptedDeviceBase
  implements DeviceProvider, DeviceCreator, DeviceDiscovery, Settings
{
  private cameras = new Map<string, WyzeNativeCamera>();

  constructor(nativeId?: string) {
    super(nativeId);
    this.console.log("Wyze Native plugin loaded");

    // Auto-discover on startup (delayed to allow settings to load)
    setTimeout(() => {
      if (this.hasCredentials()) {
        this.discoverDevices(false).catch((e) =>
          this.console.error("Auto-discovery failed:", e?.message)
        );
      }
    }, 5000);
  }

  // ─── Plugin Settings (shared for all cameras from this account) ───

  async getSettings(): Promise<Setting[]> {
    return [
      {
        group: "Wyze Account",
        key: "email",
        title: "Email",
        description: "Your Wyze account email (supports Google login if password is set)",
        value: this.storage.getItem("email") || "",
        type: "string",
      },
      {
        group: "Wyze Account",
        key: "password",
        title: "Password",
        description: "Your Wyze account password",
        value: this.storage.getItem("password") || "",
        type: "password",
      },
      {
        group: "Wyze Developer",
        key: "apiKey",
        title: "API Key",
        description: "From https://support.wyze.com/hc/en-us/articles/16129834216731",
        value: this.storage.getItem("apiKey") || "",
        type: "string",
      },
      {
        group: "Wyze Developer",
        key: "apiId",
        title: "Key ID",
        description: "Key ID associated with the API Key",
        value: this.storage.getItem("apiId") || "",
        type: "string",
      },
      {
        group: "Connection",
        key: "idleTimeoutSec",
        title: "Idle Timeout (seconds)",
        description: "Disconnect P2P after this many seconds with no viewers. 0 = never disconnect.",
        value: this.storage.getItem("idleTimeoutSec") || "30",
        type: "number",
      },
    ];
  }

  async putSetting(key: string, value: string): Promise<void> {
    this.storage.setItem(key, value);
    if (["email", "password", "apiKey", "apiId"].includes(key)) {
      this.console.log(`Credentials updated, re-discovering...`);
      await this.discoverDevices(false).catch((e) => this.console.error("Discovery failed:", e?.message));
    }
  }

  private hasCredentials(): boolean {
    return !!(this.storage.getItem("email") && this.storage.getItem("password") &&
      this.storage.getItem("apiKey") && this.storage.getItem("apiId"));
  }

  getIdleTimeoutMs(): number {
    const sec = parseInt(this.storage.getItem("idleTimeoutSec") || "30");
    return (sec > 0 ? sec : 0) * 1000;
  }

  getCloudCredentials() {
    return {
      apiKey: this.storage.getItem("apiKey") || "",
      apiId: this.storage.getItem("apiId") || "",
      email: this.storage.getItem("email") || "",
      password: this.storage.getItem("password") || "",
    };
  }

  // ─── Device Discovery ──────────────────────────────────────────

  async discoverDevices(_scan?: boolean): Promise<DiscoveredDevice[]> {
    if (!this.hasCredentials()) {
      this.console.warn("Missing Wyze credentials. Configure in plugin settings.");
      return [];
    }

    this.console.log("Discovering Wyze cameras...");
    const creds = this.getCloudCredentials();

    try {
      const { WyzeCloud } = await import("@apocaliss92/wyze-bridge-js");
      const cloud = new WyzeCloud(creds.apiKey, creds.apiId);
      await cloud.login(creds.email, creds.password);
      const cameraList = await cloud.getCameraList();

      const devices: DiscoveredDevice[] = [];
      for (const cam of cameraList) {
        const nativeId = cam.mac;

        devices.push({
          nativeId,
          name: cam.nickname,
          description: `${cam.productModel} (${cam.ip})`,
          type: ScryptedDeviceType.Camera,
          interfaces: [
            ScryptedInterface.VideoCamera,
            ScryptedInterface.Settings,
            ScryptedInterface.Online,
          ],
          info: {
            model: cam.productModel,
            mac: cam.mac,
            ip: cam.ip,
            firmware: cam.firmwareVer,
            manufacturer: "Wyze",
          },
        });

        // Persist the full camera info (P2P params needed for connection)
        this.storage.setItem(`cam:${nativeId}`, JSON.stringify(cam));
      }

      await deviceManager.onDevicesChanged({
        providerNativeId: this.nativeId,
        devices: devices as any,
      });

      this.console.log(`Found ${devices.length} camera(s): ${cameraList.map(c => c.nickname).join(", ")}`);
      return devices;
    } catch (e: any) {
      this.console.error("Discovery failed:", e?.message);
      throw e;
    }
  }

  async adoptDevice(device: AdoptDevice): Promise<string> {
    return device.nativeId;
  }

  // ─── Device Creator (manual add) ──────────────────────────────

  async getCreateDeviceSettings(): Promise<Setting[]> {
    return [
      { key: "name", title: "Camera Name", type: "string" },
      { key: "ip", title: "Camera IP", description: "Local IP address", type: "string" },
      { key: "uid", title: "P2P UID", description: "From cloud discovery (e.g. 3Y5N8X...)", type: "string" },
      { key: "enr", title: "ENR Key", description: "Encryption key from cloud", type: "string" },
      { key: "mac", title: "MAC Address", type: "string" },
      { key: "model", title: "Product Model", type: "string" },
    ];
  }

  async createDevice(settings: DeviceCreatorSettings): Promise<string> {
    const ip = settings.ip?.toString();
    const uid = settings.uid?.toString();
    const enr = settings.enr?.toString();
    const mac = settings.mac?.toString();
    if (!ip || !uid || !enr || !mac) throw new Error("IP, UID, ENR, and MAC are required");

    const name = settings.name?.toString() || `Wyze Camera (${ip})`;
    const nativeId = mac;

    // Store camera info
    const camInfo = {
      ip, p2pId: uid, enr, mac,
      productModel: settings.model?.toString() || "Unknown",
      nickname: name, dtls: 1, isOnline: true,
      firmwareVer: "", productType: "Camera",
    };
    this.storage.setItem(`cam:${nativeId}`, JSON.stringify(camInfo));

    await deviceManager.onDevicesChanged({
      providerNativeId: this.nativeId,
      devices: [{
        nativeId,
        name,
        type: ScryptedDeviceType.Camera,
        interfaces: [ScryptedInterface.VideoCamera, ScryptedInterface.Settings, ScryptedInterface.Online],
      } as any],
    });
    return nativeId;
  }

  // ─── Device Provider ───────────────────────────────────────────

  async getDevice(nativeId: string): Promise<WyzeNativeCamera> {
    let camera = this.cameras.get(nativeId);
    if (!camera) {
      camera = new WyzeNativeCamera(nativeId);
      camera.provider = this;
      this.cameras.set(nativeId, camera);
    }
    return camera;
  }

  async releaseDevice(_id: string, nativeId: string): Promise<void> {
    const cam = this.cameras.get(nativeId);
    if (cam) {
      await cam.release();
      this.cameras.delete(nativeId);
    }
  }

  /** Get stored camera info for a given nativeId */
  getCameraInfo(nativeId: string): any {
    try {
      const raw = this.storage.getItem(`cam:${nativeId}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
}
