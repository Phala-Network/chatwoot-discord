// Private RPC service template. Bind only a separately authorized operator client to this
// named entrypoint; disable routes/workers.dev. Never bind it to the public relay ingress.
import { DurableObject } from "cloudflare:workers";
import {
  type AdoptionCut,
  auditPage,
  escalationBaseline,
  importAdoptionPage,
  inventory,
  keyPage,
  type OperatorEnv,
  prepareAdoption,
  type ReceiptPage,
  type ReceiptPosition,
  receiptPage,
  sealAdoptionHistory,
  stageAdoption,
  verifyAdoptionLinks,
} from "chatwoot-discord-relay/operator";

export class RelayAdoptionOperator extends DurableObject<OperatorEnv> {
  inventory(after = 0) {
    return inventory(this.env, after);
  }
  receiptPage(accountId: number, conversationId: number, position?: ReceiptPosition) {
    return receiptPage(this.env, accountId, conversationId, position);
  }
  auditPage(after?: { kind: number; rowid: number }) {
    return auditPage(this.env, after);
  }
  keyPage(after = "") {
    return keyPage(this.env, after);
  }
  escalationBaseline() {
    return escalationBaseline(this.env);
  }
  prepare(cut: AdoptionCut) {
    return prepareAdoption(this.env, cut);
  }
  importPage(page: ReceiptPage) {
    return importAdoptionPage(this.env, page);
  }
  seal(accountId: number, conversationId: number) {
    return sealAdoptionHistory(this.env, accountId, conversationId);
  }
  verify(cut: AdoptionCut) {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS reports (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    return verifyAdoptionLinks(this.env, cut, {
      get: (key) => sql.exec<{ value: string }>("SELECT value FROM reports WHERE key = ?", key).toArray()[0]?.value,
      set: (key, value) => {
        sql.exec("INSERT INTO reports VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
      },
    });
  }
  stage(cut: AdoptionCut) {
    return stageAdoption(this.env, cut);
  }
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
