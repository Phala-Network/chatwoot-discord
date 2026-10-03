import type { Budget } from "../../../shared/budget.ts";
import { within } from "../../../shared/deadline.ts";
import type { Env } from "./env.ts";

/** Short control RPCs count toward the invocation's budget and never inherit an unbounded wait. */
export function control<T>(budget: Budget | undefined, call: () => Promise<T>): Promise<T> {
  budget?.consume();
  return within(call(), budget?.controlSignal(200) ?? AbortSignal.timeout(200));
}

export function conversation(env: Env, accountId: number, conversationId: number) {
  return env.CONVERSATION.getByName(`conversation:v1:${accountId}:${conversationId}`);
}
