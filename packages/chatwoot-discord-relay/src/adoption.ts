// Cutover control is deliberately separate from online execution. No old-Hub read fallback.
import { MessageFlags, type RESTGetAPIChannelMessagesResult, Routes } from "discord-api-types/v10";
import { z } from "zod";
import type { Budget } from "../../../shared/budget.ts";
import type { ChatwootClient } from "../../../shared/chatwoot/api.ts";
import { relaysInbox, type Settings } from "./config.ts";
import type { ThreadOwner } from "./control.ts";
import type { DiscordRest } from "./discord/rest.ts";
import { DiscordHttpError } from "./discord/rest.ts";
import type { Env } from "./env.ts";
import {
  type ReceiptPage,
  type ReceiptSeal,
  receiptCountsSchema,
  receiptSealSchema,
  validateTitleMetadata,
} from "./history.ts";
import { escalationsSchema } from "./queue.ts";
import { control, conversation } from "./rpc.ts";
import { loadSettings } from "./settings.ts";
import type { Store } from "./store.ts";

export interface AdoptionMapping extends ThreadOwner {
  threadId: string;
  cursor: number;
  latestEligibleId: number;
  history: ReceiptSeal;
}
export interface AdoptionCut {
  epoch: string;
  watermark: number;
  interactionFence: string;
  sourceIdentity: string;
  schemaVersion: number;
  quiesced: boolean;
  sourcesPaused: boolean;
  activeCalls: number;
  jobs: number;
  held: number;
  partial: number;
  unresolved: number;
  routingGuardsDisposition: "independent-router" | "never-used";
  cooldownEndsAt: number;
  historyPermissionVerified: boolean;
  mappings: AdoptionMapping[];
  inventoryComplete: boolean;
  drainEvidence: string;
  escalationBaseline: string;
  sourceCounts: { conversations: number; threads: number; posted: number; derived: number; responses: number };
  auditedUnthreaded: number;
  receiptAudit: { orphaned: number; conflicting: number; invalid: number; unsupported: number };
}

const positive = z.number().int().positive();
const snowflake = z.string().regex(/^\d{17,20}$/);
export const cutSchema = z.strictObject({
  epoch: z.string().min(1),
  watermark: z.number().int().nonnegative(),
  interactionFence: z.string().regex(/^\d+$/),
  sourceIdentity: z.string().min(1),
  schemaVersion: z.union([z.literal(9), z.literal(10)]),
  quiesced: z.boolean(),
  sourcesPaused: z.boolean(),
  inventoryComplete: z.boolean(),
  drainEvidence: z.string().min(1),
  activeCalls: z.number().int().nonnegative(),
  jobs: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  routingGuardsDisposition: z.enum(["independent-router", "never-used"]),
  cooldownEndsAt: z.number().nonnegative(),
  historyPermissionVerified: z.boolean(),
  escalationBaseline: z.string(),
  sourceCounts: receiptCountsSchema.extend({
    conversations: z.number().int().nonnegative(),
    threads: z.number().int().nonnegative(),
  }),
  auditedUnthreaded: z.number().int().nonnegative(),
  receiptAudit: z.strictObject({
    orphaned: z.literal(0),
    conflicting: z.literal(0),
    invalid: z.literal(0),
    unsupported: z.literal(0),
  }),
  mappings: z.array(
    z.strictObject({
      accountId: positive,
      conversationId: positive,
      guildId: snowflake,
      forumId: snowflake,
      threadId: snowflake,
      generation: positive,
      cursor: z.number().int().nonnegative(),
      latestEligibleId: z.number().int().nonnegative(),
      history: receiptSealSchema,
    }),
  ),
});

