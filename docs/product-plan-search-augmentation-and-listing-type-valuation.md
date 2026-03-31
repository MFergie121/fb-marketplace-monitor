# Product Plan: Controlled Search Augmentation + Listing-Type-Aware Valuation

## Problem statement

The monitor is good at finding obvious matches for a single search query, but it still behaves too literally:

- it can miss relevant listings that use adjacent wording rather than the exact query Max configured
- it can overvalue bundles, mixed lots, accessories, or vague set listings by comparing them to single-item comps
- the digest currently makes some bundle-looking listings appear cleaner and more comparable than they really are

For Max, that creates the worst kind of operator pain: false confidence. A personal deal-hunting tool does not need perfect marketplace intelligence; it needs to avoid telling him a random mixed bag of gear is a bargain because it accidentally matched a premium single-item reference.

## Target user

Max, acting as a single operator scanning Marketplace for personal buying opportunities.

This is **not** a multi-user product and does **not** need marketplace-grade taxonomy. It just needs to surface likely wins, clearly label messy listings, and avoid dumb valuation mistakes.

## Jobs to be done

1. **Find more relevant listings without exploding noise**
   - Search using a controlled set of related terms over time, not just one literal query.
2. **Understand what kind of listing this is**
   - Distinguish single item vs bundle/set/accessory/parts/mixed lot/wanted ad.
3. **Value like-for-like**
   - Compare individual items against individual-item comps.
   - Only value bundles when the bundle can be decomposed into identifiable components with credible value anchors.
4. **Make the digest trustworthy at a glance**
   - Show why something is attractive, uncertain, or intentionally not valued.

## Product shape

### 1) Search profile becomes a monitored intent, not just one URL

Each profile should represent a buying intent (for example: `Ping driver`, `ski helmet`, `golf clubs`) and support a small controlled query set:

- **primary query**: the main search phrase
- **augmented queries**: adjacent phrases/synonyms/model-family variants
- **query rotation policy**: do not fire every possible term every run; rotate them across runs to limit noise and duplication
- **per-query role**: `core`, `expansion`, or `exploratory`

Example for `Ping driver`:

- core: `ping driver`
- expansion: `ping g430 driver`, `ping g425 driver`, `ping golf driver`
- exploratory: `ping woods`, `ping club driver`

The point is controlled recall improvement, not autonomous keyword sprawl.

### 2) Listing-type classification becomes a first-class step before valuation

Before scoring value, each listing should get a **listing type** classification based on title, price wording, description, and detected entities.

Initial MVP types:

- `single_item`
- `bundle`
- `set`
- `accessory`
- `parts_or_repair`
- `mixed_lot`
- `from_price_or_each`
- `wanted_or_swap`
- `unknown`

Notes:

- `set` is distinct from `bundle` when the set is the natural sold unit for the category (for example an iron set).
- `bundle` means multiple meaningful items sold together where the comparison target is not a normal single-item comp.
- `accessory` covers bags, shafts, covers, extenders, lenses-only, etc.

### 3) Valuation path depends on listing type

#### A. Single item

If classified as `single_item`:

- compare against single-item references/baselines only
- allow strong valuation labels (`attractive`, `fair`, `overpriced`) when confidence is sufficient

#### B. Natural set

If classified as `set` and the profile/category normally trades as sets (for example iron sets, ski + binding package if treated as standard), then:

- compare against set-level references if available
- otherwise keep valuation conservative

#### C. Bundle

If classified as `bundle`:

- **do not** compare the whole listing against a single premium item reference
- first attempt bundle decomposition into identifiable components
- only produce a bundle valuation when:
  - at least 2 meaningful components can be identified, and
  - components map to credible value references/baselines, and
  - enough of the bundle value is explained by those components

If those conditions are not met:

- downgrade valuation confidence sharply, or
- withhold valuation entirely and say why

#### D. Accessory / mixed / ambiguous listings

For `accessory`, `mixed_lot`, `from_price_or_each`, `wanted_or_swap`, `unknown`:

- avoid confident bargain claims
- either value against the correct accessory class or mark `valuation withheld` / `uncertain`
- keep them searchable in the digest, but de-prioritise them

## MVP recommendation

### MVP goal

Make the monitor noticeably smarter **without making it autonomous or brittle**.

### In scope for MVP

#### 1) Controlled search augmentation

Add config support for a bounded query set per profile:

Suggested config shape:

```json
{
  "id": "ping-driver",
  "label": "Ping driver",
  "category": "golf",
  "searchTerms": {
    "primary": ["ping driver"],
    "expanded": ["ping g430 driver", "ping g425 driver", "ping golf driver"],
    "exploratory": ["ping woods"]
  },
  "maxTermsPerRun": 2,
  "dedupeKey": "marketplace_listing_id"
}
```

MVP behaviour:

- always run the primary term
- add up to 1 additional rotated term per run
- dedupe listings across terms before scoring/enrichment
- track which term surfaced the listing first

This gives recall improvement without tripling browser time or flooding Max with repeats.

#### 2) Lightweight listing-type classifier

Implement deterministic rules first, not an LLM-heavy classifier.

High-signal indicators:

