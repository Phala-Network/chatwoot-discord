// Every outbound attempt counts, including retries and coordinator RPCs. A job's slice and
// the operation deadline also bound response bodies; a caller's cancellation is never replaced.
import type { Fetch } from "./chatwoot/api.ts";
import { within } from "./deadline.ts";

export class BudgetExhaustedError extends Error {
  constructor() {
    super("Subrequest budget for this invocation is used up");
    this.name = "BudgetExhaustedError";
  }
}

export class JobDeadlineError extends Error {
  constructor() {
    super("Job time slice is used up");
    this.name = "JobDeadlineError";
  }
}

export const METADATA_TIMEOUT_MS = 1500;
export const TRANSFER_TIMEOUT_MS = 8000;
export const JOB_SLICE_MS = 10_000;

export class Budget {
  private used = 0;
  private slice: AbortSignal | undefined;
  private sliceEnds = Number.POSITIVE_INFINITY;

  constructor(
    readonly limit: number,
    private readonly fetchImpl: Fetch = (request) => fetch(request),
    private readonly timeoutMs?: number,
  ) {}

  get remaining(): number {
    return this.limit - this.used;
  }

  startSlice(ms = JOB_SLICE_MS): void {
    this.sliceEnds = Date.now() + ms;
    this.slice = AbortSignal.timeout(ms);
  }

  requireTime(ms: number): void {
    this.checkpoint();
    if (Date.now() + ms > this.sliceEnds) throw new JobDeadlineError();
  }

  checkpoint(): void {
    if (this.slice?.aborted) throw new JobDeadlineError();
  }

  consume(): void {
    this.checkpoint();
    if (this.used >= this.limit) throw new BudgetExhaustedError();
    this.used += 1;
  }

  readonly fetch: Fetch = async (request) => {
    this.consume();
    const transfer =
      request.headers.get("content-type")?.startsWith("multipart/form-data") ||
      ["cdn.discordapp.com", "media.discordapp.net"].includes(new URL(request.url).hostname);
    const inference =
      request.method === "POST" &&
      !request.headers.has("api_access_token") &&
      new URL(request.url).hostname !== "discord.com";
    const operation = AbortSignal.timeout(
      this.timeoutMs ?? (transfer ? TRANSFER_TIMEOUT_MS : inference ? JOB_SLICE_MS : METADATA_TIMEOUT_MS),
    );
    const signal = AbortSignal.any([request.signal, operation, ...(this.slice ? [this.slice] : [])]);
    try {
      const response = await within(this.fetchImpl(new Request(request, { signal })), signal);
      if (!response.body) return response;
      const reader = response.body.getReader();
      const slice = this.slice;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await within(reader.read(), signal);
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (error) {
            await reader.cancel().catch(() => {});
            controller.error(slice?.aborted ? new JobDeadlineError() : error);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      this.checkpoint();
      throw error;
    }
  };
}
