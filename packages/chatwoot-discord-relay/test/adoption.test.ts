import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ComponentType, MessageFlags } from "discord-api-types/v10";
import { afterEach, expect, it, vi } from "vitest";
import { Budget } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { type AdoptionCut, cleanLegacyCards, stageAdoption, validateCut, verifyLinks } from "../src/adoption.ts";
import { ticketCard } from "../src/commands/components.ts";
import { configSchema } from "../src/config.ts";
import { Conversation } from "../src/conversation.ts";
import { QueueDigest } from "../src/digest.ts";
import { DiscordForum } from "../src/discord/forum.ts";
import { DiscordRest } from "../src/discord/rest.ts";
import { legacyInventory } from "../src/legacy.ts";
import { inventory } from "../src/operator.ts";
import { Store } from "../src/store.ts";
import legacySchema from "./fixtures/legacy-027.ts";
import { FORUM, json, mockFetch, on } from "./helpers.ts";

const GUILD = "100000000000000044";
const THREAD = "100000000000040001";
const cut = (): AdoptionCut => ({
  epoch: "test-cut",
  sourceIdentity: "legacy-test-namespace",
  schemaVersion: 9,
  watermark: 101,
  interactionFence: "100000000000000999",
  quiesced: true,
  sourcesPaused: true,
  inventoryComplete: true,
  drainEvidence: "fixture:all-requests-settled",
  activeCalls: 0,
  jobs: 0,
  held: 0,
  partial: 0,
  unresolved: 0,
  routingGuardsDisposition: "never-used",
  cooldownEndsAt: 0,
  historyPermissionVerified: true,
  escalationBaseline: "{}",
  mappings: [
    {
      accountId: 3,
      conversationId: 12,
      threadId: THREAD,
      guildId: GUILD,
      forumId: FORUM,
      generation: 1,
      cursor: 101,
      latestEligibleId: 101,
      responses: [],
    },
  ],
});
afterEach(() => vi.restoreAllMocks());

it("retries interrupted staging with its complete response baseline instead of an empty idempotent receipt", async () => {
  await runInDurableObject(env.CONVERSATION.getByName(`stage-fault:${crypto.randomUUID()}`), (_instance, state) => {
    const owner = { accountId: 3, conversationId: 12, guildId: GUILD, forumId: FORUM, generation: 2 };
    const responses = [{ messageId: 99, digest: "a".repeat(64) }];
    const executor = new Conversation(state, env);
    // Fail after the stage marker's write, at the next meaningful durable baseline write.
    state.storage.sql.exec(
      "CREATE TRIGGER interrupted_stage BEFORE INSERT ON submitted_responses BEGIN SELECT RAISE(ABORT, 'interrupted baseline'); END",
    );
    expect(() => executor.stage(owner, THREAD, "fault-cut", 101, responses)).toThrow();
    state.storage.sql.exec("DROP TRIGGER interrupted_stage");
    new Conversation(state, env).stage(owner, THREAD, "fault-cut", 101, responses);
    new Conversation(state, env).stage(
      { generation: 2, forumId: FORUM, guildId: GUILD, conversationId: 12, accountId: 3 },
      THREAD,
      "fault-cut",
      101,
      responses.map(({ digest, messageId }) => ({ digest, messageId })),
    );
    expect(new Store(state.storage.sql).postedResponse(3, 12, 99)).toBe(responses[0]?.digest);
  });
});

it("never recreates an accepted thread when its local receipt and mapping transaction fails", async () => {
  let posts = 0;
  mockFetch(
    on("POST", "discord.com/api/v10/webhooks/1/tok", () => {
      posts++;
      return json({ id: "100000000000070000", channel_id: "100000000000070001" });
    }),
  );
  await runInDurableObject(env.CONVERSATION.getByName(`receipt:${crypto.randomUUID()}`), async (_instance, state) => {
    const store = new Store(state.storage.sql, Date.now, (write) => state.storage.transactionSync(write));
    const rest = new DiscordRest("test", (request) => fetch(request));
    const access = {
      lookup: async () => ({ id: "1", token: "tok", guildId: GUILD, version: 1 }),
      invalidate: async () => {},
    };
    let forum = new DiscordForum(rest, store, access);
    const result = await forum.execute(
      FORUM,
      { content: "Header", thread_name: "Ticket" },
      undefined,
      "post:receipt",
      (receipt) => {
        store.adoptThread(3, 12, receipt.channelId);
        throw new Error("local commit interrupted");
      },
    );
    expect(result.state).toBe("unknown");
    expect(store.conversation(3, 12)?.threadId).toBeUndefined();
    forum = new DiscordForum(rest, new Store(state.storage.sql), access);
    expect(
      (await forum.execute(FORUM, { content: "Header", thread_name: "Ticket" }, undefined, "post:receipt")).state,
    ).toBe("unknown");
  });
  expect(posts).toBe(1);
});

