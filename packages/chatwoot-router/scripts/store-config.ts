#!/usr/bin/env node
import { storeConfig } from "../../../shared/store-config.ts";
import { storedConfig } from "./stored-config.ts";

storeConfig(storedConfig, "chatwoot-router-store-config");
