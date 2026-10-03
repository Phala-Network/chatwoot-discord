import type { ChatwootClient, ChatwootConversation } from "../../../../shared/chatwoot/api.ts";
import type { Effects } from "../effects.ts";

export type MutationTarget =
  | { kind: "message" }
  | { kind: "labels"; labels: string[] }
  | { kind: "status"; status: string; snoozedUntil: number | null }
  | { kind: "priority"; priority: string | null }
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
  send: (target: Target) => Promise<unknown>,
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
