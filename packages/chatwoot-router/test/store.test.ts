import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { QueueStore } from "../../../shared/store.ts";

it("looks up conversation ledger ranges and memo keys through the cache index", async () => {
  await runInDurableObject(env.ROUTER.getByName("ledger-index"), (_instance, state) => {
    const sql = state.storage.sql;
    const store = new QueueStore(sql, () => 100);
    store.set("labels:1:11:1", "first");
    store.set("labels:1:11:1,2", "second");
    store.set("labels:1:11:expired", "expired", 0);
    store.set("labels:1:110:1", "neighbor");
    store.set("labels:2:11:1", "other account");
    store.set("decision:1:11:1", "memo");
    const queried = vi.spyOn(sql, "exec");
    expect(store.list("labels:1:11:", "labels:1:11;")).toEqual(["first", "second"]);
    expect(store.get("decision:1:11:1")).toBe("memo");
    const queries = [...queried.mock.calls];
    queried.mockRestore();
    for (const [query, ...bindings] of queries) {
      const plan = sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings).toArray();
      console.log(plan.map((row) => row.detail).join("\n"));
      expect(plan).toHaveLength(1);
      expect(plan[0]?.detail).toMatch(/^SEARCH cache USING INDEX .*\(key[>=]/);
    }
    sql.exec("DELETE FROM cache");
  });
});
