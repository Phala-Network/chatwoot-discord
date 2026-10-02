import { afterEach, expect, it, vi } from "vitest";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { json, mockFetch, on } from "./helpers.ts";

const endpoint = "chatwoot.example.com/api/v1/accounts/1/inboxes/2/agent_bot";
const client = () => chatwootClient("https://chatwoot.example.com", "user-token", (request) => fetch(request));
afterEach(() => vi.restoreAllMocks());

it.each([null, {}])("reads Chatwoot's wrapped unlinked bot response %j", async (agent_bot) => {
  mockFetch(on("GET", endpoint, () => json({ agent_bot })));
  expect(await client().inboxBot(1, 2)).toBeUndefined();
});

it("validates the account and strips bot credentials from the returned value", async () => {
  mockFetch(
    on("GET", endpoint, () =>
      json({ agent_bot: { id: 7, account_id: 1, access_token: "fixture", secret: "fixture" } }),
    ),
  );
  expect(await client().inboxBot(1, 2)).toEqual({ id: 7 });
});

it.each([
  { id: 7, account_id: 2 },
  { id: 7, account_id: null },
  { id: "7", account_id: 1 },
])("rejects invalid bot identity %j", async (agent_bot) => {
  mockFetch(on("GET", endpoint, () => json({ agent_bot })));
  await expect(client().inboxBot(1, 2)).rejects.toThrow();
});

it("treats a deleted inbox as unlinked but retries proxy errors", async () => {
  let proxy = false;
  mockFetch(
    on("GET", endpoint, () => (proxy ? new Response("not found", { status: 404 }) : json({}, { status: 404 }))),
  );
  expect(await client().inboxBot(1, 2)).toBeUndefined();
  proxy = true;
  await expect(client().inboxBot(1, 2)).rejects.toThrow("HTTP 404");
});

it("rejects the unwrapped shape incorrectly described by the OpenAPI document", async () => {
  mockFetch(on("GET", endpoint, () => json({ id: 7, account_id: 1 })));
  await expect(client().inboxBot(1, 2)).rejects.toThrow("invalid inbox bot");
});
