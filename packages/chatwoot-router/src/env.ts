import type { ConfigEnv } from "../../../shared/settings.ts";
import type { Router } from "./router.ts";

export interface Env extends ConfigEnv {
  ROUTER: DurableObjectNamespace<Router>;
  CHATWOOT_TOKEN: string;
  CHATWOOT_WEBHOOK_SECRETS: string;
  TYPESAFE_API_KEY: string;
  CHATWOOT_BOT_TOKENS?: string;
}
