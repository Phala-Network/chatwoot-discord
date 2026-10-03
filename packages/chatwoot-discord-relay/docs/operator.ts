// Private RPC service template. Bind only a separately authorized operator client to this
// named entrypoint; disable routes/workers.dev. Never bind it to the public relay ingress.
import { DurableObject } from "cloudflare:workers";
import {
  type AdoptionCut,
  inventory,
  type OperatorEnv,
  stageAdoption,
  verifyAdoptionLinks,
} from "chatwoot-discord-relay/operator";

export class RelayAdoptionOperator extends DurableObject<OperatorEnv> {
  inventory(after = 0) {
    return inventory(this.env, after);
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
