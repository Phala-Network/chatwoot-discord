import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, Store } from "../src/store.ts";

describe("Store", () => {
  it("upgrades a 0.1.0 database without losing its posts", async () => {
    await runInDurableObject(env.HUB.getByName("store-migration"), (_instance, state) => {
      const sql = state.storage.sql;
      // Rebuild the database as version 0.1.0 left it.
      for (const table of [
        "conversations",
        "jobs",
        "deliveries",
        "counters",
        "cache",
        "posted_messages",
        "submitted_responses",
      ]) {
        sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      sql.exec(MIGRATIONS[0] ?? "");
      sql.exec("UPDATE schema_version SET version = 1");
      sql.exec(
        `INSERT INTO conversations (account_id, conversation_id, thread_id, state, cursor) VALUES
           (3, 12, '100000000000000101', 'resolved|Kim Lee|billing', 500),
           (3, 13, '100000000000000102', NULL, NULL)`,
      );
      sql.exec("INSERT INTO deliveries (id, received_at) VALUES ('delivery', 0)");

      const store = new Store(sql);
      store.migrate();
      // Announced assignees were recorded by name, which cannot be turned into an id: cleared.
      expect(store.conversation(3, 12)).toEqual({
        threadId: "100000000000000101",
        state: "resolved|Kim Lee|billing",
        cursor: 500,
        announcedAssignee: undefined,
        titleSubject: undefined,
        title: undefined,
      });
      expect(store.conversation(3, 13)?.announcedAssignee).toBeUndefined();
      const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray();
      expect(tables.map((table) => table.name)).not.toContain("deliveries");

      // Only the given fields change.
      store.updateConversation(3, 13, { state: "s", title: "T" });
      store.updateConversation(3, 13, { title: "T2" });
      expect(store.conversation(3, 13)).toMatchObject({ threadId: "100000000000000102", state: "s", title: "T2" });

      store.savePostedPart(3, 12, 501, 0, "m1");
      store.savePostedPart(3, 12, 501, 1, "m2");
      expect(store.postedParts(3, 12, 501)).toEqual(["m1", "m2"]);
      store.savePostedResponse(3, 12, 502, "digest-1");
      store.savePostedResponse(3, 12, 502, "digest-2");
      expect(store.postedResponse(3, 12, 502)).toBe("digest-2");
      store.forgetThread(3, 12);
      expect(store.postedParts(3, 12, 501)).toEqual([]);
      expect(store.postedResponse(3, 12, 502)).toBeUndefined();
      expect(store.conversation(3, 12)?.cursor).toBe(500);
    });
  });
});
