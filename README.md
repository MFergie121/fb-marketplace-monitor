# Facebook Marketplace Monitor MVP

Local Node.js/TypeScript sentinel for Facebook Marketplace deal-hunting.

## What it does

- Uses Playwright with a dedicated Chrome profile at:
  - `/Users/maxfergie/.openclaw/browser-profiles/fb-marketplace-monitor`
- Reads config-driven Marketplace search profiles from JSON
- Supports controlled per-profile search augmentation via named query expansions
- Supports high-signal profile targeting with optional `requiredAnyKeywords` gates so broad searches can still prefer premium models rather than generic category junk
- Collects visible listing cards from Marketplace search pages
- Shortlists a small configurable top-N per profile and opens detail pages to capture richer fields, especially description text
- Stores runs, listings, observations, and digest previews in SQLite
- Scores listings deterministically with explicit reason codes
- Classifies listings as single-item, bundle/set, accessory/service/modification, or ambiguous
- Adds valuation-aware scoring using manual references, category heuristics, and lightweight local DB baselines
- Prevents single-item comps from being applied to bundles; fuzzy bundles get downgraded/withheld instead of fake precision
- Penalises noisy patterns such as placeholder prices, `from $X`, `each`, quick-sale language, bulk/mixed bundles, and profile-configured unwanted variants
- Boosts exact brands, configured model families, cleaner single-item listings, and relevant spec cues found in title or description
- Generates mobile-friendly plain-text digests for both Discord and email, with compact labeled blocks, sectioned ranking, and cleaner link placement for phone reading
- Detects suspicious empty runs and enforces a simple run lock
- Supports a mock-data path so the full digest pipeline can be tested without live scraping
- Emits step-level run logs so browser launch / profile progress / enrichment / digest generation are visible during live runs

## Security / operational notes

- No Facebook password handling is implemented.
- Login should happen manually inside the dedicated Chrome profile.
- Data retention defaults to 30 days for observations, runs, and generated notification previews.
- No live Discord/WhatsApp sending is included in this MVP.
- Detail enrichment is intentionally conservative: only a small shortlist per profile is opened.

## Setup

```bash
npm install
cp .env.example .env
cp config/search-profiles.example.json config/search-profiles.json
npm run db:init
```

Optional first-time browser setup:

1. Run a non-headless monitor command.
2. Facebook may prompt for login/checkpoints.
3. Complete login manually in the dedicated profile window.
4. Reuse that browser profile on later runs.

## Configuration

Environment variables are documented in `.env.example`.

Search profiles live in `config/search-profiles.json`:

```json
{
  "profiles": [
    {
      "id": "golf-clubs-demo",
      "label": "Golf clubs",
      "url": "https://www.facebook.com/marketplace/melbourne/search?query=golf%20clubs",
      "enabled": true,
      "category": "sporting-goods",
      "brandPreferences": ["TaylorMade", "Titleist"],
      "modelFamilies": ["Stealth", "Paradym", "G430"],
      "requiredAnyKeywords": ["stealth", "paradym", "g430"],
      "keywords": ["driver", "irons"],
      "unwantedKeywords": ["kids", "junior", "women's", "ladies"],
      "maxPrice": 1200,
      "locationLabel": "Melbourne",
      "searchExpansions": [
        { "label": "premium drivers", "query": "taylormade ping callaway driver" },
        { "label": "iron sets", "query": "golf iron set" }
      ]
    }
  ]
}
```

`searchExpansions` are optional extra Marketplace queries that roll back into the same profile. They are intentionally explicit and finite — no automatic synonym explosion.

`requiredAnyKeywords` is an optional high-signal gate: if none of those terms appear in the listing title/description, the listing is heavily downgraded even if it matched broad category keywords. This is useful for keeping profiles broad enough to discover deals while avoiding random low-end or generic inventory.

### Valuation references

Each profile can optionally define `valuationReferences` to anchor known used-market bands for important models. This is the main MVP path for golf:

```json
{
  "label": "Ping G430 driver",
  "matchTerms": ["ping", "g430", "driver"],
  "priceLow": 450,
  "priceHigh": 650,
  "confidence": "high",
  "notes": "Premium current-generation Ping driver range",
  "listingTypeScope": "single_item"
}
```

