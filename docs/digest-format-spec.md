# Digest Format Spec

## Goals

Create a consistently scannable digest format for Discord and email that:
- highlights top opportunities first
- makes listing type and confidence visually obvious
- clearly distinguishes between attractive/fair/overpriced/withheld valuation states
- keeps bundle/accessory ambiguity from reading like strong conviction
- is compact enough for repeated daily use

---

## Discord digest format

Use plain bullets and emoji badges. No markdown tables.

### Header

```text
FB MARKETPLACE DIGEST
Profile: {profile_name}
Run: {run_time_local}
Searches used: {search_variant_summary}
Seen: {seen_count} • Enriched: {enriched_count} • Strong candidates: {strong_count}
```

### Legend

```text
Legend
🟢 strong deal   🟡 possible deal   ⚪ fair / relevant   🔴 overpriced   ⚫ withheld / uncertain
🎯 single item   📦 bundle / set    🧩 accessory / mod   ❓ ambiguous
✅ high confidence   ☑️ medium confidence   ⚠️ low confidence
```

### Sections

1. 🔥 Top picks
2. 👀 Worth checking
3. 📦 Bundles / sets
4. 🚫 Withheld / uncertain
5. 🧠 Run notes

### Item block

```text
1) 🟢 TaylorMade QI10 LS Driver 10.5 Stiff
- 💰 Price: $400
- 🏷️ Type: 🎯 Single item
- 📍 Location: Melbourne
- 🧠 Confidence: ✅ High
- 📊 Value: Fair
- 📈 Est. range: $350–$450
- 📝 Why it matters: premium driver, exact model-family match, clean single-item listing
- ⚠️ Watch-outs: none obvious
- 🔗 <listing_url>
```

### Style rules

- Put top 3-5 only in 🔥 Top picks
- Put next 3-5 in 👀 Worth checking
- Only show notable bundles in 📦 Bundles / sets
- Only show the most useful withheld rows in 🚫 Withheld / uncertain
- Keep "Why it matters" to one line
- Keep "Watch-outs" brutally honest
- Show estimated range only when valuation is not withheld

---

## Email digest format

Email can be slightly more verbose, but still compact and skimmable.

### Subject line

```text
Marketplace Digest — Golf clubs — {date} — {top_summary}
```

Example:

```text
Marketplace Digest — Golf clubs — 31 Mar — 2 attractive drivers, 1 fair bundle
```

### Email body structure

```text
FB MARKETPLACE DIGEST
Profile: {profile_name}
Run: {run_time_local}
Searches used: {search_variant_summary}
Seen: {seen_count} | Enriched: {enriched_count} | Strong candidates: {strong_count}

Legend
🟢 strong deal | 🟡 possible deal | ⚪ fair / relevant | 🔴 overpriced | ⚫ withheld / uncertain
🎯 single item | 📦 bundle / set | 🧩 accessory / mod | ❓ ambiguous
✅ high confidence | ☑️ medium confidence | ⚠️ low confidence

TOP PICKS
{top pick blocks}

WORTH CHECKING
{worth checking blocks}

BUNDLES / SETS
{bundle blocks}

WITHHELD / UNCERTAIN
{withheld blocks}

RUN NOTES
- {note 1}
- {note 2}
- {note 3}
```

### Email item block

```text
1) 🟢 Callaway Rogue ST MAX Driver 10.5 RH — head only + headcover
   Price: $260
   Type: 🎯 Single item
   Location: Melbourne
   Confidence: ✅ High
   Value: Attractive
   Est. range: $407–$584
   Why it matters: strong Callaway driver match, cheap relative to current premium-driver reference band
   Watch-outs: head-only listing; compare against head-only market where possible
   Link: https://...
```

### Style rules

- Email should include slightly more explanatory text than Discord
- Keep one blank line between item blocks
- Avoid markdown tables
- Prefer plain text with consistent labels for compatibility
- If valuation is withheld, replace "Est. range" with "Valuation: withheld"

---

## Ranking / grouping rules

### Top picks
Use for listings that are:
- single-item OR very clearly decomposable bundles
- medium/high confidence
- attractive or strong deal

### Worth checking
Use for listings that are:
- fair but highly relevant
- attractive with one meaningful caveat
- useful benchmark listings

### Bundles / sets
Use for listings that are:
- classified bundle_or_set
- decomposed enough to discuss honestly
- not noisy enough to discard outright

### Withheld / uncertain
Use for listings that are:
- from-price / each / variant-choice
- accessory/service/modification
- ambiguous identity
- valuation withheld or low-confidence only

---

## Content principles

- Never make withheld valuation look like a near-deal
- Never present bundle valuation with the same confidence language as a clean single-item comp
- Always surface watch-outs when confidence is below high
- Prefer honest caution over fake precision
- If in doubt, mark as ⚫ withheld / uncertain
