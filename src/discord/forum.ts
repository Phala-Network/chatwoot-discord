// The forum channel as seen by the bot: its tags and the webhook used to post messages under
// each sender's name.

import {
  type RESTDeleteAPIWebhookWithTokenMessageQuery,
  type RESTDeleteAPIWebhookWithTokenMessageResult,
  type RESTGetAPIChannelResult,
  type RESTGetAPIChannelWebhooksResult,
  type RESTPatchAPIChannelJSONBody,
  type RESTPatchAPIChannelResult,
  type RESTPostAPIChannelWebhookJSONBody,
  type RESTPostAPIChannelWebhookResult,
  type RESTPostAPIWebhookWithTokenJSONBody,
  type RESTPostAPIWebhookWithTokenQuery,
  type RESTPostAPIWebhookWithTokenWaitResult,
  Routes,
  WebhookType,
} from "discord-api-types/v10";
import { z } from "zod";
import { type ForumClient, UnknownThreadError, type WebhookMessage } from "../relay/relay.js";
import { DiscordHttpError, type DiscordRest } from "./rest.js";

export const WEBHOOK_NAME = "Chatwoot";
const MAX_TAGS = 5;
const TAG_CACHE_MS = 10 * 60 * 1000;
const UNKNOWN_WEBHOOK = 10015;
const UNKNOWN_MESSAGE = 10008;

export interface Cache {
  get(key: string): string | undefined;
  /** `ttlMs` undefined keeps the value until it is deleted. */
  set(key: string, value: string, ttlMs?: number): void;
  delete(key: string): void;
}

const forumInfoSchema = z.object({ guildId: z.string(), tags: z.record(z.string(), z.string()) });
type ForumInfo = z.infer<typeof forumInfoSchema>;

export class DiscordForum implements ForumClient {
  constructor(
    private readonly rest: DiscordRest,
    private readonly cache: Cache,
  ) {}

  async execute(
    forumChannelId: string,
    message: WebhookMessage,
    threadId?: string,
  ): Promise<{ channelId: string; messageId: string }> {
    const webhook = await this.webhook(forumChannelId);
    try {
      const sent = await this.rest.post<
        RESTPostAPIWebhookWithTokenWaitResult,
        RESTPostAPIWebhookWithTokenJSONBody,
        RESTPostAPIWebhookWithTokenQuery
      >(Routes.webhook(webhook.id, webhook.token), {
        body: message,
        query: { wait: true, ...(threadId ? { thread_id: threadId } : {}) },
        auth: false,
      });
      return { channelId: sent.channel_id, messageId: sent.id };
    } catch (error) {
      if (error instanceof DiscordHttpError && error.status === 404) {
        if (error.code === UNKNOWN_WEBHOOK) {
          // Someone deleted the webhook: forget it so the next attempt creates a new one.
          this.cache.delete(webhookKey(forumChannelId));
        } else if (threadId) {
          throw new UnknownThreadError(threadId);
        }
      }
      throw error;
    }
  }

  async updateThread(threadId: string, patch: { archived: boolean; applied_tags?: string[] }): Promise<void> {
    await this.rest.patch<RESTPatchAPIChannelResult, RESTPatchAPIChannelJSONBody>(Routes.channel(threadId), {
      body: patch,
    });
  }

  async deleteMessage(forumChannelId: string, threadId: string, messageId: string): Promise<void> {
    const webhook = await this.webhook(forumChannelId);
    try {
      await this.rest.delete<RESTDeleteAPIWebhookWithTokenMessageResult, RESTDeleteAPIWebhookWithTokenMessageQuery>(
        Routes.webhookMessage(webhook.id, webhook.token, messageId),
        { query: { thread_id: threadId }, auth: false },
      );
    } catch (error) {
      if (error instanceof DiscordHttpError && error.status === 404) {
        if (error.code === UNKNOWN_MESSAGE) return;
        if (error.code === UNKNOWN_WEBHOOK) this.cache.delete(webhookKey(forumChannelId));
      }
      throw error;
    }
  }

  async tagIds(forumChannelId: string, names: ReadonlyArray<string | undefined>): Promise<string[]> {
    const { tags } = await this.channel(forumChannelId);
    const ids = names.flatMap((name) => {
      const id = name === undefined ? undefined : tags[name.toLowerCase()];
      return id ? [id] : [];
    });
    return [...new Set(ids)].slice(0, MAX_TAGS);
  }

  async threadExists(forumChannelId: string, threadId: string): Promise<boolean> {
    try {
      const channel = await this.rest.get<RESTGetAPIChannelResult>(Routes.channel(threadId));
      return "parent_id" in channel && channel.parent_id === forumChannelId;
    } catch (error) {
      if (error instanceof DiscordHttpError && (error.status === 404 || error.status === 403)) return false;
      throw error;
    }
  }

  async postUrl(forumChannelId: string, threadId: string): Promise<string> {
    const { guildId } = await this.channel(forumChannelId);
    return `https://discord.com/channels/${guildId}/${threadId}`;
  }

  /** Reuses the forum's "Chatwoot" webhook, or creates it. */
  private async webhook(forumChannelId: string): Promise<{ id: string; token: string }> {
    const key = webhookKey(forumChannelId);
    const [id, token] = this.cache.get(key)?.split(":") ?? [];
    if (id && token) return { id, token };
    const hooks = await this.rest.get<RESTGetAPIChannelWebhooksResult>(Routes.channelWebhooks(forumChannelId));
    const existing = hooks.find(
      (hook) => hook.type === WebhookType.Incoming && hook.name === WEBHOOK_NAME && hook.token,
    );
    const hook =
      existing ??
      (await this.rest.post<RESTPostAPIChannelWebhookResult, RESTPostAPIChannelWebhookJSONBody>(
        Routes.channelWebhooks(forumChannelId),
        { body: { name: WEBHOOK_NAME } },
      ));
    if (!hook.token) throw new Error("Discord returned a webhook without a token");
    this.cache.set(key, `${hook.id}:${hook.token}`);
    return { id: hook.id, token: hook.token };
  }

  /**
   * The forum's guild and its tags by lower-cased name, cached briefly so new tags are picked up
   * without a deploy.
   */
  private async channel(forumChannelId: string): Promise<ForumInfo> {
    const key = `forum:${forumChannelId}:channel`;
    const cached = forumInfoSchema.safeParse(parseJson(this.cache.get(key)));
    if (cached.success) return cached.data;
    const channel = await this.rest.get<RESTGetAPIChannelResult>(Routes.channel(forumChannelId));
    const info: ForumInfo = { guildId: "guild_id" in channel ? (channel.guild_id ?? "") : "", tags: {} };
    if ("available_tags" in channel) {
      for (const tag of channel.available_tags) info.tags[tag.name.toLowerCase()] = tag.id;
    }
    this.cache.set(key, JSON.stringify(info), TAG_CACHE_MS);
    return info;
  }
}

function webhookKey(forumChannelId: string): string {
  return `forum:${forumChannelId}:webhook`;
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
