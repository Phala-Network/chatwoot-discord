import { describe, expect, it } from "vitest";
import { Notifier, RoutingPendingError } from "../src/relay/notify.ts";
import { MemoryStore, message, TRIAGE } from "./helpers.ts";

const NOW = new Date("2026-09-27T20:00:00Z");
const SECONDS = NOW.getTime() / 1000;
const router = { accounts: [3], waitSeconds: 30 };
const triage = { userId: TRIAGE, name: "Triage bot", perConversationPerHour: 5, perHour: 30 };

function notifier(store = new MemoryStore()) {
  return new Notifier({ store, router, triage, liveSeconds: 3600, now: () => NOW });
}

describe("router conversation state", () => {
  it("defers unseen customer messages, including an older watermark, without consuming budgets", () => {
    const store = new MemoryStore();
    const notifications = notifier(store);
    const customer = message({ createdAt: SECONDS, conversation: { customAttributes: { routing_seen: 100 } } });
    expect(() => notifications.notification(customer)).toThrow(RoutingPendingError);
    expect(store.decisions.size).toBe(0);
    expect(store.counters.size).toBe(0);
    customer.conversation.customAttributes.routing_seen = customer.id;
    expect(notifications.notification(customer).lines).toEqual([`-# <@${TRIAGE}>`]);
  });

  it("waits through assignment and status changes until seen includes the handled message", () => {
    for (const conversation of [{ assignee: { id: 42 } }, { status: "resolved" }, { status: "snoozed" }]) {
      const notifications = notifier();
      const customer = message({ createdAt: SECONDS, conversation });
      expect(() => notifications.notification(customer)).toThrow(RoutingPendingError);
      customer.conversation.customAttributes = { routing_seen: customer.id, routing_handled: customer.id };
      expect(notifications.notification(customer).lines).toEqual([
        "-# Triage bot not called: handled automatically. Ask it here, if needed.",
      ]);
    }
  });

  it("stops waiting outside the routed accounts, at the deadline, or without a timestamp", () => {
    const cases = [
      message({ createdAt: SECONDS, account: { id: 1, name: "Globex" } }),
      message({ createdAt: SECONDS - 30 }),
      message(),
    ];
    for (const customer of cases) expect(notifier().notification(customer).lines).toEqual([`-# <@${TRIAGE}>`]);
  });

  it.each([101, "101", " 101 "])("reads numeric or text watermarks: %j", (watermark) => {
    const customer = message({
      createdAt: SECONDS,
      conversation: { customAttributes: { routing_seen: watermark, routing_handled: watermark } },
    });
    expect(notifier().notification(customer).lines).toEqual([
      "-# Triage bot not called: handled automatically. Ask it here, if needed.",
    ]);
  });

  it.each([true, null, {}, [], "invalid", "", "1e309", "1.5", "-1"])(
    "treats invalid watermarks as absent: %j",
    (seen) => {
      expect(() =>
        notifier().notification(
          message({ createdAt: SECONDS, conversation: { customAttributes: { routing_seen: seen } } }),
        ),
      ).toThrow(RoutingPendingError);
    },
  );

  it("does not wait for agents or notes", () => {
    for (const customer of [
      message({ createdAt: SECONDS, messageType: "outgoing" }),
      message({ createdAt: SECONDS, private: true }),
    ]) {
      expect(notifier().notification(customer).lines).toEqual([]);
    }
  });

  it("keeps both handled and mention decisions on retries when attributes change", () => {
    const notifications = notifier();
    const customer = message({
      createdAt: SECONDS,
      conversation: { customAttributes: { routing_seen: 101, routing_handled: 101 } },
    });
    const handled = notifications.notification(customer);
    expect(handled.lines).toEqual(["-# Triage bot not called: handled automatically. Ask it here, if needed."]);
    customer.conversation.customAttributes = {};
    expect(notifications.notification(customer)).toEqual(handled);
    const later = message({ id: 102, createdAt: SECONDS - 30 });
    const mentioned = notifications.notification(later);
    expect(mentioned.lines).toEqual([`-# <@${TRIAGE}>`]);
    later.conversation.customAttributes.routing_handled = 102;
    expect(notifications.notification(later)).toEqual(mentioned);
  });
});
