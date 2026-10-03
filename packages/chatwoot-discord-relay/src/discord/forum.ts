// The forum channel as seen by the bot: the webhook used to post messages under each sender's
// name, and its guild (for post links).

import {
  type RESTDeleteAPIWebhookWithTokenMessageQuery,
  type RESTDeleteAPIWebhookWithTokenMessageResult,
  type RESTGetAPIChannelResult,
  type RESTPatchAPIChannelJSONBody,
  type RESTPatchAPIChannelResult,
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageQuery,
  type RESTPatchAPIWebhookWithTokenMessageResult,
  type RESTPostAPIWebhookWithTokenJSONBody,
  type RESTPostAPIWebhookWithTokenQuery,
  type RESTPostAPIWebhookWithTokenWaitResult,
  type RESTPutAPIChannelThreadMembersResult,
  Routes,
} from "discord-api-types/v10";
import { log } from "../../../../shared/log.ts";
import { Effects } from "../effects.ts";
import type { ForumAccess, ForumSnapshot } from "../registry.ts";
import { type ForumClient, type SendOutcome, UnknownThreadError, type WebhookMessage } from "../relay/relay.ts";
import { DiscordHttpError, type DiscordRest } from "./rest.ts";

/** Discord answers a request to a deleted post with this code, with HTTP 404 or, for a webhook, 400. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_WEBHOOK = 10015;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_TAG = 10087;

export interface Cache {
  get(key: string): string | undefined;
  /** `ttlMs` undefined keeps the value until it is deleted. */
  set(key: string, value: string, ttlMs?: number): void;
  delete(key: string): void;
  transaction?<T>(write: () => T): T;
}

export class DiscordForum implements ForumClient {
  constructor(
    private readonly rest: DiscordRest,
    private readonly cache: Cache,
    private readonly access: ForumAccess,
  ) {}

  async execute(
    forumChannelId: string,
    message: WebhookMessage,
    threadId?: string,
    sendKey?: string,
    checkpoint?: (receipt: { channelId: string; messageId: string }) => void,
  ): Promise<SendOutcome> {
    const webhook = await this.webhook(forumChannelId);
    const effects = new Effects(this.cache);
    const key = sendKey ?? crypto.randomUUID();
    try {
      const effect = await this.withTags(forumChannelId, message.applied_tags, async (tags) => {
        const request = tags ? { ...message, applied_tags: tags } : message;
        const existing = effects.read(key);
        if (existing?.state === "READY") effects.save(key, { state: "READY", request });
        try {
          return await effects.run(
            key,
            request,
            async (frozen) => {
              const sent = await this.rest.post<
                RESTPostAPIWebhookWithTokenWaitResult,
                RESTPostAPIWebhookWithTokenJSONBody,
                RESTPostAPIWebhookWithTokenQuery
              >(Routes.webhook(webhook.id, webhook.token), {
                body: frozen,
                query: { wait: true, with_components: true, ...(threadId ? { thread_id: threadId } : {}) },
                auth: false,
              });
              if (!sent?.channel_id || !/^\d+$/.test(sent.channel_id) || !/^\d+$/.test(sent.id))
                throw new TypeError("Missing Discord message receipt");
              return { channelId: sent.channel_id, messageId: sent.id };
            },
            checkpoint,
          );
        } catch (error) {
          if (tags?.length && error instanceof DiscordHttpError && (error.status === 400 || error.code === UNKNOWN_TAG))
            effects.save(key, { state: "READY", request });
          throw error;
        }
      });
      return effect.state === "CONFIRMED" && effect.receipt
        ? { state: "confirmed", ...effect.receipt }
        : { state: effect.state === "REJECTED" ? "rejected" : "unknown" };
    } catch (error) {
      if (threadId && isUnknownChannel(error)) throw new UnknownThreadError(threadId);
      if (error instanceof DiscordHttpError && error.status === 404) {
        if (error.code === UNKNOWN_WEBHOOK) await this.access.invalidate(forumChannelId, webhook.version);
        else if (threadId) throw new UnknownThreadError(threadId);
      }
      throw error;
    }
  }

  async updateThread(
    forumChannelId: string,
    threadId: string,
    patch: { archived: boolean; applied_tags?: string[]; name?: string },
  ): Promise<void> {
    try {
      await this.withTags(forumChannelId, patch.applied_tags, (tags) =>
        this.rest.patch<RESTPatchAPIChannelResult, RESTPatchAPIChannelJSONBody>(Routes.channel(threadId), {
          body: tags ? { ...patch, applied_tags: tags } : patch,
        }),
      );
    } catch (error) {
      if (error instanceof DiscordHttpError && error.status === 404 && error.code !== UNKNOWN_TAG) {
        throw new UnknownThreadError(threadId);
      }
      throw error;
    }
  }

