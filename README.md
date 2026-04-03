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

For the current POC, the default topic set is premium golf in Melbourne.

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
- Stores runs, observations, and notification previews in SQLite
- Supports mock runs for safe end-to-end verification

## Repo layout

- `config/topics/golf-premium-topic.json` — Pipeline 1 input
- `runtime/topic-catalog.json` — Pipeline 1 output / Pipeline 2 input
- `config/search-profiles.json` — legacy static config path
- `src/topics/catalog.ts` — topic + catalog loading/build logic
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

- `FBM_TOPIC_PATH=./config/topics/golf-premium-topic.json`
- `FBM_CATALOG_PATH=./runtime/topic-catalog.json`
- `FBM_CONFIG_PATH=./config/search-profiles.json` (legacy mode only)

## Pipeline 1: build the catalog

Generate the inspectable catalog from topic definitions:

```bash
npm run catalog:build
```

Or point at a custom topic file:

```bash
npm run catalog:build -- --topic ./config/topics/golf-premium-topic.json --out ./runtime/topic-catalog.json
```

This writes a JSON catalog containing:

- topic ids / labels
- stored primary + expansion queries
- brands / model families
- required keywords
- exclusions
- valuation references
- topic metadata and generated timestamp

## Pipeline 2: run the monitor

Default runtime path: load stored catalog and run.

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
npm run catalog:build
npm run run:mock
```

## Outputs

- SQLite DB: `runtime/fbm.sqlite`
- Stored catalog: `runtime/topic-catalog.json`
- Latest digest preview: `runtime/latest-digest.txt`
- Discord digest preview: `runtime/latest-digest.discord.txt`
- Email digest preview: `runtime/latest-digest.email.txt`
- Debug Discord digest preview: `runtime/latest-digest.debug.discord.txt`
- Debug email digest preview: `runtime/latest-digest.debug.email.txt`

## Notes / limitations

- Marketplace DOM changes may still require selector tuning.
- No live Discord or Gmail sending is wired yet; this repo currently produces local buyer/debug digest artifacts ready for downstream delivery.
- Detail enrichment remains intentionally conservative.
- The default POC topic file is golf-focused, but the catalog structure is set up for additional topics later.
