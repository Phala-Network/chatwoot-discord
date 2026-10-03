import { describe, expect, it } from "vitest";
import { Budget, JobDeadlineError } from "../../../shared/budget.ts";

const request = (signal?: AbortSignal) => new Request("https://upstream.example/metadata", signal ? { signal } : {});

function slowBody(): Response {
  return new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) }));
}

describe("upstream deadlines", () => {
  it("bounds a slow response body by the operation deadline", async () => {
    const budget = new Budget(5, async () => slowBody(), 30);
    const started = Date.now();
    await expect((await budget.fetch(request())).text()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("preserves caller cancellation instead of replacing its signal", async () => {
    const budget = new Budget(5, async () => slowBody(), 1000);
    const controller = new AbortController();
    const response = await budget.fetch(request(controller.signal));
    const reading = response.text();
    controller.abort(new Error("Caller cancelled"));
    await expect(reading).rejects.toThrow("Caller cancelled");
  });

  it("bounds an operation by the job slice and reserves a full mutation deadline", async () => {
    const budget = new Budget(5, async () => slowBody(), 1000);
    budget.startSlice(30);
    expect(() => budget.requireTime(1000)).toThrow(JobDeadlineError);
    await expect((await budget.fetch(request())).text()).rejects.toThrow(JobDeadlineError);
  });
});