  async editMessage(
    forumChannelId: string,
    threadId: string,
    messageId: string,
    message: WebhookMessage,
  ): Promise<boolean> {
    const webhook = await this.webhook(forumChannelId);
    try {
      await this.rest.patch<
        RESTPatchAPIWebhookWithTokenMessageResult,
        RESTPatchAPIWebhookWithTokenMessageJSONBody,
        RESTPatchAPIWebhookWithTokenMessageQuery
      >(Routes.webhookMessage(webhook.id, webhook.token, messageId), {
        body: message,
        query: { thread_id: threadId, with_components: true },
        auth: false,
      });
      return true;
    } catch (error) {
      if (isUnknownChannel(error)) throw new UnknownThreadError(threadId);
      if (error instanceof DiscordHttpError && error.status === 404) {
        if (error.code === UNKNOWN_MESSAGE) return false;
        if (error.code === UNKNOWN_WEBHOOK) await this.access.invalidate(forumChannelId, webhook.version);
        else throw new UnknownThreadError(threadId);
      }
      throw error;
    }
  }

  async deleteMessage(forumChannelId: string, threadId: string, messageId: string): Promise<void> {
    const webhook = await this.webhook(forumChannelId);
    try {
      await this.rest.delete<RESTDeleteAPIWebhookWithTokenMessageResult, RESTDeleteAPIWebhookWithTokenMessageQuery>(
        Routes.webhookMessage(webhook.id, webhook.token, messageId),
        { query: { thread_id: threadId }, auth: false },
      );
    } catch (error) {
      // Gone with its post, or by itself.
      if (isUnknownChannel(error)) return;
      if (error instanceof DiscordHttpError && error.status === 404) {
        if (error.code === UNKNOWN_MESSAGE) return;
        if (error.code === UNKNOWN_WEBHOOK) await this.access.invalidate(forumChannelId, webhook.version);
      }
      throw error;
    }
  }

  async threadExists(forumChannelId: string, threadId: string): Promise<boolean> {
    try {
      const channel = await this.rest.get<RESTGetAPIChannelResult>(Routes.channel(threadId));
      return "parent_id" in channel && channel.parent_id === forumChannelId;
    } catch (error) {
      if (error instanceof DiscordHttpError && error.status === 404) return false;
      throw error;
    }
  }

  async postUrl(forumChannelId: string, threadId: string): Promise<string> {
    const snapshot = await this.webhook(forumChannelId);
    return `https://discord.com/channels/${snapshot.guildId}/${threadId}`;
  }

  async addMember(threadId: string, userId: string): Promise<void> {
    await this.rest.put<RESTPutAPIChannelThreadMembersResult, never>(Routes.threadMembers(threadId, userId), {});
  }

  private async webhook(forumChannelId: string): Promise<ForumSnapshot> {
    const snapshot = await this.access.lookup(forumChannelId);
    if (!snapshot) throw new DiscordHttpError(429, undefined, "forum not ready", 1000);
    return snapshot;
  }

  /**
   * Sends a request that applies configured forum tags. A tag deleted in Discord makes Discord
   * refuse the request: Discord documents JSON code 10087 (Unknown Tag) but not its HTTP status,
   * and refuses an invalid form body with 400. On either, the request is sent once more with only
   * the tags the forum still has, and the missing ones are logged: `forumTags` needs updating.
   */
  private async withTags<T>(
    forumChannelId: string,
    tags: string[] | undefined,
    send: (tags: string[] | undefined) => Promise<T>,
  ): Promise<T> {
    try {
      return await send(tags);
    } catch (error) {
      const refused = error instanceof DiscordHttpError && (error.status === 400 || error.code === UNKNOWN_TAG);
      if (!refused || !tags?.length) throw error;
      const channel = await this.rest.get<RESTGetAPIChannelResult>(Routes.channel(forumChannelId));
      const existing = new Set("available_tags" in channel ? channel.available_tags.map((tag) => tag.id) : []);
      const missing = tags.filter((id) => !existing.has(id));
      if (missing.length === 0) throw error;
      log.warn("forumTags has tags the forum no longer has", { forumChannelId, missing: missing.join(",") });
      return send(tags.filter((id) => existing.has(id)));
    }
  }
}

function isUnknownChannel(error: unknown): boolean {
  return error instanceof DiscordHttpError && error.code === UNKNOWN_CHANNEL;
}
