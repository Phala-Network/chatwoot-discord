// Retained only during the evidence/rollback window. It cannot start business work.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { legacyInventory } from "./legacy.ts";

export class Hub extends DurableObject<Env> {
  inventory(after = 0) {
    return legacyInventory(this.ctx.storage.sql, after);
  }
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }
}
