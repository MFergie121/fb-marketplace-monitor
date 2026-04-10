# Facebook Marketplace Monitor MVP

Local Node.js/TypeScript monitor for Facebook Marketplace deal-hunting.

The repo now has an explicit **two-pipeline shape**:

1. **Pipeline 1 — topic → augmentation → catalog generation**
   - topic definitions live in `config/topics/`
   - catalog output is written to `runtime/topic-catalog.json`
   - the catalog is first-class, inspectable, and stores query terms, valuation refs, exclusions, and topic metadata
2. **Pipeline 2 — scheduled/live run → load catalog → Marketplace search → evaluation → buyer digest**
   - the runtime loads the stored catalog by default
   - collector/scoring/digest logic stays mostly unchanged
   - buyer-facing digest output stays separate from debug/internal digests

For the current POC, the default runtime scope is still a single premium golf topic in Melbourne: **premium drivers**. The difference now is that the active topic is selected explicitly via `config/topics/selection.json`, so switching to something else (for example **premium ski helmets**) no longer requires repo surgery.

## What it does

- Uses Playwright with a dedicated Chrome profile
- Reads either:
  - a generated topic catalog (`runtime/topic-catalog.json`) by default, or
  - a legacy static profile config (`config/search-profiles.json`) when explicitly requested
- Treats topics/catalog as the source of truth for runtime search inputs
- Collects Marketplace listing cards and lightly enriches a shortlisted subset
- Scores listings deterministically with explicit reason codes
- Applies valuation refs, heuristics, and local DB baselines
- Generates:
  - buyer-facing Discord/email digest previews
  - separate debug Discord/email digest previews
- Stores runs, observations, digest-candidate snapshots, and notification previews in SQLite
- Supports mock runs for safe end-to-end verification
- Supports 4-hour collection runs plus one daily aggregated buyer digest artifact for Discord delivery

## Repo layout

- `config/topics/all-topics.json` — main Pipeline 1 input containing multiple topic definitions
- `config/topics/selection.json` — explicit current topic selection (`topicPath` + `activeTopicIds`)
- `config/topics/golf-premium-topic.json` — older golf-only topic file kept for reference / focused experiments
- `runtime/topic-catalog.json` — Pipeline 1 output / Pipeline 2 input
- `config/search-profiles.json` — legacy static config path
- `src/topics/catalog.ts` — topic + catalog loading/build logic
- `src/topics/selection.ts` — selection file loading
- `src/run/runMonitor.ts` — runtime execution pipeline
- `runtime/latest-digest*.txt` — latest buyer/debug outputs

## Setup

```bash
npm install
cp .env.example .env
npm run db:init
```

Optional first-time browser setup:

1. Run a non-headless monitor command.
2. Facebook may ask for login/checkpoints.
3. Complete login manually in the dedicated browser profile.
4. Reuse that profile on later runs.

## Configuration

Environment variables are documented in `.env.example`.

Important paths:

- `FBM_TOPIC_SELECTION_PATH=./config/topics/selection.json`
- `FBM_TOPIC_PATH=./config/topics/all-topics.json` (optional override; normally the selection file points here)
- `FBM_CATALOG_PATH=./runtime/topic-catalog.json`
- `FBM_CONFIG_PATH=./config/search-profiles.json` (legacy mode only)

POC-default runtime controls:

- `FBM_ACTIVE_TOPIC_IDS=premium-drivers` can override selection-file defaults when you want a temporary CLI/env switch
- `FBM_MAX_QUERY_VARIANTS_PER_PROFILE=3` caps breadth to the highest-signal variants first
- `FBM_STOP_AFTER_COLLECTED_COUNT=18` stops a profile early once enough cards are collected
- `FBM_MAX_LISTINGS_PER_PROFILE=24` and `FBM_DETAIL_ENRICHMENT_TOP_N=3` keep the run bounded without making the buyer digest noisy
- `FBM_DAILY_DIGEST_DISCORD_CHANNEL_ID=1487057203105108000` pins the intended Discord delivery target for the once-daily digest artifact

## Topic selection: explicit and inspectable

The default selection lives in `config/topics/selection.json`:

```json
{
  "version": 1,
  "topicPath": "./config/topics/all-topics.json",
  "activeTopicIds": ["premium-drivers"]
}
```

