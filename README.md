# Facebook Marketplace Monitor MVP

Local Node.js/TypeScript sentinel for Facebook Marketplace deal-hunting.

## What it does

- Uses Playwright with a dedicated Chrome profile at:
  - `/Users/maxfergie/.openclaw/browser-profiles/fb-marketplace-monitor`
- Reads config-driven Marketplace search profiles from JSON
- Collects visible listing cards from Marketplace search pages
- Applies lightweight parsing heuristics to separate title, price, and location from card text
- Stores runs, listings, observations, and digest previews in SQLite
- Scores listings deterministically with explicit reason codes
- Penalises obvious placeholder/bait prices like `$1`, `Free`, or synthetic numeric placeholders such as `1234`
- Generates Discord-friendly digest text for later delivery integrations, including title-confidence and parser risk flags
- Detects suspicious empty runs and enforces a simple run lock
- Supports a mock-data path so the full digest pipeline can be tested without live scraping
- Emits step-level run logs so browser launch / profile progress / digest generation are visible during live runs

## Security / operational notes

- No Facebook password handling is implemented.
- Login should happen manually inside the dedicated Chrome profile.
- Data retention defaults to 30 days for observations, runs, and generated notification previews.
- No live Discord/WhatsApp sending is included in this MVP.

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
      "maxPrice": 1200,
      "keywords": ["driver", "irons"],
      "locationLabel": "Melbourne"
    }
  ]
}
```

Useful runtime knobs:

- `FBM_DEBUG=true` enables verbose progress logs.
- `FBM_PROFILE_TIMEOUT_MS=90000` caps how long one profile can hang before the run continues as `partial`.
- `FBM_RUN_TIMEOUT_MS=300000` caps total run time.

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
- digest generation
- run finished / lock released

If a profile stalls, the monitor should now fail that profile after `FBM_PROFILE_TIMEOUT_MS`, log the reason, and finish the overall run with `status=partial` instead of appearing silently frozen forever.

## Outputs

- SQLite DB: `runtime/fbm.sqlite`
- Latest digest preview: `runtime/latest-digest.txt`
- Generated digest copies are also stored in `notifications` for later integration work.

Digest rows now include:

- parsed title-confidence (`high`, `medium`, `low`)
- risk flags for weak titles / placeholder pricing
- raw scoring reason codes so weak parses are visible instead of quietly ranking as strong finds
- failed-profile summaries when a live scrape partially succeeds

## Suspicious-empty logic

A profile is marked suspicious-empty when:

- the current run sees zero items, and
- at least one recent run for that profile had non-zero observations.

If the number of suspicious profiles hits `FBM_SUSPICIOUS_EMPTY_MIN_PROFILES`, the run status is set to `suspicious_empty`.

## Notes / limitations

- Collector intentionally targets visible listing cards only for MVP safety and simplicity.
- Marketplace DOM changes may still require selector tuning.
- Seller/description fields are mostly unavailable from search cards and are stored when present in mock data or visible card text.
- Parsing heuristics are deliberately lightweight; low-confidence rows are flagged rather than silently treated as trustworthy.
- Per-profile timeouts reduce silent hangs, but a browser engine failure before launch can still fail the whole run early.
