// Counts outbound requests so a Durable Object invocation stays under the Workers subrequest
// limit (50 per invocation on the Free plan). Work checks `remaining` before starting a unit
// that must not be cut in half, and yields to a fresh invocation when it is low.

import type { Fetch } from "./chatwoot/api.ts";

export class BudgetExhaustedError extends Error {
  constructor() {
    super("Subrequest budget for this invocation is used up");
    this.name = "BudgetExhaustedError";
  }
}

export class Budget {
  private used = 0;

  constructor(
    readonly limit: number,
    private readonly fetchImpl: Fetch = (request) => fetch(request),
  ) {}

  get remaining(): number {
    return this.limit - this.used;
  }

  readonly fetch: Fetch = (request) => {
    if (this.used >= this.limit) return Promise.reject(new BudgetExhaustedError());
    this.used += 1;
    return this.fetchImpl(request);
  };
}