it("inventories the actual 0.27 schema, silent posts, orphan partial work and numeric interaction fence", async () => {
  await runInDurableObject(env.THREAD_DIRECTORY.getByName(`inventory:${crypto.randomUUID()}`), (_instance, state) => {
    state.storage.sql.exec(legacySchema);
    for (let id = 1; id <= 101; id++)
      state.storage.sql.exec(
        "INSERT INTO conversations (account_id,conversation_id,thread_id,cursor) VALUES (3,?,?,100)",
        id,
        String(100000000000040000n + BigInt(id)),
      );
    state.storage.sql.exec("INSERT INTO interactions VALUES ('99',0), ('100',0)");
    state.storage.sql.exec("INSERT INTO posted_messages VALUES (3,999,101,0,'100000000000000101')");
    const page = legacyInventory(state.storage.sql);
    expect(page.mappings).toHaveLength(100);
    expect(page.complete).toBe(false);
    expect(page.interactionFence).toBe("100");
    expect(page.partial).toBe(1);
    const end = legacyInventory(state.storage.sql, page.next);
    expect(end.mappings.map((mapping) => mapping.conversationId)).toEqual([101]);
    expect(end.complete).toBe(true);
  });
});

it("prebuilds a silent thread directory and resumes the same cut after a lost staging receipt", async () => {
  const manifest = cut();
  manifest.epoch = crypto.randomUUID();
  manifest.mappings[0] = {
    ...manifest.mappings[0],
    accountId: 3,
    conversationId: 123456,
    threadId: "100000000000045678",
    guildId: GUILD,
    forumId: FORUM,
    generation: 1,
    cursor: 101,
    latestEligibleId: 101,
    responses: [],
  };
  const settings = {
    ...configSchema.parse(env.CONFIG),
    relay: { ...configSchema.parse(env.CONFIG).relay, startAfterMessageId: 101 },
    cutover: {
      phase: "maintenance" as const,
      epoch: manifest.epoch,
      interactionFence: manifest.interactionFence,
      notificationsAfter: Date.now() + 3600000,
      legacyWebhooks: { [FORUM]: ["100000000000000001"] },
    },
  };
  const namespace = new Proxy(env.CONVERSATION, {
    get(target, property, receiver) {
      if (property === "getByName")
        return (name: string) =>
          new Proxy(target.getByName(name), {
            get(stub, key, stubReceiver) {
              if (key === "stage")
                return async (...args: Parameters<Conversation["stage"]>) => {
                  await stub.stage(...args);
                  throw new Error("lost staging receipt");
                };
              return Reflect.get(stub, key, stubReceiver);
            },
          });
      return Reflect.get(target, property, receiver);
    },
  });
  await expect(stageAdoption({ ...env, CONFIG: settings, CONVERSATION: namespace }, manifest)).rejects.toThrow();
  await stageAdoption({ ...env, CONFIG: settings }, manifest);
  const owner = await env.THREAD_DIRECTORY.getByName(`thread:v1:${manifest.mappings[0]?.threadId}`).get();
  expect(owner?.conversationId).toBe(123456);
  expect(owner?.generation).toBe(1);
  await expect(
    stageAdoption({ ...env, CONFIG: { ...settings, cutover: { ...settings.cutover, phase: "active" } } }, manifest),
  ).rejects.toThrow();
});