That means the monitor can now keep one shared topic-definition file with multiple topics inside it, while the current active topic stays obvious.

Useful commands:

```bash
npm run topics:list
npm run topics:list -- --topic-id ski-helmets-premium
```

Examples:

- run the default golf POC: keep `activeTopicIds` as `premium-drivers`
- switch to ski helmets: edit `config/topics/selection.json` to `"activeTopicIds": ["ski-helmets-premium"]`
- run the custom query container as a group: use `--topic-id custom`
- target a single custom subtopic directly: use `--topic-id custom-driving-irons` (or another generated custom topic id)
- do a one-off without editing files: pass `--topic-id ski-helmets-premium` or `--topic-ids premium-drivers,premium-putters`

## Pipeline 1: build the catalog

Generate the inspectable catalog from the selected topic definition file and active topic ids:

```bash
npm run catalog:build
```

Or point at a custom topic file explicitly:

```bash
npm run catalog:build -- --topic ./config/topics/all-topics.json --out ./runtime/topic-catalog.json
```

Override the active scope when you want a broader or different slice:

```bash
npm run catalog:build -- --topic-id ski-helmets-premium
npm run catalog:build -- --topic-ids premium-drivers,premium-putters
```

This writes a JSON catalog containing:

- topic ids / labels
- stored primary + expansion queries
- brands / model families
- required keywords
- exclusions
- valuation references
- group ids (so a container like `custom` can fan out into multiple focused runtime profiles)
- topic metadata and generated timestamp

## Pipeline 2: run the monitor

Default runtime path: load stored catalog and run. By default this is still the **single-topic premium-drivers POC path**, but now that default comes from the explicit selection file.

```bash
npm run run
```

Force a fresh topic-to-catalog build in-memory for the run:

```bash
npm run run:topic
```

Explicitly run from a stored catalog:

```bash
npm run run:catalog
```

Run a different current topic without editing code:

```bash
npm run run -- --topic-id ski-helmets-premium
npm run run -- --topic-ids premium-drivers,premium-irons,premium-putters
```

Legacy static-profile path:

```bash
npm run run:legacy
```

Single-profile diagnostic run:

```bash
npm run run -- --profile topic-premium-drivers --debug
```

Mock pipeline verification:

```bash
npm run run:mock
npm run run:mock -- --digest-format email
npm run daily:digest
```

Daily aggregation / digest generation:

```bash
# collect candidates on a normal run (live or mock)
npm run run

# build one digest from the current Melbourne day window
npm run daily:digest
npm run daily:digest -- --date 2026-04-10
```

## Backwards-compatible helper

If you still want plain generated search profiles for inspection, this command renders catalog-derived `profiles[]` JSON:

```bash
npm run research:build
```

Output: `runtime/research-generated-search-profiles.json`

## Validation

```bash
npm run check
npm run build
npm run topics:list
npm run catalog:build
npm run catalog:build -- --topic-id ski-helmets-premium
npm run run:mock
```

## Outputs

- SQLite DB: `runtime/fbm.sqlite`
- Stored catalog: `runtime/topic-catalog.json`
- Latest run digest preview: `runtime/latest-digest.txt`
- Discord digest preview: `runtime/latest-digest.discord.txt`
- Email digest preview: `runtime/latest-digest.email.txt`
- Debug Discord digest preview: `runtime/latest-digest.debug.discord.txt`
- Debug email digest preview: `runtime/latest-digest.debug.email.txt`
- Daily Discord digest preview: `runtime/daily-digest.discord.txt`
- Daily email digest preview: `runtime/daily-digest.email.txt`
- Daily digest metadata for downstream delivery: `runtime/daily-digest.meta.json`

## Notes / limitations

- Marketplace DOM changes may still require selector tuning.
- No direct Discord API sending is wired in this repo; instead it produces local buyer/debug/daily digest artifacts plus channel metadata ready for downstream OpenClaw delivery.
- Detail enrichment remains intentionally conservative.
- The default POC remains single-topic by design, but topic selection is now explicit and dynamic.
- `all-topics.json` currently includes premium golf topics plus a conservative Melbourne-focused premium ski helmets topic (Oakley / Giro / POC).
- Used protective gear is intentionally treated conservatively through tighter exclusions and valuation confidence.
