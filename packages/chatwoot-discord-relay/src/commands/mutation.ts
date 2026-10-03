import type { ChatwootClient, ChatwootConversation, StatusChange } from "../../../../shared/chatwoot/api.ts";
import type { Effects } from "../effects.ts";

export type MutationTarget =
  | { kind: "message" }
  | { kind: "labels"; labels: string[] }
  | { kind: "status"; status: StatusChange["status"]; snoozedUntil: number | null }
  | { kind: "priority"; priority: Parameters<ChatwootClient["setPriority"]>[2] }
  | { kind: "assignment"; id: number | null; type: "User" | "AgentBot"; inboxId: number | null; status: string }
  | { kind: "contact"; id: number; blocked: boolean };

export class UnknownMutation extends Error {}

/** Request and confirmation consume the same frozen target; a message has no resolver. */
export async function mutate<Target extends MutationTarget>(
  effects: Effects,
  key: string,
  target: Target,
  chatwoot: ChatwootClient,
  ticket: { accountId: number; conversationId: number },
  send: (target: Target) => Promise<unknown> = (frozen) => dispatch(chatwoot, ticket, frozen),
): Promise<void> {
  const effect = await effects.run(key, target, send);
  if (effect.state === "CONFIRMED" || effect.state === "CONFIRMED_BY_STATE") return;
  if (effect.state === "UNKNOWN" && effect.request.kind !== "message") {
    try {
      if (await matches(chatwoot, ticket, effect.request)) {
        effects.save(key, { ...effect, state: "CONFIRMED_BY_STATE" });
        return;
      }
    } catch {
      // The original target survives an unavailable read; no automatic second mutation.
    }
  }
  throw new UnknownMutation();
}

function dispatch(
  client: ChatwootClient,
  { accountId, conversationId }: { accountId: number; conversationId: number },
  target: MutationTarget,
): Promise<unknown> {
  switch (target.kind) {
    case "labels":
      return client.setLabels(accountId, conversationId, target.labels);
    case "status":
      return client.setStatus(accountId, conversationId, {
        status: target.status,
        ...(target.snoozedUntil === null ? {} : { snoozed_until: target.snoozedUntil }),
      });
    case "priority":
      return client.setPriority(accountId, conversationId, target.priority);
    case "contact":
      return client.setContactBlocked(accountId, target.id, target.blocked);
    case "assignment":
      return target.id === null
        ? client.unassign(accountId, conversationId)
        : client.assign(accountId, conversationId, target.id, target.type);
    case "message":
      throw new Error("Message preparation is required before dispatch");
  }
}

async function matches(
  client: ChatwootClient,
  { accountId, conversationId }: { accountId: number; conversationId: number },
  target: MutationTarget,
): Promise<boolean> {
  if (target.kind === "message") return false;
  if (target.kind === "labels") {
    const labels = await client.conversationLabels(accountId, conversationId);
    return JSON.stringify([...new Set(labels)].sort()) === JSON.stringify([...new Set(target.labels)].sort());
  }
  const current = await client.getConversation(accountId, conversationId);
  if (!current) return false;
  switch (target.kind) {
    case "priority":
      return (current.priority ?? null) === target.priority;
    case "contact":
      return current.meta?.sender?.id === target.id && current.meta.sender.blocked === target.blocked;
    case "status":
      return current.status === target.status && (current.snoozed_until ?? null) === target.snoozedUntil;
    case "assignment":
      if (
        target.type === "AgentBot" &&
        target.inboxId !== null &&
        (await client.inboxBot(accountId, target.inboxId))?.id !== target.id
      )
        return false;
      return (
        (current.inbox_id ?? null) === target.inboxId &&
        current.status === target.status &&
        (current.meta?.assignee?.id ?? null) === target.id &&
        (target.id === null ? !current.meta?.assignee_type : current.meta?.assignee_type === target.type)
      );
  }
}

export function assignmentTarget(
  current: ChatwootConversation,
  id: number | null,
  type: "User" | "AgentBot",
): MutationTarget & { kind: "assignment" } {
  return {
    kind: "assignment",
    id,
    type,
    inboxId: current.inbox_id ?? null,
    status:
      type === "AgentBot"
        ? "pending"
        : id !== null && current.status === "pending" && current.meta?.assignee_type === "AgentBot"
          ? "open"
          : (current.status ?? "open"),
  };
}