- bundle/set words: `set`, `bundle`, `bag and clubs`, `with bag`, `includes`, `full kit`, `lot`
- accessory words: `bag`, `cover`, `shaft`, `headcover`, `goggles lens`, `extension`, `cutdown`
- ambiguous sale words: `from`, `each`, `starting at`
- parts words: `parts`, `repair`, `broken`, `spares`
- wanted/swap words: `wanted`, `WTB`, `swap`, `trade`
- single-item cues: clear singular model + item noun like `Ping G430 driver`

Output for MVP:

- `listingType`
- `listingTypeConfidence`
- `listingTypeReasons`

#### 3) Type-aware valuation rules

MVP valuation policy:

- `single_item` -> normal valuation path
- `set` -> use set refs when available; else conservative/uncertain
- `bundle` -> decomposition attempt
- `accessory`, `mixed_lot`, `from_price_or_each`, `wanted_or_swap` -> withhold or downgrade valuation by default

#### 4) Bundle decomposition, but only shallowly

Do **not** build a general bundle-pricing engine yet.

MVP decomposition should only support cases where the title/description clearly exposes components, for example:

- `TaylorMade Sim2 Max irons, Cobra driver and Callaway bag`
- `skis with bindings and boots`

MVP decomposition rules:

- extract up to 3 named components
- map each component to a category/model reference where possible
- compute an explainable estimated component sum/range
- only emit bundle value if explained coverage is high enough (for example 60%+ of likely bundle value)

Otherwise output:

- `Bundle detected; valuation withheld because components were not identified confidently enough.`

### Explicitly out of scope for MVP

- free-form AI generation of endless new search terms
- automatic per-user learning loops that mutate query strategy without review
- complex cross-category bundle optimisation
- seller-level trust scoring
- image-based classification
- trying to price every ambiguous listing at all costs

## Priority rules

When there is a tradeoff, use these rules in order:

1. **Do not mislead Max with false precision**
   - Withholding value is better than fake confidence.
2. **Single-item comps must not price bundles**
   - This is the core product guardrail.
3. **Controlled recall beats broad noisy recall**
   - Better to miss some fringe listings than flood the digest with junk.
4. **Deterministic and inspectable over clever-but-murky**
   - Max should be able to see why a listing was flagged as a bundle or uncertain.
5. **Digest quality matters more than raw scrape count**
   - The system exists to produce useful operator decisions, not search-engine vanity metrics.

## Digest changes

The digest should make listing type obvious before Max clicks.

### Proposed row format additions

Add these fields near title/price:

- `Type: Single item | Bundle | Set | Accessory | Mixed lot | From-price`
- `Valuation mode: Single-item comp | Set comp | Bundle decomposition | Withheld`
- `Valuation confidence: high/medium/low/withheld`

### Copy rules

#### For single items

Example:

- `Type: Single item`
- `Value: Attractive — 480 vs estimated 550-650 for Ping G430 driver`

#### For bundles with decomposition

Example:

- `Type: Bundle`
- `Value: Fair bundle — estimated component value 700-900 (Sim2 Max irons + older Cobra driver; bag excluded from pricing)`

Important: name the priced components and note excluded ones.

#### For bundles without credible decomposition

Example:

- `Type: Bundle`
- `Value: Withheld — bundle detected, but components are too mixed/vague for reliable pricing`

#### For accessory / from-price listings

Examples:

- `Type: Accessory`
- `Value: Withheld — accessory listing, not comparable to club listings`

- `Type: From-price`
- `Value: Uncertain — per-item/from-price wording makes total listing value unclear`

### Digest ordering rules

Within a profile digest, rank roughly as:

1. single items with attractive/fair high-confidence value
2. natural sets with credible set pricing
3. decomposable bundles with medium+ confidence
4. uncertain but still relevant listings
5. accessories / mixed lots / from-price noise

If needed, cap low-value noisy types in the digest so they do not dominate the output.

## Success criteria

MVP is successful if:

1. the monitor finds additional relevant listings from augmented terms **without** a major duplication/noise blowout
2. bundle-looking golf listings stop being priced as if they were single premium clubs
3. digest rows clearly tell Max what kind of listing he is looking at
4. valuation-withheld cases feel intentional and useful, not like system failure
5. Max can scan the digest and trust that `attractive` mostly means a like-for-like comparison

## Risks / open questions

### 1) Category ambiguity

Some categories naturally blur `set` vs `bundle`.

Recommendation: start with category-specific defaults only where obvious, especially golf.

### 2) Query overlap and duplicates

Augmented search terms will surface the same listing repeatedly.

Recommendation: dedupe by Marketplace item ID and preserve source-term provenance for debugging.

### 3) Bundle decomposition can get fiddly fast

If engineering tries to fully solve bundle pricing now, this will sprawl.

Recommendation: support only shallow, explicit decomposition in MVP.

### 4) More searches means longer runs

Recommendation: hard-cap added terms per run and rotate them. This is a personal operator tool, so consistency beats exhaustive coverage.

## Recommended implementation sequence

1. add config support for multi-term profile search with rotation + dedupe
2. add listing-type classifier output to the pipeline and digest
3. gate valuation by listing type
4. add shallow bundle decomposition for clear cases
5. tune score ordering so single-item opportunities rise above noisy bundles/accessories

## Product call

The right move is **not** “make valuation smarter everywhere.”

The right move is:

- search a bit wider, but in a controlled way
- classify the listing type before pretending to know its value
- only price bundles when the system can explain the bundle
- otherwise say less, but say it honestly

That is the correct scope for a trustworthy personal Marketplace monitor.