it.each(["missing-webhooks", "empty-webhooks", "wrong-forum", "unknown-account"])(
  "rejects the entire %s cut before staging any earlier valid mapping",
  async (defect) => {
    const manifest = cut();
    manifest.epoch = crypto.randomUUID();
    manifest.mappings = [
      {
        ...manifest.mappings[0],
        accountId: 3,
        conversationId: 98701,
        threadId: "100000000000098701",
        guildId: GUILD,
        forumId: FORUM,
        generation: 1,
        cursor: 101,
        latestEligibleId: 101,
        responses: [],
      },
      {
        ...manifest.mappings[0],
        accountId: defect === "unknown-account" ? 99 : 1,
        conversationId: 98702,
        threadId: "100000000000098702",
        guildId: GUILD,
        forumId: defect === "wrong-forum" ? "100000000000098703" : FORUM,
        generation: 1,
        cursor: 101,
        latestEligibleId: 101,
        responses: [],
      },
    ];
    const settings = {
      ...configSchema.parse(env.CONFIG),
      relay: { ...configSchema.parse(env.CONFIG).relay, startAfterMessageId: 101 },
      cutover: {
        phase: "maintenance" as const,
        epoch: manifest.epoch,
        interactionFence: manifest.interactionFence,
        notificationsAfter: Date.now() + 3600000,
        legacyWebhooks:
          defect === "missing-webhooks" ? {} : { [FORUM]: defect === "empty-webhooks" ? [] : ["100000000000000001"] },
      },
    };
    await expect(stageAdoption({ ...env, CONFIG: settings }, manifest)).rejects.toThrow();
    expect(await env.THREAD_DIRECTORY.getByName("thread:v1:100000000000098701").get()).toBeNull();
  },
);

it("adopts once after cleanup restart and never recreates a new card whose POST was accepted without a receipt", async () => {
  const settings = configSchema.parse(env.CONFIG);
  const epoch = crypto.randomUUID();
  const owner = { accountId: 3, conversationId: 34567, guildId: GUILD, forumId: FORUM, generation: 1 };
  const thread = "100000000000056789";
  expect(await env.THREAD_DIRECTORY.getByName(`thread:v1:${thread}`).claim(owner)).toBe(true);
  const activeEnv = {
    ...env,
    CONFIG: {
      ...settings,
      relay: { ...settings.relay, startAfterMessageId: 101 },
      cutover: {
        phase: "active" as const,
        epoch,
        interactionFence: "100",
        notificationsAfter: Date.now() + 3600000,
        legacyWebhooks: { [FORUM]: ["100000000000000001"] },
      },
    },
  };
  let history = 0;
  let cards = 0;
  const { requests } = mockFetch(
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/34567", () =>
      json({
        id: 34567,
        status: "resolved",
        inbox_id: 2,
        custom_attributes: { discord_thread: `https://discord.com/channels/${GUILD}/${thread}` },
        messages: [],
      }),
    ),
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/34567/messages", () => json({ payload: [] })),
    on("GET", `discord.com/api/v10/channels/${thread}`, () => json({ id: thread, guild_id: GUILD, parent_id: FORUM })),
    on("GET", `discord.com/api/v10/channels/${thread}/messages`, () => {
      history++;
      return json([]);
    }),
    on("PATCH", `discord.com/api/v10/channels/${thread}`, () => json({})),
    on("POST", "discord.com/api/v10/webhooks/1/tok", () => {
      cards++;
      return json({}, { status: 500 });
    }),
  );
  // Ready discovery is local; adoption must not execute a second forum discovery.
  await runInDurableObject(env.FORUM_REGISTRY.getByName(`forum:v1:${FORUM}`), (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO cache VALUES ('ready', ?, NULL)",
      JSON.stringify({ id: "1", token: "tok", guildId: GUILD, version: 1 }),
    );
  });
  await runInDurableObject(env.CONVERSATION.getByName(`adopt:${epoch}`), async (_instance, state) => {
    vi.spyOn(state.storage, "setAlarm").mockResolvedValue();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ctx = state;
    let executor = new Conversation(ctx, activeEnv);
    executor.stage(owner, thread, epoch, 101, []);
    await executor.enqueueConversation(3, 34567);
    for (let i = 0; i < 5; i++) {
      await executor.alarm();
      now += 6000;
      executor = new Conversation(ctx, activeEnv);
      await executor.enqueueConversation(3, 34567);
    }
  });
  expect(history).toBe(1);
  expect(cards).toBe(1);
  expect(requests.some((request) => request.method === "PATCH" && JSON.parse(request.body).archived === true)).toBe(
    true,
  );
});