export function validateCut(cut: AdoptionCut): void {
  if (!cutSchema.safeParse(cut).success) throw new Error("Invalid or unresolved cut manifest");
  escalationsSchema.parse(JSON.parse(cut.escalationBaseline));
  if (
    !cut.inventoryComplete ||
    !cut.drainEvidence ||
    !cut.sourceIdentity ||
    ![9, 10].includes(cut.schemaVersion) ||
    !cut.quiesced ||
    !cut.sourcesPaused ||
    cut.activeCalls ||
    cut.jobs ||
    cut.held ||
    cut.partial ||
    cut.unresolved ||
    !cut.historyPermissionVerified ||
    cut.cooldownEndsAt > Date.now() ||
    !/^\d+$/.test(cut.interactionFence)
  )
    throw new Error("Cutover preconditions are unresolved");
  if (
    cut.mappings.length !== cut.sourceCounts.threads ||
    cut.mappings.length + cut.auditedUnthreaded !== cut.sourceCounts.conversations
  )
    throw new Error("Incomplete authoritative conversation inventory");
  const totals = { posted: 0, derived: 0, responses: 0 };
  const threads = new Set<string>();
  const owners = new Set<string>();
  for (const mapping of cut.mappings) {
    validateTitleMetadata(mapping.history.header);
    if (
      owners.has(`${mapping.accountId}:${mapping.conversationId}`) ||
      threads.has(mapping.threadId) ||
      mapping.cursor < mapping.latestEligibleId ||
      mapping.cursor > cut.watermark ||
      mapping.latestEligibleId > cut.watermark ||
      mapping.history.header.accountId !== mapping.accountId ||
      mapping.history.header.conversationId !== mapping.conversationId ||
      mapping.history.header.threadId !== mapping.threadId ||
      mapping.history.header.cursor !== mapping.cursor ||
      mapping.history.header.schemaVersion !== cut.schemaVersion ||
      mapping.history.header.sourceIdentity !== cut.sourceIdentity ||
      (mapping.history.header.titleMessageId !== null && mapping.history.header.titleMessageId > mapping.cursor)
    )
      throw new Error("No common processed watermark or unique thread owner");
    threads.add(mapping.threadId);
    owners.add(`${mapping.accountId}:${mapping.conversationId}`);
    for (const kind of ["posted", "derived", "responses"] as const) totals[kind] += mapping.history.header.counts[kind];
  }
  for (const kind of ["posted", "derived", "responses"] as const)
    if (totals[kind] !== cut.sourceCounts[kind]) throw new Error("Incomplete authoritative receipt inventory");
}

/** Audit every source mapping, repair only its link, then fresh-read it; 403 never means absent. */
export async function verifyLinks(
  cut: AdoptionCut,
  client: ChatwootClient,
  rest: DiscordRest,
  attribute: string,
  settings: Settings,
): Promise<void> {
  if (!attribute) throw new Error("Adoption requires a link attribute");
  for (const mapping of cut.mappings) {
    const raw = await client.getConversation(mapping.accountId, mapping.conversationId);
    if (!raw) throw new Error("Missing legacy conversation");
    const thread = await rest.get<{ guild_id: string; parent_id: string }>(Routes.channel(mapping.threadId));
    if (thread.guild_id !== mapping.guildId || thread.parent_id !== mapping.forumId)
      throw new Error("Legacy thread scope mismatch");
    const link = `https://discord.com/channels/${mapping.guildId}/${mapping.threadId}`;
    const old = raw.custom_attributes?.[attribute];
    if (old && old !== link) throw new Error("Conflicting legacy link");
    if (old !== link) {
      const account = settings.account(mapping.accountId);
      if (!account || !relaysInbox(account, raw.inbox_id))
        throw new Error("Link repair is outside configured inbox scope");
      await client.setCustomAttributes(mapping.accountId, mapping.conversationId, { [attribute]: link });
      if (
        (await client.getConversation(mapping.accountId, mapping.conversationId))?.custom_attributes?.[attribute] !==
        link
      )
        throw new Error("Link repair not confirmed");
    }
  }
}

/** Invoke from a trusted operator/bridge binding, never a public HTTP import endpoint. */
export async function prepareAdoption(env: Env, cut: AdoptionCut): Promise<void> {
  validateCut(cut);
  const settings = await loadSettings(env);
  if (
    settings.config.cutover?.phase !== "maintenance" ||
    settings.config.cutover.epoch !== cut.epoch ||
    settings.config.relay.startAfterMessageId !== cut.watermark ||
    settings.config.cutover.interactionFence !== cut.interactionFence
  )
    throw new Error("Cutover configuration does not match the sealed cut");
  for (const mapping of cut.mappings) {
    if (
      settings.account(mapping.accountId)?.forumChannelId !== mapping.forumId ||
      !settings.config.cutover.legacyWebhooks[mapping.forumId]?.length
    )
      throw new Error("Cutover account, forum or historical webhook configuration is incomplete");
  }
  for (const { threadId, cursor: _cursor, latestEligibleId: _latest, history, ...owner } of cut.mappings) {
    if (!(await control(undefined, () => env.THREAD_DIRECTORY.getByName(`thread:v1:${threadId}`).claim(owner))))
      throw new Error("Directory conflict");
    await control(undefined, () =>
      conversation(env, owner.accountId, owner.conversationId).stage(
        owner,
        threadId,
        cut.epoch,
        cut.watermark,
        history,
      ),
    );
  }
}

