// SOURCE-ONLY frozen shell, deployed only AFTER externally fenced admission and settled
// old requests/alarms. Preserve Worker name, Hub namespace/lifecycle and private backup.
// This retires the old executor WITHOUT migrating or dropping its schema9 source tables.
// Stock 0.27 has no export RPC. A separate reviewed maintenance deployment is required.
import { Hub as FrozenHub } from "chatwoot-discord-relay";
export class Hub extends FrozenHub {}
export default {
  fetch() {
    return new Response("Maintenance", { status: 503 });
  },
};
// Bind LEGACY_EXPORT_BOUNDARY={sourceIdentity:<actual Hub DO id>,epoch:<cut epoch>,
// drainEvidence:<private immutable evidence reference>,frozen:true}. No cron or legacy
// admission handler. This config assertion cannot certify unsettled external requests.
