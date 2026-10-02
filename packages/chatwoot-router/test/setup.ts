import { afterEach, expect } from "vitest";
import { takeUnmatched } from "./helpers.ts";

// Every request a test makes is answered by one of its routes: an expected failure is mocked as one.
afterEach(() => {
  expect(takeUnmatched(), "requests no mocked route answered").toEqual([]);
});