/** Import one private artifact page. No public route and no online source lookup. */
export async function importAdoptionPage(env: Env, page: ReceiptPage): Promise<void> {
  await control(undefined, () =>
    conversation(env, page.header.accountId, page.header.conversationId).importHistory(page),
  );
}
export async function sealAdoptionHistory(env: Env, accountId: number, conversationId: number): Promise<void> {
  await control(undefined, () => conversation(env, accountId, conversationId).sealHistory());
}

/** All histories must be sealed before any mapping becomes ready for cleanup/activation. */
export async function stageAdoption(env: Env, cut: AdoptionCut): Promise<void> {
  await prepareAdoption(env, cut);
  for (const mapping of cut.mappings)
    if (
      !(await control(undefined, () =>
        conversation(env, mapping.accountId, mapping.conversationId).historyReady(mapping.history.digest),
      ))
    )
      throw new Error("Cut contains an incomplete legacy history");
  const settings = await loadSettings(env);
  if (settings.config.queue)
    await control(undefined, () =>
      env.QUEUE_DIGEST.getByName(`digest:v1:${settings.config.queue?.channelId}`).stage(
        cut.epoch,
        cut.escalationBaseline,
      ),
    );
  for (const mapping of cut.mappings)
    await control(undefined, () => conversation(env, mapping.accountId, mapping.conversationId).readyHistory());
}

/** One page/checkpoint at a time; only the old webhooks' standalone V2 cards are deleted. */
export async function cleanLegacyCards(
  store: Store,
  rest: DiscordRest,
  budget: Budget,
  threadId: string,
  webhookIds: string[],
): Promise<boolean> {
  const key = `adoption:cleanup:${threadId}`;
  const saved: { before?: string; pending: string[]; finished: boolean } = JSON.parse(
    store.get(key) ?? '{"pending":[],"finished":false}',
  );
  const save = () => store.set(key, JSON.stringify(saved));
  if (saved.finished) return true;
  if (saved.pending.length === 0) {
    if (budget.remaining < 8) return false;
    const page = await rest.get<RESTGetAPIChannelMessagesResult, { limit: number; before?: string }>(
      Routes.channelMessages(threadId),
      { query: { limit: 100, ...(saved.before ? { before: saved.before } : {}) } },
    );
    if (page.length === 0) {
      saved.finished = true;
      save();
      return true;
    }
    saved.pending = page
      .filter(
        (message) =>
          webhookIds.includes(message.webhook_id ?? "") &&
          ((message.flags ?? 0) & MessageFlags.IsComponentsV2) !== 0 &&
          message.content === "" &&
          message.components?.some(
            (component) =>
              component.type === 17 &&
              component.components.length === 4 &&
              component.components[0]?.type === 10 &&
              component.components
                .slice(1)
                .every(
                  (part) =>
                    part.type === 1 &&
                    part.components.every(
                      (button) => button.type === 2 && "custom_id" in button && button.custom_id.startsWith("ticket:"),
                    ),
                ) &&
              component.components.some(
                (part) =>
                  part.type === 1 &&
                  part.components.some(
                    (button) => button.type === 2 && "custom_id" in button && button.custom_id === "ticket:manage",
                  ),
              ),
          ),
      )
      .map((message) => message.id);
    const before = page.at(-1)?.id;
    if (!before || (saved.before && BigInt(before) >= BigInt(saved.before)))
      throw new Error("History page did not advance");
    saved.before = before;
    save();
  }
  while (saved.pending.length > 0) {
    if (budget.remaining < 8) return false;
    const messageId = saved.pending[0];
    if (!messageId) break;
    try {
      await rest.delete(Routes.channelMessage(threadId, messageId));
    } catch (error) {
      if (!(error instanceof DiscordHttpError && error.status === 404)) throw error;
    }
    saved.pending.shift();
    save();
  }
  // Even a short page is followed by a verified empty page, after permissions were checked at cutover.
  return false;
}
