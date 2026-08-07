/**
 * `search` domain — registers the `bun-sqlite-search` experimental flag.
 */

import {
  type FlagDefinitionInput,
  registerFlagDefinition,
} from "#/app/flag/flagRegistry";

export const BUN_SQLITE_SEARCH_FLAG_ID = "bun-sqlite-search";
export const BUN_SQLITE_SEARCH_FLAG_ENV =
  "KIMI_CODE_EXPERIMENTAL_BUN_SQLITE_SEARCH";

export const bunSqliteSearchFlag: FlagDefinitionInput = {
  id: BUN_SQLITE_SEARCH_FLAG_ID,
  title: "Bun SQLite global search",
  description:
    "Use the agent-core-v2 SQLite-backed global search index instead of the kap-server minidb implementation.",
  env: BUN_SQLITE_SEARCH_FLAG_ENV,
  default: false,
  surface: "core",
};

registerFlagDefinition(bunSqliteSearchFlag);
