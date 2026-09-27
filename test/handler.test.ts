import {
  type APIInteraction,
  type APIInteractionResponse,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
} from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { COMMANDS, REPLY_WITH_THIS } from "../src/commands/definitions.js";
import { FAILED, type HandlerResult, handleInteraction } from "../src/commands/handler.js";
import { ALICE, BOB, CAROL, TRIAGE, testSettings } from "./helpers.js";

const THREAD = "100000000000001500";
const settings = testSettings();
const deps = {
  settings,
  ticketForThread: async (threadId: string) => (threadId === THREAD ? { accountId: 3, conversationId: 15 } : undefined),
};

function interaction(fields: {
  type?: number;
  name?: string;
  options?: unknown[];
  user?: string;
  channel?: string;
  data?: Record<string, unknown>;
}): APIInteraction {
  const channel = fields.channel ?? THREAD;
  // Built as plain JSON, the way the Worker receives it after signature verification.
  return JSON.parse(
    JSON.stringify({
      id: "777001",
      application_id: "100000000000000001",
      token: "interaction-token",
      type: fields.type ?? 2,
      channel_id: channel,
      channel: { id: channel, type: 11 },
      member: { user: { id: fields.user ?? ALICE } },
      data: { type: 1, name: fields.name, options: fields.options ?? [], ...fields.data },
    }),
  );
}

function submission(kind: string, text?: string, files: Record<string, unknown> = {}) {
  return interaction({
    type: 5,
    data: {
      custom_id: `${kind}:9001`,
      components: [
        { type: 18, component: { type: 4, custom_id: "content:9001", value: text } },
        { type: 18, component: { type: 19, custom_id: "files:9001", values: Object.keys(files) } },
      ],
      resolved: { attachments: files },
    },
  });
}

function privateText(result: HandlerResult): string | undefined {
  const response = result.response;
  expect(response.type).toBe(InteractionResponseType.ChannelMessageWithSource);
  if (response.type !== InteractionResponseType.ChannelMessageWithSource) return undefined;
  expect(response.data.flags).toBe(MessageFlags.Ephemeral);
  expect(result.job).toBeUndefined();
  return response.data.content;
}

function editorField(response: APIInteractionResponse, prefix: string): Record<string, unknown> | undefined {
  if (response.type !== InteractionResponseType.Modal) return undefined;
  for (const label of response.data.components) {
    if (label.type !== ComponentType.Label) continue;
    const component: Record<string, unknown> = { ...label.component };
    if (String(component.custom_id).startsWith(`${prefix}:`)) return component;
  }
  return undefined;
}

function menu(content: string, author = TRIAGE) {
  return handleInteraction(
    interaction({
      name: REPLY_WITH_THIS,
      data: { type: 3, target_id: "77", resolved: { messages: { "77": { content, author: { id: author } } } } },
    }),
    deps,
  );
}

