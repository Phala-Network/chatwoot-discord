import { storedConfig } from "chatwoot-router/stored-config";

export const configKey: string = storedConfig(new URL("config.jsonc", import.meta.url)).key;
