import { describe, expect, it } from "vitest";
import { Notifier, RoutingPendingError } from "../src/relay/notify.ts";
import { MemoryStore, message, TRIAGE } from "./helpers.ts";

const NOW = new Date("2026-09-27T20:00:00Z");
const SECONDS = NOW.getTime() / 1000;
const router = { accounts: [3], waitSeconds: 30, attributes: { seen: "seen", handled: "handled", kind: "kind" } };
const triage = { userId: TRIAGE, name: "Triage bot", perConversationPerHour: 5, perHour: 30 };

function notifier(store = new MemoryStore()) {
  return new Notifier({ store, router, triage, liveSeconds: 3600, now: () => NOW });
}

describe("router conversation state", () => {
  it("defers unseen customer messages, including an older watermark, without consuming budgets", () => {
    const store = new MemoryStore();
    const notifications = notifier(store);
    const customer = message({ createdAt: SECONDS, conversation: { customAttributes: { seen: 100 } } });
    expect(() => notifications.notification(customer)).toThrow(RoutingPendingError);
    expect(store.decisions.size).toBe(0);
    expect(store.counters.size).toBe(0);
    customer.conversation.customAttributes.seen = customer.id;
    expect(notifications.notification(customer).lines).toEqual([`-# <@${TRIAGE}>`]);
  });

  it("stops waiting when assigned, not open, outside the routed accounts, or at the deadline", () => {
    const cases = [
      message({ createdAt: SECONDS, conversation: { assignee: { id: 42 } } }),
      message({ createdAt: SECONDS, conversation: { status: "resolved" } }),
      message({ createdAt: SECONDS, conversation: { status: "snoozed" } }),
      message({ createdAt: SECONDS, account: { id: 1, name: "Globex" } }),
      message({ createdAt: SECONDS - 30 }),
      message(),
    ];
    for (const customer of cases) expect(notifier().notification(customer).lines).toEqual([`-# <@${TRIAGE}>`]);
  });

  it("accepts only numeric watermarks and does not wait for agents or notes", () => {
    expect(() =>
      notifier().notification(message({ createdAt: SECONDS, conversation: { customAttributes: { seen: "101" } } })),
    ).toThrow(RoutingPendingError);
    for (const customer of [
      message({ createdAt: SECONDS, messageType: "outgoing" }),
      message({ createdAt: SECONDS, private: true }),
    ]) {
      expect(notifier().notification(customer).lines).toEqual([]);
    }
  });

  it("keeps both handled and mention decisions on retries when attributes change", () => {
    const notifications = notifier();
    const customer = message({ createdAt: SECONDS, conversation: { customAttributes: { seen: 101, handled: 101 } } });
    const handled = notifications.notification(customer);
    expect(handled.lines).toEqual(["-# Triage bot not called: handled automatically. Ask it here, if needed."]);
    customer.conversation.customAttributes = {};
    expect(notifications.notification(customer)).toEqual(handled);
    const later = message({ id: 102, createdAt: SECONDS - 30 });
    const mentioned = notifications.notification(later);
    expect(mentioned.lines).toEqual([`-# <@${TRIAGE}>`]);
    later.conversation.customAttributes.handled = 102;
    expect(notifications.notification(later)).toEqual(mentioned);
  });
});