Use `listingTypeScope` to keep references honest:

- `single_item`: safe for individual items only
- `bundle_or_set`: safe for recognisable bundles/sets only
- `any`: rare escape hatch if a reference genuinely applies to both

How valuation works:

- listing classification runs first: `single_item`, `bundle_or_set`, `accessory_service_modification`, or `ambiguous`
- `valuationReferences`: strongest signal when a known model/category match exists, filtered by `listingTypeScope`
- category heuristics: fallback used-value bands for `golf`, `skis`, `ski-goggles`, and `ski-helmet`
- local observed baseline: lightweight median-based band from similar historical observations already in SQLite, but only from prior observations with the same listing type
- bundle/set valuation only proceeds when the bundle is identifiable enough and a bundle-safe reference / heuristic / baseline exists
- final digest output explains which sources were used and whether the price looks `attractive`, `fair`, `uncertain`, `overpriced`, or `withheld`

Useful runtime knobs:

- `FBM_DEBUG=true` enables verbose progress logs.
- `FBM_PROFILE_TIMEOUT_MS=90000` caps how long one profile can hang before the run continues as `partial`.
- `FBM_RUN_TIMEOUT_MS=300000` caps total run time.
- `FBM_DETAIL_ENRICHMENT_TOP_N=5` controls how many shortlisted listings per profile get detail-page enrichment.
- `FBM_DETAIL_WAIT_MS=2500` controls how long the detail page gets to settle before extraction.

## Manual run commands

Live scrape:

```bash
npm run run
```

Verbose live scrape:

```bash
npm run run -- --debug
```

Single-profile diagnostic run:

```bash
npm run run -- --profile golf-clubs-demo --debug
```

Mock pipeline test:

```bash
npm run run:mock
```

Render the mock digest in email-friendly format:

```bash
npm run run:mock -- --digest-format email
```

Build / type-check:

```bash
npm run build
npm run check
```

## What you should now see during a live run

Typical progress logging includes:

- startup / config loaded
- DB opened / run lock acquired
- browser launch starting / browser launched
- each profile starting / completed / failed / item count
- detail shortlist count and enrichment count per profile
- digest generation
- run finished / lock released

If a profile stalls, the monitor should fail that profile after `FBM_PROFILE_TIMEOUT_MS`, log the reason, and finish the overall run with `status=partial` instead of appearing silently frozen forever.

## Outputs

- SQLite DB: `runtime/fbm.sqlite`
- Latest digest preview in the selected CLI format: `runtime/latest-digest.txt`
- Discord digest preview: `runtime/latest-digest.discord.txt`
- Email digest preview: `runtime/latest-digest.email.txt`
- Generated digest copies are also stored in `notifications` for later integration work (Discord preview payload).

Digest output now includes:

- separate Discord and email plain-text renderers
- compact sectioned ranking (`TOP PICKS`, `WORTH CHECKING`, `BUNDLES / SETS`, `WITHHELD / UNCERTAIN`)
- short labeled item blocks optimised for phone scanning
- listing type, confidence, valuation, price, location, watch-outs, and link on every row
- trailing `Link:` lines so raw URLs do less visual damage in email
- compact summary/header lines plus failed-profile / suspicious-empty notes when relevant

## Suspicious-empty logic

A profile is marked suspicious-empty when:

- the current run sees zero items, and
- at least one recent run for that profile had non-zero observations.

If the number of suspicious profiles hits `FBM_SUSPICIOUS_EMPTY_MIN_PROFILES`, the run status is set to `suspicious_empty`.

## Notes / limitations

- Collector still starts from visible listing cards; enrichment only follows a short scored shortlist.
- Marketplace DOM changes may still require selector tuning.
- Detail extraction uses lightweight page-text heuristics and stores only low-risk visible fields such as description, condition, seller name, and location.
- Parsing/scoring heuristics are deliberately deterministic and explainable rather than clever-magic.
- Per-profile timeouts reduce silent hangs, but a browser engine failure before launch can still fail the whole run early.
