import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ComponentType, MessageFlags } from "discord-api-types/v10";
import { afterEach, expect, it, vi } from "vitest";
import { Budget } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { type AdoptionCut, cleanLegacyCards, validateCut, verifyLinks } from "../src/adoption.ts";
import { ticketCard } from "../src/commands/components.ts";
import { DiscordRest } from "../src/discord/rest.ts";
import { Store } from "../src/store.ts";
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
    on("DELETE", new RegExp(`^discord.com/api/v10/channels/${THREAD}/messages/(\\d+)$`), (request) => {
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
