// Private RPC service template; disable routes/workers.dev and never log private artifacts.
import { DurableObject } from "cloudflare:workers";
import {
  type AdoptionCut,
  escalationBaseline,
  type FrozenSource,
  importAdoptionPage,
  LegacyArchive,
  type LegacyPosition,
  type OperatorEnv,
  prepareAdoption,
  type ReceiptPage,
  type ReceiptPosition,
  scanPage,
  sealAdoptionHistory,
  stageAdoption,
  verifyAdoptionLinks,
} from "chatwoot-discord-relay/operator";

export class RelayAdoptionOperator extends DurableObject<OperatorEnv> {
  private archive() {
    return new LegacyArchive(this.ctx.storage.sql, (run) => this.ctx.storage.transactionSync(run));
  }
  private reports() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS reports (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    return {
      get: (key: string) =>
        sql.exec<{ value: string }>("SELECT value FROM reports WHERE key=?", key).toArray()[0]?.value,
      set: (key: string, value: string) => {
        sql.exec("INSERT INTO reports VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
      },
    };
  }
  sourceIdentity() {
    return this.env.LEGACY_HUB.idFromName("global").toString();
  }
  open(source: FrozenSource) {
    return this.archive().open(source);
  }
  async collect(source: FrozenSource, after: LegacyPosition) {
    // Persist before returning. Repeating an identical checkpoint after a timeout is safe.
    return this.archive().collect(await scanPage(this.env, source, after));
  }
  baselinePage(after = 0) {
    return this.archive().baselinePage(after);
  }
  disposition(
    source: FrozenSource,
    accountId: number,
    conversationId: number,
    messageId: number,
    digest: string,
    evidenceRef: string,
  ) {
    return this.archive().disposition(source, accountId, conversationId, messageId, digest, evidenceRef);
  }
  auditNext() {
    return this.archive().auditNext();
  }
  inventory(after = 0) {
    return this.archive().inventory(after);
  }
  auditPage(after?: LegacyPosition) {
    return this.archive().auditPage(after);
  }
  receiptPage(accountId: number, conversationId: number, position?: ReceiptPosition) {
    return this.archive().receiptPage(accountId, conversationId, position);
  }
  escalationBaseline(source: FrozenSource) {
    return escalationBaseline(this.env, source);
  }
  prepare(cut: AdoptionCut) {
    this.archive().assertCut(cut);
    return prepareAdoption(this.env, cut);
  }
  importPage(page: ReceiptPage) {
    return importAdoptionPage(this.env, page);
  }
  seal(accountId: number, conversationId: number) {
    return sealAdoptionHistory(this.env, accountId, conversationId);
  }
  verify(cut: AdoptionCut, batch: number) {
    this.archive().assertCut(cut);
    return verifyAdoptionLinks(this.env, cut, this.reports(), batch);
  }
  stage(cut: AdoptionCut) {
    this.archive().assertCut(cut);
    return stageAdoption(this.env, cut, this.reports());
  }
}
export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
