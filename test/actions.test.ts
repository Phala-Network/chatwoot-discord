import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCommand } from "../src/commands/actions.js";
import type { CommandAction, CommandJob } from "../src/commands/job.js";
import { ALICE, json, mockFetch, on, type Route, testSettings } from "./helpers.js";

const settings = testSettings();
const cw = "chatwoot.example.com/api/v1";
const conversation = `${cw}/accounts/3/conversations/15`;

function job(action: CommandAction, discordUserId = ALICE): CommandJob {
  return {
    interactionId: "1",
    applicationId: "100000000000000001",
    token: "tok",
    discordUserId,
    accountId: 3,
    conversationId: 15,
    ticketTitle: "Acme #15",
    action,
  };
}

const profile = on("GET", `${cw}/profile`, () =>
  json({ id: 42, name: "Alice Example", available_name: "Alice", email: "alice@example.com", accounts: [{ id: 3 }] }),
);
const ok = (method: string, path: string) => on(method, path, () => json({}));

function run(action: CommandAction, ...routes: Route[]) {
  const mock = mockFetch(profile, ...routes);
  return { result: executeCommand(job(action), settings, (request) => fetch(request)), requests: mock.requests };
}

afterEach(() => vi.restoreAllMocks());

describe("executeCommand", () => {
  it("acts with the invoking agent's own token", async () => {
    const { result, requests } = run(
      { type: "status", status: "resolved" },
      ok("POST", `${conversation}/toggle_status`),
    );
    expect(await result).toBe("✅ Resolved.");
    expect(requests.every((request) => request.headers.get("api_access_token") === "token-alice")).toBe(true);
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({ status: "resolved" });
  });

  it("reopens", async () => {
    const { result } = run({ type: "status", status: "open" }, ok("POST", `${conversation}/toggle_status`));
    expect(await result).toBe("✅ Reopened.");
  });

  it("blocks through Chatwoot's mute action", async () => {
    const { result, requests } = run({ type: "block" }, ok("POST", `${conversation}/mute`));
    expect(await result).toMatch(/^✅ Contact blocked and conversation resolved/);
    expect(requests.at(-1)?.url.pathname).toBe("/api/v1/accounts/3/conversations/15/mute");
  });

  it("assigns by the target agent's email", async () => {
    const { result, requests } = run(
      { type: "assign", email: "bob@example.com" },
      on("GET", `${cw}/accounts/3/agents`, () =>
        json([
          { id: 42, name: "Alice Example", available_name: "Alice", email: "alice@example.com" },
          { id: 43, name: "Bob Example", available_name: "Bob", email: "Bob@example.com" },
        ]),
      ),
      ok("POST", `${conversation}/assignments`),
    );
    expect(await result).toBe("✅ Assigned to Bob.");
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({ assignee_id: 43 });
  });

  it("refuses to assign an agent outside the account", async () => {
    const { result } = run(
      { type: "assign", email: "bob@example.com" },
      on("GET", `${cw}/accounts/3/agents`, () => json([])),
    );
    expect(await result).toBe("❌ That agent is not in this Chatwoot account.");
  });

  it("a public reply to an unassigned conversation assigns it to the sender first", async () => {
    const { result, requests } = run(
      { type: "message", private: false, content: "Thanks!", files: [] },
      on("GET", conversation, () => json({ id: 15, status: "open", meta: {} })),
      ok("POST", `${conversation}/assignments`),
      ok("POST", `${conversation}/messages`),
    );
    expect(await result).toBe("✅ Sent to the customer as Alice.");
    expect(requests.map((request) => `${request.method} ${request.url.pathname}`).slice(1)).toEqual([
      "GET /api/v1/accounts/3/conversations/15",
      "POST /api/v1/accounts/3/conversations/15/assignments",
      "POST /api/v1/accounts/3/conversations/15/messages",
    ]);
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({
      content: "Thanks!",
      message_type: "outgoing",
      private: false,
    });
  });

  it("a note does not touch the assignee", async () => {
    const { result, requests } = run(
      { type: "message", private: true, content: "Refund approved", files: [] },
      ok("POST", `${conversation}/messages`),
    );
    expect(await result).toBe("✅ Note added.");
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toMatchObject({ private: true });
  });

  it("downloads attachments from Discord's CDN and sends them as multipart", async () => {
    const { result, requests } = run(
      {
        type: "message",
        private: true,
        content: "",
        files: [
          {
            url: "https://cdn.discordapp.com/a/screenshot.png",
            filename: "screenshot.png",
            contentType: "image/png",
            size: 4,
          },
        ],
      },
      on("GET", "cdn.discordapp.com/a/screenshot.png", () => new Response(new Uint8Array([1, 2, 3, 4]))),
      ok("POST", `${conversation}/messages`),
    );
    expect(await result).toBe("✅ Note added.");
    const form = requests.at(-1)?.form;
    expect(form?.get("private")).toBe("true");
    expect(form?.get("content")).toBeNull();
    const file = form?.get("attachments[]");
    expect(file instanceof File && [file.name, file.type, file.size]).toEqual(["screenshot.png", "image/png", 4]);
  });

  it("stops a download that exceeds the size cap", async () => {
    const { result, requests } = run(
      {
        type: "message",
        private: true,
        content: "",
        files: [{ url: "https://cdn.discordapp.com/big", filename: "big", size: 1 }],
      },
      on("GET", "cdn.discordapp.com/big", () => new Response(new Uint8Array(26 * 1024 * 1024))),
    );
    expect(await result).toMatch(/must be 25 MB or smaller/);
    expect(requests.some((request) => request.url.pathname.endsWith("/messages"))).toBe(false);
  });

  it("refuses agents who are not members of the account", async () => {
    mockFetch(
      on("GET", `${cw}/profile`, () => json({ id: 42, name: "A", email: "a@example.com", accounts: [{ id: 99 }] })),
    );
    expect(await executeCommand(job({ type: "block" }), settings, (request) => fetch(request))).toBe(
      "❌ Your Discord account is not linked to a Chatwoot agent.",
    );
  });

  it("maps Chatwoot permission errors to a clear message", async () => {
    const { result } = run(
      { type: "block" },
      on("POST", `${conversation}/mute`, () => json({ error: "x" }, { status: 403 })),
    );
    expect(await result).toBe("❌ You do not have access to this conversation.");
  });

  it("does not leak unexpected errors", async () => {
    const { result } = run(
      { type: "status", status: "resolved" },
      on("POST", `${conversation}/toggle_status`, () =>
        json({ error: "PG::ConnectionBad secret details" }, { status: 500 }),
      ),
    );
    expect(await result).toBe("❌ That did not work. Please do it in Chatwoot.");
  });
});
