// The forum channel as seen by the bot: its tags and the webhook used to post messages under
// each sender's name.

import {
  type APIChannel,
  type APIMessage,
  type APIWebhook,
  type RESTPatchAPIChannelJSONBody,
  Routes,
  WebhookType,
} from "discord-api-types/v10";
import { type ForumClient, UnknownThreadError, type WebhookMessage } from "../relay/relay.js";
import { DiscordHttpError, type DiscordRest } from "./rest.js";

export const WEBHOOK_NAME = "Chatwoot";
const MAX_TAGS = 5;
const TAG_CACHE_MS = 10 * 60 * 1000;
const UNKNOWN_WEBHOOK = 10015;

export interface Cache {
  get(key: string): string | undefined;
  /** `ttlMs` undefined keeps the value until it is deleted. */
  set(key: string, value: string, ttlMs?: number): void;
  delete(key: string): void;
}

interface ForumInfo {
  guildId: string;
  tags: Record<string, string>;
}

export class DiscordForum implements ForumClient {
  constructor(
    private readonly rest: DiscordRest,
    private readonly cache: Cache,
  ) {}

  async execute(forumChannelId: string, message: WebhookMessage, threadId?: string): Promise<{ channelId: string }> {
    const webhook = await this.webhook(forumChannelId);
    const query = new URLSearchParams({ wait: "true" });
    if (threadId) query.set("thread_id", threadId);
    try {
      const sent = (await this.rest.post(Routes.webhook(webhook.id, webhook.token), {
        body: message,
        query,
        auth: false,
      })) as APIMessage;
      return { channelId: sent.channel_id };
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

  async updatePost(threadId: string, patch: { applied_tags: string[]; archived: boolean }): Promise<void> {
    const body: RESTPatchAPIChannelJSONBody = patch;
    await this.rest.patch(Routes.channel(threadId), { body });
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
      const channel = (await this.rest.get(Routes.channel(threadId))) as APIChannel;
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
    const cached = this.cache.get(key);
    if (cached) {
      const [id, token] = cached.split(":");
      if (id && token) return { id, token };
    }
    const hooks = (await this.rest.get(Routes.channelWebhooks(forumChannelId))) as APIWebhook[];
    const existing = hooks.find(
      (hook) => hook.type === WebhookType.Incoming && hook.name === WEBHOOK_NAME && hook.token,
    );
    const hook =
      existing ??
      ((await this.rest.post(Routes.channelWebhooks(forumChannelId), { body: { name: WEBHOOK_NAME } })) as APIWebhook);
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
    const cached = this.cache.get(key);
    if (cached) return JSON.parse(cached) as ForumInfo;
    const channel = (await this.rest.get(Routes.channel(forumChannelId))) as APIChannel;
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
