/**
 * Wyze Camera Spotlight/Floodlight accessory — controls the camera's built-in light.
 * Uses K10646/K10640 (spotlight) and K12060 (floodlight) commands via P2P.
 */

import { OnOff, ScryptedDeviceBase } from "@scrypted/sdk";
import type { WyzeNativeCamera } from "../camera";

export class WyzeFloodlight extends ScryptedDeviceBase implements OnOff {
  constructor(public camera: WyzeNativeCamera, nativeId: string) {
    super(nativeId);
  }

  async turnOn(): Promise<void> {
    this.camera.console.log(`[Floodlight] Turning on`);
    this.on = true;
    try {
      const conn = await this.camera.getConnection();
      await conn.setSpotlight(true);
    } catch (e: any) {
      this.camera.console.error(`[Floodlight] Failed: ${e?.message}`);
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    this.camera.console.log(`[Floodlight] Turning off`);
    this.on = false;
    try {
      const conn = await this.camera.getConnection();
      await conn.setSpotlight(false);
    } catch (e: any) {
      this.camera.console.error(`[Floodlight] Failed: ${e?.message}`);
      throw e;
    }
  }
}
