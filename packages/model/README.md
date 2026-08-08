# Model catalog

`@kimi-next/model` combines a checked-in [models.dev](https://models.dev) snapshot with
hand-tuned profiles for transports kimi-next actually wires today.

## Layout

- `src/catalog-snapshot.json` — slim offline snapshot (refresh with the script below).
- `src/hand-profiles.ts` — curated overrides (transport, replay rules, reasoning).
- `src/catalog.ts` — merges snapshot entries with hand profiles (hand wins on id clash).

Stable kimi-next ids use `provider/model`; `wireModel` is what adapters send on the wire.

## Refreshing the snapshot

```bash
node packages/model/scripts/refresh-catalog.mjs
```

Fetches `https://models.dev/api.json` by default (`MODELS_DEV_CATALOG_URL` to override),
includes all currently published models from first-party providers (`openai`, `anthropic`,
`google`, `moonshotai`, and `xai`), drops only `deprecated` models, and rewrites
`src/catalog-snapshot.json`. Exits non-zero with a message when the network request or JSON
parse fails.

After refreshing, run the model package tests and update `hand-profiles.ts` when a model
needs a non-default transport. The script uses provider SDK metadata and an optional
models.dev `api` field to infer transports; hand profiles remain the place for kimi-next
specific replay or transport overrides.

## Prompt cache hit levers

Provider-side prompt caching (OpenAI `prompt_cache_key`, Anthropic cache breakpoints, etc.)
only helps when the **serialized prefix** of a request is byte-stable across turns.

Practical levers:

1. **Stable system prompt** — keep instructions identical; avoid timestamps, random ids, or
   per-turn dynamic prose in the system block.
2. **Stable `tools[]`** — declare tools in a fixed order with unchanged names, descriptions,
   and JSON schemas. Adding, removing, or rewriting a tool invalidates the cached prefix.
3. **`prompt_cache_key` / `cacheKey`** — pass a stable session- or workspace-scoped key via
   request `parameters.cacheKey` or adapter `promptCacheKey` (OpenAI adapters serialize this as
   `prompt_cache_key`). Use the same key for turns that should share a cache bucket.
4. **Avoid rewriting prefixes** — do not reorder messages, rename tools mid-session, or inject
   variable content before the cached region (system + tools + early history).

Monitor `cachedInputTokens` on usage events to confirm cache hits in production.
