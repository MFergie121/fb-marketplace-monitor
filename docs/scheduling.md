# Scheduling the 4-hour collector + daily Discord digest

This repo now supports the two scheduler entry points needed for production-ish use:

1. `npm run run` — collect Marketplace listings, score them, and snapshot buyer-safe candidates into `digest_candidates`
2. `npm run daily:digest` — aggregate the current Melbourne day window into one Discord-ready digest artifact

## Recommended cron shape

Use **two cron jobs**:

```cron
# every 4 hours: refresh the catalog and collect the latest run
0 */4 * * * cd /Users/maxfergie/gizmos_projects/fb-marketplace-monitor && npm run catalog:build && npm run run >> runtime/cron-run.log 2>&1

# once daily at 7:30pm Melbourne: build the daily digest artifact
30 19 * * * cd /Users/maxfergie/gizmos_projects/fb-marketplace-monitor && npm run daily:digest >> runtime/cron-daily-digest.log 2>&1
```

## OpenClaw delivery follow-up

This repo intentionally does **not** post to Discord directly.

Instead, let OpenClaw own the outbound message step using the generated artifacts:

- channel id: `1487057203105108000`
- digest text: `runtime/daily-digest.discord.txt`
- metadata: `runtime/daily-digest.meta.json`

Clean pattern:

1. cron runs `npm run daily:digest`
2. an OpenClaw cron/task reads `runtime/daily-digest.discord.txt`
3. OpenClaw posts that content to Discord channel `1487057203105108000`

That keeps outbound delivery in the existing OpenClaw/Discord path while the project remains a safe generator of digest content.

## Notes

- Daily aggregation dedupes by `(listing, profile)` across the day window.
- If a listing surfaces in multiple 4-hour runs, the digest notes that it was seen repeatedly instead of spamming duplicates.
- `digest_candidates` preserves which run ids surfaced each item so later debugging remains possible.
