// Build-only fixture: retain just the original Hub lifecycle for the source bridge.
import { bindings, defineConfig, defineWorker, exports } from "cf/config";
import * as entrypoint from "./index.ts" with { type: "cf-worker" };

const worker = defineWorker({
  name: "legacy-source-bridge-test",
  workersDev: false,
  previewUrls: false,
  entrypoint,
  compatibilityDate: "2026-08-15",
  exports: { Hub: exports.durableObject({ storage: "sqlite" }) },
});
export default defineConfig({
  worker: { ...worker, env: { HUB: bindings.durableObject({ worker, exportName: "Hub" as const }) } },
});
