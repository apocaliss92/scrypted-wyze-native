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
    this.console.log(`[Siren] turnOn() called`);
    this.camera.console.log(`[Siren] turnOn() called`);
    this.on = true;
    try {
      this.console.log(`[Siren] Getting P2P connection...`);
      const conn = await this.camera.getConnection();
      this.console.log(`[Siren] Got connection, sending triggerAlarm()...`);
      await conn.triggerAlarm();
      this.console.log(`[Siren] triggerAlarm() completed`);
    } catch (e: any) {
      this.console.error(`[Siren] turnOn failed: ${e?.message}`);
      this.camera.console.error(`[Siren] turnOn failed: ${e?.message}`);
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    this.console.log(`[Siren] turnOff() called`);
    this.camera.console.log(`[Siren] turnOff() called`);
    this.on = false;
    try {
      this.console.log(`[Siren] Getting P2P connection...`);
      const conn = await this.camera.getConnection();
      this.console.log(`[Siren] Got connection, sending stopAlarm()...`);
      await conn.stopAlarm();
      this.console.log(`[Siren] stopAlarm() completed`);
    } catch (e: any) {
      this.console.error(`[Siren] turnOff failed: ${e?.message}`);
      this.camera.console.error(`[Siren] turnOff failed: ${e?.message}`);
      throw e;
    }
  }
}