it("rejects A100 unfinished/B101 sent, held/partial work, unresolved sends and missing inventory", () => {
  expect(() => validateCut(cut())).not.toThrow();
  for (const field of ["activeCalls", "jobs", "held", "partial", "unresolved"] as const)
    expect(() => validateCut({ ...cut(), [field]: 1 })).toThrow();
  const incomplete = cut();
  incomplete.mappings[0] = {
    ...incomplete.mappings[0],
    accountId: 3,
    conversationId: 12,
    threadId: THREAD,
    guildId: GUILD,
    forumId: FORUM,
    generation: 1,
    cursor: 99,
    latestEligibleId: 100,
    responses: [],
  };
  expect(() => validateCut(incomplete)).toThrow();
  expect(() => validateCut({ ...cut(), inventoryComplete: false })).toThrow();
  expect(() => validateCut({ ...cut(), sourcesPaused: false })).toThrow();
  expect(() => validateCut({ ...cut(), cooldownEndsAt: Date.now() + 60_000 })).toThrow();
  expect(() => validateCut({ ...cut(), mappings: [...cut().mappings, ...cut().mappings] })).toThrow();
});

it("repairs a missing link from the complete old mapping, fresh-confirms it, and refuses 403/conflicts", async () => {
  let link: string | undefined;
  let blocked = false;
  const { requests } = mockFetch(
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/12", () =>
      blocked ? json({}, { status: 403 }) : json({ id: 12, custom_attributes: { discord_thread: link } }),
    ),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/12/custom_attributes", () => {
      link = `https://discord.com/channels/${GUILD}/${THREAD}`;
      return json({});
    }),
    on("GET", `discord.com/api/v10/channels/${THREAD}`, () => json({ guild_id: GUILD, parent_id: FORUM })),
  );
  const client = chatwootClient("https://chatwoot.example.com", "test", (request) => fetch(request));
  const rest = new DiscordRest("test", (request) => fetch(request));
  await verifyLinks(cut(), client, rest, "discord_thread");
  expect(link).toContain(THREAD);
  const writes = requests.filter((request) => request.method === "POST").length;
  link = "https://discord.com/channels/100000000000000099/100000000000000098";
  await expect(verifyLinks(cut(), client, rest, "discord_thread")).rejects.toThrow();
  blocked = true;
  await expect(verifyLinks(cut(), client, rest, "discord_thread")).rejects.toThrow();
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(writes);
});

it("cleans old standalone cards through multiple pages/restarts, never a body or another webhook", async () => {
  const components = ticketCard({
    title: "Acme #12",
    customer: "Jane",
    details: [],
    url: "https://chatwoot.example.com/app/accounts/3/conversations/12",
    status: "open",
    labels: [],
    assignee: null,
  });
  const old = (id: string) => ({ id, webhook_id: "old", flags: MessageFlags.IsComponentsV2, content: "", components });
  const deleted: string[] = [];
  let fail = true;
  const { requests } = mockFetch(
    on("GET", `discord.com/api/v10/channels/${THREAD}/messages`, (request) => {
      const before = request.url.searchParams.get("before");
      return json(
        before === null
          ? [
              old("300"),
              { ...old("299"), content: "Customer body" },
              { ...old("298"), webhook_id: "someone-else" },
              {
                id: "297",
                webhook_id: "old",
                content: "",
                flags: MessageFlags.IsComponentsV2,
                components: [{ type: ComponentType.ActionRow, components: [] }],
              },
            ]
          : before === "297"
            ? [old("100")]
            : [],
      );
    }),
    on("DELETE", new RegExp(`^discord\\.com/api/v10/channels/${THREAD}/messages/(\\d+)$`), (request) => {
      if (fail) {
        fail = false;
        return json({}, { status: 503 });
      }
      deleted.push(request.url.pathname.split("/").at(-1) ?? "");
      return new Response(null, { status: 204 });
    }),
  );
  await runInDurableObject(env.CONVERSATION.getByName(`adoption:${crypto.randomUUID()}`), async (_instance, state) => {
    const store = new Store(state.storage.sql);
    const rest = new DiscordRest("test", (request) => fetch(request));
    await expect(cleanLegacyCards(store, rest, new Budget(15), THREAD, ["old"])).rejects.toThrow();
    // Reconstruct caller and repeat the persisted cleanup after its failed DELETE.
    for (let i = 0; i < 6; i++)
      if (await cleanLegacyCards(new Store(state.storage.sql), rest, new Budget(15), THREAD, ["old"])) break;
    expect(await cleanLegacyCards(store, rest, new Budget(15), THREAD, ["old"])).toBe(true);
  });
  expect(deleted).toEqual(["300", "100"]);
  expect(
    requests.filter((request) => request.method === "GET").map((request) => request.url.searchParams.get("before")),
  ).toEqual([null, "297", "100"]);
});