describe("interaction handler", () => {
  it("answers Discord's ping", async () => {
    expect((await handleInteraction(JSON.parse('{"type":1}'), deps)).response).toEqual({ type: 1 });
  });

  it("/reply opens an empty editor with ids unique to the interaction", async () => {
    const { response, job } = await handleInteraction(interaction({ name: "reply" }), deps);
    expect(job).toBeUndefined();
    expect(response.type).toBe(InteractionResponseType.Modal);
    if (response.type !== InteractionResponseType.Modal) return;
    expect(response.data.custom_id).toBe("reply:777001");
    expect(response.data.title).toBe("Reply · Acme #15");
    expect(editorField(response, "content")).toMatchObject({ custom_id: "content:777001", style: 2, max_length: 4000 });
    expect(editorField(response, "content")).not.toHaveProperty("value");
    expect(editorField(response, "files")).toEqual({
      type: 19,
      custom_id: "files:777001",
      min_values: 0,
      max_values: 10,
      required: false,
    });
  });

  it("/note opens the private-note editor", async () => {
    const { response } = await handleInteraction(interaction({ name: "note" }), deps);
    expect(response.type === InteractionResponseType.Modal && response.data.custom_id).toBe("note:777001");
  });

  it("'Reply with this' takes the draft block from a triage bot message", async () => {
    const triage =
      "**Summary**: wants account deletion\n```\ncli conv 15\n```\n**Draft**:\n```text\nHi, delete it in Settings.\n```";
    const { response } = await menu(triage);
    expect(response.type === InteractionResponseType.Modal && response.data.custom_id).toBe("reply:777001");
    expect(editorField(response, "content")?.value).toBe("Hi, delete it in Settings.");
  });

  it("'Reply with this' explains when a triage message has no draft", async () => {
    expect(privateText(await menu("```\nprogress output\n```"))).toMatch(/no draft/);
  });

  it("'Reply with this' uses the last code block or the whole text from anyone else", async () => {
    const colleague = "Try this:\n```\nold\n```\nor\n```\nHi, please log in again.\n```";
    expect(editorField((await menu(colleague, BOB)).response, "content")?.value).toBe("Hi, please log in again.");
    expect(editorField((await menu(" Thanks for waiting! ", BOB)).response, "content")?.value).toBe(
      "Thanks for waiting!",
    );
  });

  it("registers the slash commands and the message command", () => {
    expect(COMMANDS.filter((command) => command.type === 1).map((command) => command.name)).toEqual([
      "reply",
      "note",
      "resolve",
      "reopen",
      "assign",
      "block",
    ]);
    const menuCommands = COMMANDS.filter((command) => command.type === 3);
    expect(menuCommands.map((command) => command.name)).toEqual([REPLY_WITH_THIS]);
    expect(menuCommands[0]).not.toHaveProperty("description");
  });

  it("submitting a reply defers a job that sends as the invoker", async () => {
    const legacy = interaction({
      type: 5,
      data: {
        custom_id: "reply",
        components: [{ type: 1, components: [{ type: 4, custom_id: "content", value: " Thanks! " }] }],
      },
    });
    const { response, job } = await handleInteraction(legacy, deps);
    expect(response).toEqual({ type: 5, data: { flags: MessageFlags.Ephemeral } });
    expect(job).toMatchObject({
      discordUserId: ALICE,
      accountId: 3,
      conversationId: 15,
      token: "interaction-token",
      action: { type: "message", private: false, content: "Thanks!", files: [] },
    });
  });

  it("a note submission is private", async () => {
    const { job } = await handleInteraction(submission("note", "Refund approved"), deps);
    expect(job?.action).toEqual({ type: "message", private: true, content: "Refund approved", files: [] });
  });

  it("rejects an empty submission", async () => {
    expect(privateText(await handleInteraction(submission("reply", " "), deps))).toBe(
      "❌ Add a message or an attachment.",
    );
  });

  it("passes uploaded files to the job", async () => {
    const files = {
      "900": {
        id: "900",
        filename: "screenshot.png",
        content_type: "image/png",
        size: 1024,
        url: "https://cdn.discordapp.com/a.png",
      },
    };
    const { job } = await handleInteraction(submission("reply", "", files), deps);
    expect(job?.action).toEqual({
      type: "message",
      private: false,
      content: "",
      files: [
        { url: "https://cdn.discordapp.com/a.png", filename: "screenshot.png", size: 1024, contentType: "image/png" },
      ],
    });
  });

  it("rejects oversized attachments and non-Discord URLs up front", async () => {
    const big = { "902": { filename: "video.mp4", size: 26 * 1024 * 1024, url: "https://cdn.discordapp.com/v.mp4" } };
    expect(privateText(await handleInteraction(submission("reply", "see video", big), deps))).toMatch(
      /25 MB or smaller/,
    );
    const elsewhere = { "903": { filename: "a.txt", size: 10, url: "https://files.example.com/a.txt" } };
    expect(privateText(await handleInteraction(submission("reply", "x", elsewhere), deps))).toMatch(
      /uploaded in Discord/,
    );
  });

  it("status commands and /block are deferred jobs", async () => {
    expect((await handleInteraction(interaction({ name: "resolve" }), deps)).job?.action).toEqual({
      type: "status",
      status: "resolved",
    });
    expect((await handleInteraction(interaction({ name: "reopen" }), deps)).job?.action).toEqual({
      type: "status",
      status: "open",
    });
    expect((await handleInteraction(interaction({ name: "block" }), deps)).job?.action).toEqual({ type: "block" });
    expect(privateText(await handleInteraction(interaction({ name: "snooze" }), deps))).toBe("Unknown command.");
  });

  it("/assign defaults to the invoker and maps other Discord users", async () => {
    expect((await handleInteraction(interaction({ name: "assign" }), deps)).job?.action).toEqual({
      type: "assign",
      email: "alice@example.com",
    });
    const other = interaction({ name: "assign", options: [{ name: "agent", type: 6, value: BOB }] });
    expect((await handleInteraction(other, deps)).job?.action).toEqual({ type: "assign", email: "bob@example.com" });
    const stranger = interaction({
      name: "assign",
      options: [{ name: "agent", type: 6, value: "100000000000000042" }],
    });
    expect(privateText(await handleInteraction(stranger, deps))).toBe(
      "❌ That Discord user is not linked to a Chatwoot agent.",
    );
  });

  it("refuses unlinked users and channels that are not mapped tickets", async () => {
    const notLinked = "Your Discord account is not linked to a Chatwoot agent.";
    expect(
      privateText(await handleInteraction(interaction({ name: "resolve", user: "100000000000000099" }), deps)),
    ).toBe(notLinked);
    // Mapped to an email but without a Chatwoot token secret.
    expect(privateText(await handleInteraction(interaction({ name: "resolve", user: CAROL }), deps))).toBe(notLinked);
    // The ticket comes from the relay's mapping, never from the post title.
    expect(
      privateText(await handleInteraction(interaction({ name: "resolve", channel: "100000000000009999" }), deps)),
    ).toMatch(/inside a ticket post/);
  });

  it("exposes a generic failure message", () => {
    expect(FAILED).toBe("❌ That did not work. Please do it in Chatwoot.");
  });
});
