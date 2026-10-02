import { settingsLoader } from "../../../shared/settings.ts";
import { parseSettings, type Settings } from "./config.ts";
import type { Env } from "./env.ts";

export const loadSettings = settingsLoader<Env, Settings>(parseSettings);
