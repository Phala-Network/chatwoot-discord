// Retained read-only source shell. It never migrates SQLite or starts business work.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import {
  type FrozenSource,
  type LegacyPosition,
  legacyEscalationBaseline,
  legacyScanPage,
  validateFrozenSource,
} from "./legacy.ts";

export class Hub extends DurableObject<Env> {
  private boundary(source: FrozenSource) {
    const deployed = this.env.LEGACY_EXPORT_BOUNDARY;
    if (!deployed) throw new Error("Frozen export boundary is not deployed");
    const expected = validateFrozenSource(deployed);
    if (
      expected.sourceIdentity !== this.ctx.id.toString() ||
      JSON.stringify(expected) !== JSON.stringify(validateFrozenSource(source))
    )
      throw new Error("Frozen source boundary mismatch");
    return expected;
  }
  async scanPage(source: FrozenSource, after?: LegacyPosition) {
    return legacyScanPage(this.ctx.storage.sql, this.boundary(source), after);
  }
  async escalationBaseline(source: FrozenSource) {
    return legacyEscalationBaseline(this.ctx.storage.sql, this.boundary(source));
  }
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }
}