it("rejects a zero-receipt cut whose conversation cursor is beyond the common watermark", () => {
  const manifest = cut();
  const mapping = manifest.mappings[0];
  if (!mapping) throw new Error("Missing fixture mapping");
  mapping.cursor = manifest.watermark + 1;
  expect(() => validateCut(manifest)).toThrow();
});

it("refuses unfinished durable adoption when its runtime cutover configuration is removed", async () => {
  const settings = configSchema.parse(env.CONFIG);
  const owner = { accountId: 3, conversationId: 98765, guildId: GUILD, forumId: FORUM, generation: 1 };
  const { requests } = mockFetch(
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/98765", () =>
      json({
        id: 98765,
        status: "open",
        inbox_id: 2,
        custom_attributes: { discord_thread: `https://discord.com/channels/${GUILD}/${THREAD}` },
      }),
    ),
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/98765/messages", () => json({ payload: [] })),
    on("GET", `discord.com/api/v10/channels/${THREAD}`, () => json({ id: THREAD, guild_id: GUILD, parent_id: FORUM })),
    on("GET", `discord.com/api/v10/channels/${FORUM}`, () => json({ guild_id: GUILD, available_tags: [] })),
    on("POST", "discord.com/api/v10/webhooks/1/tok", () => json({ id: "100000000000070000", channel_id: THREAD })),
    on("PATCH", `discord.com/api/v10/channels/${THREAD}`, () => json({})),
  );
  await runInDurableObject(
    env.CONVERSATION.getByName(`unfinished:${crypto.randomUUID()}`),
    async (_instance, state) => {
      vi.spyOn(state.storage, "setAlarm").mockResolvedValue();
      let executor = new Conversation(state, { ...env, CONFIG: settings });
      executor.stage(owner, THREAD, "removed-cut", 101, []);
      await executor.enqueueConversation(3, 98765);
      executor = new Conversation(state, { ...env, CONFIG: settings });
      await executor.alarm();
      expect(new Store(state.storage.sql).conversation(3, 98765)?.threadId).toBeUndefined();
      expect(state.storage.sql.exec("SELECT 1 FROM jobs").toArray()).not.toHaveLength(0);
    },
  );
  expect(requests).toHaveLength(0);
});

it("seals the original digest baseline atomically and rejects changed same-epoch staging after live evolution", async () => {
  await runInDurableObject(env.QUEUE_DIGEST.getByName(`digest-stage:${crypto.randomUUID()}`), (_instance, state) => {
    const baseline = { b: { since: 20, level: 1 }, a: { since: 10, level: 2 } };
    let digest = new QueueDigest(state, env);
    digest.stage("sealed", JSON.stringify(baseline));
    const store = new Store(state.storage.sql);
    store.set("queue:escalations", JSON.stringify({ a: { since: 10, level: 3 } }));
    digest = new QueueDigest(state, env);
    expect(() =>
      digest.stage("sealed", JSON.stringify({ a: { level: 2, since: 10 }, b: { level: 1, since: 20 } })),
    ).not.toThrow();
    expect(() => digest.stage("sealed", JSON.stringify({ a: { since: 10, level: 3 } }))).toThrow();
    expect(JSON.parse(store.get("queue:escalations") ?? "null")).toEqual({ a: { since: 10, level: 3 } });
  });
});

it("reads the retained Hub inventory through the private operator binding", async () => {
  await runInDurableObject(env.LEGACY_HUB.getByName("global"), (_instance, state) => {
    state.storage.sql.exec(legacySchema);
    state.storage.sql.exec(
      "INSERT INTO conversations (account_id,conversation_id,thread_id,cursor) VALUES (3,123,?,101)",
      THREAD,
    );
  });
  const page = await inventory(env);
  expect(page.schemaVersion).toBe(9);
  expect(page.mappings).toMatchObject([{ accountId: 3, conversationId: 123, threadId: THREAD, cursor: 101 }]);
  expect(page.complete).toBe(true);
  expect(page.jobs).toBe(0);
});
