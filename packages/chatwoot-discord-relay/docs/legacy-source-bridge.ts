// SOURCE-ONLY maintenance bridge: install legacy-relay as the exact deployed 0.27.0 package
// (npm alias), and this reviewed package artifact separately. Keep the original Worker name,
// Hub namespace, HUB binding, secrets, ingress and cron configuration. Review deployment first.
// This preserves the old executor; it does not migrate SQLite or add partition owners.

import {
  legacyAuditPage,
  legacyEscalationBaseline,
  legacyInventory,
  legacyKeyPage,
  legacyReceiptPage,
  type ReceiptPosition,
} from "chatwoot-discord-relay/operator";
import legacyWorker, { Hub as LegacyHub } from "legacy-relay";

export class Hub extends LegacyHub {
  inventory(after = 0) {
    return { ...legacyInventory(this.ctx.storage.sql, after), sourceIdentity: this.ctx.id.toString() };
  }
  receiptPage(accountId: number, conversationId: number, position?: ReceiptPosition) {
    return legacyReceiptPage(this.ctx.storage.sql, this.ctx.id.toString(), accountId, conversationId, position);
  }
  auditPage(after?: { kind: number; rowid: number }) {
    return legacyAuditPage(this.ctx.storage.sql, after);
  }
  escalationBaseline() {
    return legacyEscalationBaseline(this.ctx.storage.sql);
  }
  keyPage(after = "") {
    return legacyKeyPage(this.ctx.storage.sql, after);
  }
}
export default legacyWorker;
