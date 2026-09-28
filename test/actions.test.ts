import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../src/budget.ts";
import { executeCommand } from "../src/commands/actions.ts";
import { type CommandAction, type CommandJob, commandJobSchema } from "../src/commands/job.ts";
import { ALICE, BOB, json, mockFetch, on, type Route, testSettings } from "./helpers.ts";

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
    action,
  };
}

const profile = on("GET", `${cw}/profile`, () =>
  json({ id: 42, name: "Alice Example", available_name: "Alice", email: "alice@example.com", accounts: [{ id: 3 }] }),
);
const ok = (method: string, path: string) => on(method, path, () => json({}));

function run(action: CommandAction, ...routes: Route[]) {
  const mock = mockFetch(profile, ...routes);
  const outcome = executeCommand(job(action), settings, (request) => fetch(request));
  return { outcome, result: outcome.then(({ content }) => content), requests: mock.requests };
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

  it("marks as pending", async () => {
    const { result, requests } = run(
      { type: "status", status: "pending" },
      ok("POST", `${conversation}/toggle_status`),
    );
    expect(await result).toBe("✅ Marked as pending.");
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({ status: "pending" });
  });

  it("snoozes until the next reply without a time, or until the given time", async () => {
    const untilReply = run({ type: "status", status: "snoozed" }, ok("POST", `${conversation}/toggle_status`));
    expect(await untilReply.result).toBe("✅ Snoozed until the next reply.");
    expect(JSON.parse(untilReply.requests.at(-1)?.body ?? "")).toEqual({ status: "snoozed" });

    const timed = run(
      { type: "status", status: "snoozed", snoozedUntil: 1790530245 },
      ok("POST", `${conversation}/toggle_status`),
    );
    expect(await timed.result).toBe("✅ Snoozed until <t:1790530245:f>.");
    expect(JSON.parse(timed.requests.at(-1)?.body ?? "")).toEqual({ status: "snoozed", snoozed_until: 1790530245 });
  });

  it("still reads status jobs queued before snoozing existed", () => {
    const queued = JSON.parse(JSON.stringify(job({ type: "status", status: "resolved" })));
    expect(commandJobSchema.parse(queued).action).toEqual({ type: "status", status: "resolved" });
  });

  it("sets and clears the priority", async () => {
    const set = run({ type: "priority", priority: "urgent" }, ok("POST", `${conversation}/toggle_priority`));
    expect(await set.result).toBe("✅ Priority set to Urgent.");
    expect(JSON.parse(set.requests.at(-1)?.body ?? "")).toEqual({ priority: "urgent" });

    const clear = run({ type: "priority", priority: null }, ok("POST", `${conversation}/toggle_priority`));
    expect(await clear.result).toBe("✅ Priority removed.");
    expect(JSON.parse(clear.requests.at(-1)?.body ?? "")).toEqual({ priority: null });
  });

  it("blocks by resolving the conversation and blocking its contact", async () => {
    const { result, requests } = run(
      { type: "block" },
      on("GET", conversation, () => json({ id: 15, status: "open", meta: { sender: { id: 88 } } })),
      ok("POST", `${conversation}/toggle_status`),
      ok("PUT", `${cw}/accounts/3/contacts/88`),
    );
    expect(await result).toMatch(/^✅ Contact blocked and conversation resolved/);
    expect(requests.slice(1).map((request) => [`${request.method} ${request.url.pathname}`, request.body])).toEqual([
      ["GET /api/v1/accounts/3/conversations/15", ""],
      ["POST /api/v1/accounts/3/conversations/15/toggle_status", JSON.stringify({ status: "resolved" })],
      ["PUT /api/v1/accounts/3/contacts/88", JSON.stringify({ blocked: true })],
    ]);
  });

  it("unblocks the contact without changing the conversation", async () => {
    const { result, requests } = run(
      { type: "unblock" },
      on("GET", conversation, () => json({ id: 15, status: "resolved", meta: { sender: { id: 88 } } })),
      ok("PUT", `${cw}/accounts/3/contacts/88`),
    );
    expect(await result).toBe("✅ Contact unblocked. Their new messages will be posted here again.");
    expect(requests.slice(1).map((request) => [`${request.method} ${request.url.pathname}`, request.body])).toEqual([
      ["GET /api/v1/accounts/3/conversations/15", ""],
      ["PUT /api/v1/accounts/3/contacts/88", JSON.stringify({ blocked: false })],
    ]);
  });

  it("assigns by the target agent's Chatwoot user id, whatever their email", async () => {
    const { result, requests } = run(
      { type: "assign", chatwootUserId: 43 },
      on("GET", `${cw}/accounts/3/agents`, () =>
        json([
          { id: 42, name: "Alice Example", available_name: "Alice", email: "alice@example.com" },
          { id: 43, name: "Bob Example", available_name: "Bob", email: "robert@example.org" },
        ]),
      ),
      ok("POST", `${conversation}/assignments`),
    );
    // Chatwoot shows the assignee's `name`, which is also the post's assignee tag.
    expect(await result).toBe("✅ Assigned to Bob Example.");
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({ assignee_id: 43 });
  });

  it("refuses to assign an agent outside the account, which Chatwoot would treat as unassigning", async () => {
    const { result, requests } = run(
      { type: "assign", chatwootUserId: 43 },
      on("GET", `${cw}/accounts/3/agents`, () => json([{ id: 42, name: "Alice Example" }])),
    );
    expect(await result).toBe("❌ That agent is not in this Chatwoot account.");
    expect(requests.some((request) => request.url.pathname.endsWith("/assignments"))).toBe(false);
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

  it("says when the agent is no longer in the account, rather than not linked", async () => {
    mockFetch(
      on("GET", `${cw}/profile`, () => json({ id: 42, name: "A", email: "a@example.com", accounts: [{ id: 99 }] })),
    );
    expect((await executeCommand(job({ type: "block" }), settings, (request) => fetch(request))).content).toBe(
      "❌ Your Chatwoot user is no longer an agent in this Chatwoot account. Ask an admin to add you back, or to unlink your Discord account.",
    );
  });

  it("refuses a token that belongs to another Chatwoot user than the one the invoker is linked to", async () => {
    const { requests } = mockFetch(
      on("GET", `${cw}/profile`, () =>
        json({ id: 999, name: "Admin", email: "admin@example.com", accounts: [{ id: 3 }] }),
      ),
      ok("POST", `${conversation}/messages`),
    );
    const { content } = await executeCommand(
      job({ type: "message", private: true, content: "hi", files: [] }),
      settings,
      (request) => fetch(request),
    );
    expect(content).toBe(
      "❌ Your Chatwoot access token belongs to another Chatwoot user, so nothing was done. Ask an admin to fix your link.",
    );
    expect(requests.map((request) => request.url.pathname)).toEqual(["/api/v1/profile"]);
  });

  it("refuses a queued command once its invoker is no longer linked", async () => {
    const unlinked = testSettings({ agents: [{ discordUserId: BOB, chatwootUserId: 43 }] });
    const { requests } = mockFetch(profile);
    const { content } = await executeCommand(job({ type: "block" }), unlinked, (request) => fetch(request));
    expect(content).toBe("❌ Your Discord account is not linked to a Chatwoot agent.");
    expect(requests).toEqual([]);
  });

  it("unassigns the way Chatwoot's dashboard does", async () => {
    const { result, requests } = run({ type: "unassign" }, ok("POST", `${conversation}/assignments`));
    expect(await result).toBe("✅ Unassigned.");
    const request = requests.at(-1);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(request?.body ?? "")).toEqual({ assignee_id: null });
  });

  describe("/label", () => {
    const accountLabels = on("GET", `${cw}/accounts/3/labels`, () =>
      json({
        payload: [
          { id: 1, title: "vip" },
          { id: 2, title: "refund" },
        ],
      }),
    );
    const conversationLabels = on("GET", `${conversation}/labels`, () => json({ payload: ["refund"] }));
    const setLabels = ok("POST", `${conversation}/labels`);
    const sent = (requests: Array<{ method: string; body: string }>) =>
      requests.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body));

    it("adds one of the account's labels, keeping the others", async () => {
      const { result, requests } = run(
        { type: "label", change: "add", label: "vip" },
        accountLabels,
        conversationLabels,
        setLabels,
      );
      expect(await result).toBe("✅ Label vip added.");
      expect(sent(requests)).toEqual([{ labels: ["refund", "vip"] }]);
    });

    it("refuses a label the account does not have", async () => {
      const { result, requests } = run(
        { type: "label", change: "add", label: "urgentt" },
        accountLabels,
        conversationLabels,
        setLabels,
      );
      expect(await result).toBe('❌ There is no label "urgentt" in this Chatwoot account.');
      expect(sent(requests)).toEqual([]);
    });

    it("removes a label the conversation has, keeping the others", async () => {
      const { result, requests } = run(
        { type: "label", change: "remove", label: "refund" },
        conversationLabels,
        setLabels,
      );
      expect(await result).toBe("✅ Label refund removed.");
      expect(sent(requests)).toEqual([{ labels: [] }]);
      const missing = run({ type: "label", change: "remove", label: "vip" }, conversationLabels, setLabels);
      expect(await missing.result).toBe('❌ This conversation has no label "vip".');
    });
  });

  it("maps Chatwoot permission errors to a clear message", async () => {
    const { result } = run(
      { type: "status", status: "resolved" },
      on("POST", `${conversation}/toggle_status`, () => json({ error: "x" }, { status: 403 })),
    );
    expect(await result).toBe("❌ You do not have access to this conversation.");
  });

  it("says when the conversation no longer exists, so its post can be closed", async () => {
    const { outcome } = run(
      { type: "block" },
      on("GET", conversation, () => json({ error: "Resource could not be found" }, { status: 404 })),
    );
    expect(await outcome).toEqual({
      content: "❌ This conversation no longer exists in Chatwoot.",
      conversationGone: true,
    });
    const other = run({ type: "status", status: "resolved" }, ok("POST", `${conversation}/toggle_status`));
    expect((await other.outcome).conversationGone).toBe(false);
  });

  it("does not send a reply the channel cannot deliver", async () => {
    const { result, requests } = run(
      { type: "message", private: false, content: "Hello again", files: [] },
      on("GET", conversation, () => json({ id: 15, status: "open", can_reply: false, meta: { assignee: { id: 42 } } })),
      ok("POST", `${conversation}/messages`),
    );
    expect(await result).toMatch(/^❌ This conversation's channel does not accept a reply right now/);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
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

  it("gives up on a request that does not answer in time, saying it may have been done", async () => {
    // Answers the profile, then never answers until the request is aborted.
    const hanging = (request: Request) =>
      request.url.endsWith("/profile")
        ? Promise.resolve(json({ id: 42, accounts: [{ id: 3 }] }))
        : new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason));
          });
    const { content } = await executeCommand(
      job({ type: "status", status: "resolved" }),
      settings,
      new Budget(20, hanging, 20).fetch,
    );
    expect(content).toMatch(/^❌ Chatwoot or Discord did not answer in time\. Check in Chatwoot whether it was done/);
  });
});
