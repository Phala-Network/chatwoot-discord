import { readStoredConfig } from "../../../shared/stored-config.ts";
import { configSchema } from "../src/config.ts";

export function storedConfig(file: string | URL): { key: string; value: string } {
  return readStoredConfig(file, configSchema);
}
