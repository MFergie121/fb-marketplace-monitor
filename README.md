# Facebook Marketplace Monitor MVP

Local Node.js/TypeScript sentinel for Facebook Marketplace deal-hunting.

## What it does

- Uses Playwright with a dedicated Chrome profile at:
  - `/Users/maxfergie/.openclaw/browser-profiles/fb-marketplace-monitor`
- Reads config-driven Marketplace search profiles from JSON
- Collects visible listing cards from Marketplace search pages
- Stores runs, listings, observations, and digest previews in SQLite
- Scores listings deterministically with explicit reason codes
- Generates Discord-friendly digest text for later delivery integrations
- Detects suspicious empty runs and enforces a simple run lock
- Supports a mock-data path so the full digest pipeline can be tested without live scraping

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

## Manual run commands

Live scrape:

```bash
npm run run
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

## Outputs

- SQLite DB: `runtime/fbm.sqlite`
- Latest digest preview: `runtime/latest-digest.txt`
- Generated digest copies are also stored in `notifications` for later integration work.

## Suspicious-empty logic

A profile is marked suspicious-empty when:

- the current run sees zero items, and
- at least one recent run for that profile had non-zero observations.

If the number of suspicious profiles hits `FBM_SUSPICIOUS_EMPTY_MIN_PROFILES`, the run status is set to `suspicious_empty`.

## Notes / limitations

- Collector intentionally targets visible listing cards only for MVP safety and simplicity.
- Marketplace DOM changes may require selector tuning.
- Seller/description fields are mostly unavailable from search cards and are stored when present in mock data or visible card text.
