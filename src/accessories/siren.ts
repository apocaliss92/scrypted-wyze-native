/**
 * Wyze Camera Siren/Alarm accessory — controls the camera's built-in siren + flash.
 * Uses K10630/K10632 commands via P2P.
 */

import { OnOff, ScryptedDeviceBase } from "@scrypted/sdk";
import type { WyzeNativeCamera } from "../camera";

export class WyzeSiren extends ScryptedDeviceBase implements OnOff {
  constructor(public camera: WyzeNativeCamera, nativeId: string) {
    super(nativeId);
  }

  async turnOn(): Promise<void> {
    this.camera.console.log(`[Siren] Triggering alarm`);
    this.on = true;
    try {
      const conn = await this.camera.getConnection();
      await conn.triggerAlarm();
    } catch (e: any) {
      this.camera.console.error(`[Siren] Failed: ${e?.message}`);
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    this.camera.console.log(`[Siren] Stopping alarm`);
    this.on = false;
    try {
      const conn = await this.camera.getConnection();
      await conn.stopAlarm();
    } catch (e: any) {
      this.camera.console.error(`[Siren] Failed: ${e?.message}`);
      throw e;
    }
  }
}
