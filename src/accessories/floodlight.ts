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
    this.console.log(`[Floodlight] turnOn() called`);
    this.camera.console.log(`[Floodlight] turnOn() called`);
    this.on = true;
    try {
      this.console.log(`[Floodlight] Getting P2P connection...`);
      const conn = await this.camera.getConnection();
      this.console.log(`[Floodlight] Got connection, sending setSpotlight(true)...`);
      await conn.setSpotlight(true);
      this.console.log(`[Floodlight] setSpotlight(true) completed`);
    } catch (e: any) {
      this.console.error(`[Floodlight] turnOn failed: ${e?.message}`);
      this.camera.console.error(`[Floodlight] turnOn failed: ${e?.message}`);
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    this.console.log(`[Floodlight] turnOff() called`);
    this.camera.console.log(`[Floodlight] turnOff() called`);
    this.on = false;
    try {
      this.console.log(`[Floodlight] Getting P2P connection...`);
      const conn = await this.camera.getConnection();
      this.console.log(`[Floodlight] Got connection, sending setSpotlight(false)...`);
      await conn.setSpotlight(false);
      this.console.log(`[Floodlight] setSpotlight(false) completed`);
    } catch (e: any) {
      this.console.error(`[Floodlight] turnOff failed: ${e?.message}`);
      this.camera.console.error(`[Floodlight] turnOff failed: ${e?.message}`);
      throw e;
    }
  }
}
