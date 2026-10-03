// One durable attempt ledger. Message creation never acquires a second attempt after UNKNOWN.
import { BudgetExhaustedError, JobDeadlineError } from "../../../shared/budget.ts";
import { ChatwootError } from "../../../shared/chatwoot/api.ts";
import { log } from "../../../shared/log.ts";
import type { Cache } from "./discord/forum.ts";
import { DiscordHttpError } from "./discord/rest.ts";

export type EffectState = "READY" | "DISPATCHING" | "CONFIRMED" | "CONFIRMED_BY_STATE" | "UNKNOWN" | "REJECTED";
export interface Effect<T, Request = unknown> {
  state: EffectState;
  request: Request;
  startedAt?: number;
  receipt?: T;
  rejection?: { upstream: "discord" | "chatwoot"; status: number; code?: number };
}

export class Effects {
  constructor(private readonly store: Pick<Cache, "get" | "set">) {}

  read<T, Request = unknown>(key: string): Effect<T, Request> | undefined {
    const saved = this.store.get(`effect:${key}`);
    return saved === undefined ? undefined : JSON.parse(saved);
  }

  save<T, Request>(key: string, effect: Effect<T, Request>): Effect<T, Request> {
    this.store.set(`effect:${key}`, JSON.stringify(effect));
    return effect;
  }

  async run<T, Request>(
    key: string,
    request: Request,
    send: (frozen: Request) => Promise<T>,
  ): Promise<Effect<T, Request>> {
    const effect = this.read<T, Request>(key) ?? { state: "READY", request };
    if (effect.state === "DISPATCHING") this.save(key, { ...effect, state: "UNKNOWN" });
    if (effect.state === "REJECTED" && effect.rejection) {
      const rejected = effect.rejection;
      if (rejected.upstream === "discord")
        throw new DiscordHttpError(rejected.status, rejected.code, "previously rejected");
      throw new ChatwootError(rejected.status, "previously rejected");
    }
    if (effect.state !== "READY") return this.read<T, Request>(key) ?? effect;
    this.save(key, { ...effect, state: "DISPATCHING", startedAt: Date.now() });
    try {
      const receipt = await send(effect.request);
      return this.save(key, { ...effect, state: "CONFIRMED", receipt });
    } catch (error) {
      const http = error instanceof DiscordHttpError || error instanceof ChatwootError;
      if (
        error instanceof BudgetExhaustedError ||
        (error instanceof JobDeadlineError && !error.requestStarted) ||
        (http && [401, 403, 404, 429].includes(error.status))
      ) {
        this.save(key, { ...effect, state: "READY" });
        throw error;
      }
      if (http && error.status >= 400 && error.status < 500 && error.status !== 408) {
        this.save(key, {
          ...effect,
          state: "REJECTED",
          rejection: {
            upstream: error instanceof DiscordHttpError ? "discord" : "chatwoot",
            status: error.status,
            ...(error instanceof DiscordHttpError && error.code !== undefined ? { code: error.code } : {}),
          },
        });
        throw error;
      }
      log.warn("effect outcome unknown", { effectId: key });
      return this.save(key, { ...effect, state: "UNKNOWN" });
    }
  }
}
