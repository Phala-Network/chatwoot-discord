import { storedConfig } from "chatwoot-discord-relay/stored-config";

export const configKey: string = storedConfig(new URL("config.jsonc", import.meta.url)).key;
