// `env` from "cloudflare:workers" (the tests use it) carries the Worker's bindings (see env.ts).

import type { Env as WorkerEnv } from "./env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
