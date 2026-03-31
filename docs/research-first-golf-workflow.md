# Research-first golf Marketplace workflow

## Objective

Shift the golf monitor from a mostly hand-curated shopping list to a **research-led premium club scout**:

1. identify high-end newly released / up-and-coming club families worth watching
2. convert that thesis into deterministic Marketplace search profiles and valuation bands
3. run the normal collection / scoring / digest pipeline using those generated profiles
4. keep the process practical for repeat digests, not clever for clever's sake

## Relevant Gizmo Team roles

- **Product Lead** — redefine the job to “find premium golf resale opportunities”, not “search Max's old wish list”
- **Tech Lead** — design a local deterministic pipeline that can be regenerated and audited

## New workflow

### Step 1 — Research seed
A local JSON catalog (`config/golf-research-catalog.json`) acts as the research agent's working memory.

It stores:
- premium club segments (drivers / irons / putters)
- current or up-and-coming model families
- Marketplace query phrases
- expected used-market value bands
- accessory exclusions so premium-brand junk does not flood the digest

This is intentionally deterministic and editable by hand.

### Step 2 — Compile research into monitor profiles
`src/research/buildResearchConfig.ts` turns the research catalog into normal monitor `profiles`.

The compiler generates, per segment:
- brands
- model families
- required high-signal keywords
- search expansions
- valuation references
- min / max price bands
- unwanted keywords

This means the monitor still runs through the same proven collector/scoring stack, but the source of truth is now a research thesis instead of a static manual wish list.

### Step 3 — Run the normal monitor
The existing run path executes against the generated config.

That preserves:
- collection
- shortlist enrichment
- listing-type classification
- valuation logic
- digest generation
- SQLite history / local baselines

## Why this is better

### Product improvements
- better aligned with Max's actual intent: premium newer clubs, not random golf clutter
- more discoverable: searches are based on club families and release cycles
- easier to maintain: update a family/value band once, then regenerate profiles
- easier to trust: the thesis is visible in one file

### Technical improvements
- no hidden AI magic required for every run
- deterministic outputs from a local catalog
- existing scoring and digest stack stay reusable
- future web-assisted research can update the catalog without rewriting the runtime pipeline

## Recommended ongoing operating model

### Weekly / ad hoc research refresh
Review and update:
- newly launched premium families
- stale families to demote or remove
- used price bands that have clearly moved

### Daily runs
Use the research-generated profiles for digest runs.

### Future enhancement path
If wanted later, add a separate one-shot web-assisted research command that proposes catalog updates, but keep the runtime digest path local and deterministic.

## First practical version implemented

Implemented in this repo:
- `config/golf-research-catalog.json`
- `src/research/buildResearchConfig.ts`
- CLI support to preview or run using research-generated config

This is the right first cut: useful now, not overengineered, and much less likely to drown Max in premium-branded headcovers pretending to be deal flow.
