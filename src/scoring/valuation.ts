import type { AppDb } from '../db/database.js';
import { classifyListing } from './classifyListing.js';
import type { ListingObservation, ListingTypeScope, SearchProfile, ValuationAssessment, ValuationContext, ValuationHeuristicRule, ValuationReference } from '../types.js';

const CATEGORY_HEURISTICS: Record<string, ValuationHeuristicRule[]> = {
  golf: [
    { key: 'golf-driver-premium', appliesWhen: ['driver'], referenceLow: 350, referenceHigh: 650, note: 'Premium used golf drivers often trade in the mid-hundreds locally', listingTypeScope: 'single_item' },
    { key: 'golf-irons-set', appliesWhen: ['irons', 'set'], referenceLow: 300, referenceHigh: 900, note: 'Complete used iron sets usually sit above single-club pricing', listingTypeScope: 'bundle_or_set' },
    { key: 'golf-putter', appliesWhen: ['putter'], referenceLow: 120, referenceHigh: 350, note: 'Recognisable used putters commonly hold value better than generic clubs', listingTypeScope: 'single_item' },
    { key: 'golf-wedge', appliesWhen: ['wedge'], referenceLow: 70, referenceHigh: 180, note: 'Single wedges usually price lower than drivers or iron sets', listingTypeScope: 'single_item' },
    { key: 'golf-club-generic', appliesWhen: ['golf', 'club'], referenceLow: 80, referenceHigh: 300, note: 'Fallback used golf-club range when model match is unclear', listingTypeScope: 'single_item' },
    { key: 'golf-bag', appliesWhen: ['bag'], referenceLow: 40, referenceHigh: 180, note: 'Golf bags tend to be lower-value unless premium branded', listingTypeScope: 'accessory_service_modification' }
  ],
  skis: [
    { key: 'ski-pair', appliesWhen: ['ski', 'skis'], referenceLow: 180, referenceHigh: 550, note: 'Used skis often depend heavily on age and bindings, so confidence stays modest', listingTypeScope: 'bundle_or_set' }
  ],
  'ski-goggles': [
    { key: 'goggles', appliesWhen: ['goggles'], referenceLow: 40, referenceHigh: 120, note: 'Used goggles are usually accessory-priced unless premium lenses are specified', listingTypeScope: 'single_item' }
  ],
  'ski-helmet': [
    { key: 'helmet', appliesWhen: ['helmet'], referenceLow: 30, referenceHigh: 120, note: 'Used helmets carry more condition uncertainty so pricing confidence is conservative', listingTypeScope: 'single_item' }
  ]
};

export function buildValuationContext(db: AppDb, observation: ListingObservation, profile: SearchProfile): ValuationContext {
  const haystack = normalize([observation.title, observation.description].filter(Boolean).join(' '));
  const classification = classifyListing(observation);

  if (classification.listingType === 'accessory_service_modification') {
    return {
      assessment: 'withheld',
      summary: `Valuation withheld: ${classification.summary}`,
      price: observation.price ?? null,
      sources: [],
      confidence: 'low',
      classification
    };
  }

  if (classification.listingType === 'ambiguous') {
    return {
      assessment: 'uncertain',
      summary: `Valuation downgraded: ${classification.summary}`,
      price: observation.price ?? null,
      sources: [],
      confidence: 'low',
      classification
    };
  }

  const allowedScope: ListingTypeScope = classification.listingType === 'bundle_or_set' ? 'bundle_or_set' : 'single_item';
  const reference = pickManualReference(profile.valuationReferences ?? [], haystack, allowedScope);
  const heuristic = pickHeuristic(profile, haystack, allowedScope);
  const localBaseline = getLocalBaseline(db, profile, observation, reference, heuristic, allowedScope);
  const riskyPricing = hasRiskyPricingContext(observation, haystack, classification.listingType);

  const sources = [] as ValuationContext['sources'];
  if (reference) {
    sources.push({
      source: 'manual_reference',
      label: reference.label,
      priceLow: reference.priceLow,
      priceHigh: reference.priceHigh,
      confidence: reference.confidence ?? 'high',
      detail: reference.notes ?? `Manual reference matched terms: ${reference.matchTerms.join(', ')}`,
      listingTypeScope: reference.listingTypeScope ?? inferReferenceScope(reference)
    });
  }

  if (heuristic) {
    sources.push({
      source: 'category_heuristic',
      label: heuristic.key,
      priceLow: heuristic.referenceLow,
      priceHigh: heuristic.referenceHigh,
      confidence: 'medium',
      detail: heuristic.note,
      listingTypeScope: heuristic.listingTypeScope ?? 'any'
    });
  }

  if (localBaseline) {
    sources.push({
      source: 'local_baseline',
      label: localBaseline.label,
      priceLow: localBaseline.priceLow,
      priceHigh: localBaseline.priceHigh,
      confidence: localBaseline.sampleSize >= 5 ? 'medium' : 'low',
      detail: `Based on ${localBaseline.sampleSize} local observation${localBaseline.sampleSize === 1 ? '' : 's'}; median ${Math.round(localBaseline.medianPrice)}`,
      listingTypeScope: allowedScope
    });
  }

  if (classification.listingType === 'bundle_or_set' && !classification.canDecomposeBundle) {
    return {
      assessment: 'withheld',
      summary: `Bundle valuation withheld: components are too fuzzy (${classification.summary})`,
      price: observation.price ?? null,
      matchedReferenceLabel: reference?.label,
      sources,
      confidence: 'low',
      classification
    };
  }

  if (classification.listingType === 'bundle_or_set' && sources.length === 0) {
    return {
      assessment: 'withheld',
      summary: `Bundle valuation withheld: components were identified but no bundle-safe reference or baseline matched (${classification.summary})`,
      price: observation.price ?? null,
      sources,
      confidence: 'low',
      classification
    };
  }

  if (riskyPricing) {
    return {
      assessment: 'uncertain',
      summary: riskyPricing,
      price: observation.price ?? null,
      matchedReferenceLabel: reference?.label,
      sources,
      confidence: 'low',
      classification
    };
  }

  if (typeof observation.price !== 'number') {
    return {
      assessment: 'uncertain',
      summary: 'No numeric price, so value cannot be judged reliably',
      price: observation.price ?? null,
      matchedReferenceLabel: reference?.label,
      sources,
      confidence: 'low',
      classification
    };
  }

  const anchor = chooseAnchor(reference, heuristic, localBaseline);
  if (!anchor) {
    return {
      assessment: classification.listingType === 'bundle_or_set' ? 'withheld' : 'uncertain',
      summary: classification.listingType === 'bundle_or_set'
        ? 'Bundle valuation withheld because no bundle-safe manual reference, category heuristic, or local baseline matched this listing'
        : 'No manual reference, category heuristic, or local baseline matched this listing',
      price: observation.price,
      matchedReferenceLabel: reference?.label,
      sources,
      confidence: 'low',
      classification
    };
  }

  const assessment = assessPrice(observation.price, anchor.priceLow, anchor.priceHigh, sources.length, Boolean(reference));
  const summary = summarizeAssessment(observation.price, anchor.priceLow, anchor.priceHigh, anchor.label, assessment, sources, localBaseline?.sampleSize, classification.summary);

  return {
    assessment,
    summary,
    price: observation.price,
    matchedReferenceLabel: reference?.label,
    sources,
    confidence: anchor.confidence,
    classification
  };
}

function pickManualReference(references: ValuationReference[], haystack: string, allowedScope: ListingTypeScope): ValuationReference | null {
  let best: ValuationReference | null = null;
  let bestScore = -1;

  for (const reference of references) {
    const scope = reference.listingTypeScope ?? inferReferenceScope(reference);
    if (!scopeMatches(scope, allowedScope)) continue;
    const terms = reference.matchTerms.map(normalize).filter(Boolean);
    const matches = terms.filter((term) => haystack.includes(term)).length;
    if (matches === 0) continue;
    const score = matches * 100 + terms.join(' ').length;
    if (score > bestScore) {
      best = reference;
      bestScore = score;
    }
  }

  return best;
}

function pickHeuristic(profile: SearchProfile, haystack: string, allowedScope: ListingTypeScope): ValuationHeuristicRule | null {
  const category = profile.category ?? 'generic';
  const rules = CATEGORY_HEURISTICS[category] ?? [];
  let best: ValuationHeuristicRule | null = null;
  let bestScore = -1;

  for (const rule of rules) {
    const scope = rule.listingTypeScope ?? 'any';
    if (!scopeMatches(scope, allowedScope)) continue;
    const matches = rule.appliesWhen.map(normalize).filter((term) => haystack.includes(term)).length;
    if (matches === 0) continue;
    const score = matches * 100 + rule.appliesWhen.length;
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }

  return best;
}

function getLocalBaseline(
  db: AppDb,
  profile: SearchProfile,
  observation: ListingObservation,
  reference: ValuationReference | null,
  heuristic: ValuationHeuristicRule | null,
  allowedScope: ListingTypeScope
): { label: string; priceLow: number; priceHigh: number; medianPrice: number; sampleSize: number } | null {
  const terms = new Set<string>();

  if (reference) {
    for (const term of reference.matchTerms) terms.add(normalize(term));
  }
  for (const family of profile.modelFamilies ?? []) {
    if (includesNormalized(observation.title, family) || includesNormalized(observation.description, family)) {
      terms.add(normalize(family));
    }
  }
  for (const brand of profile.brandPreferences) {
    if (includesNormalized(observation.title, brand) || includesNormalized(observation.description, brand)) {
      terms.add(normalize(brand));
    }
  }
  if (heuristic && (reference || terms.size > 0)) {
    for (const term of heuristic.appliesWhen) {
      if (includesNormalized(observation.title, term) || includesNormalized(observation.description, term)) {
        terms.add(normalize(term));
      }
    }
  }

  const candidateTerms = [...terms].filter((term) => term.length >= 3).slice(0, 6);
  if (candidateTerms.length === 0) return null;

  const whereTerms = candidateTerms.map(() => "(LOWER(o.title) LIKE ? OR LOWER(COALESCE(o.description, '')) LIKE ?)").join(' OR ');
  const params: Array<string | number> = [profile.id, observation.externalId, `%\"listingType\":\"${allowedScope}%`];
  for (const term of candidateTerms) {
    const like = `%${term}%`;
    params.push(like, like);
  }

  const rows = db.prepare(`
    SELECT o.price as price
    FROM observations o
    JOIN listings l ON l.id = o.listing_id
    WHERE o.profile_id = ?
      AND o.price IS NOT NULL
      AND o.price > 20
      AND l.external_id != ?
      AND LOWER(o.raw_json) LIKE ?
      AND (${whereTerms})
    ORDER BY o.observed_at DESC
    LIMIT 25
  `).all(...params) as Array<{ price: number | null }>;

  const prices = rows
    .map((row) => row.price)
    .filter((price): price is number => typeof price === 'number' && Number.isFinite(price) && price > 1)
    .sort((a, b) => a - b);

  if (prices.length < 2) return null;

  const medianPrice = median(prices);
  return {
    label: reference?.label ?? heuristic?.key ?? 'similar local listings',
    priceLow: Math.round(medianPrice * 0.85),
    priceHigh: Math.round(medianPrice * 1.15),
    medianPrice,
    sampleSize: prices.length
  };
}

function chooseAnchor(
  reference: ValuationReference | null,
  heuristic: ValuationHeuristicRule | null,
  localBaseline: { label: string; priceLow: number; priceHigh: number; medianPrice: number; sampleSize: number } | null
): { label: string; priceLow: number; priceHigh: number; confidence: 'high' | 'medium' | 'low' } | null {
  if (reference && localBaseline) {
    return {
      label: `${reference.label} with local confirmation`,
      priceLow: Math.round((reference.priceLow * 0.65) + (localBaseline.priceLow * 0.35)),
      priceHigh: Math.round((reference.priceHigh * 0.65) + (localBaseline.priceHigh * 0.35)),
      confidence: 'high'
    };
  }
  if (reference) {
    return { label: reference.label, priceLow: reference.priceLow, priceHigh: reference.priceHigh, confidence: reference.confidence ?? 'high' };
  }
  if (localBaseline && heuristic) {
    return {
      label: `${heuristic.key} informed by local baseline`,
      priceLow: Math.round((heuristic.referenceLow * 0.4) + (localBaseline.priceLow * 0.6)),
      priceHigh: Math.round((heuristic.referenceHigh * 0.4) + (localBaseline.priceHigh * 0.6)),
      confidence: 'medium'
    };
  }
  if (localBaseline) {
    return { label: localBaseline.label, priceLow: localBaseline.priceLow, priceHigh: localBaseline.priceHigh, confidence: localBaseline.sampleSize >= 5 ? 'medium' : 'low' };
  }
  if (heuristic) {
    return { label: heuristic.key, priceLow: heuristic.referenceLow, priceHigh: heuristic.referenceHigh, confidence: 'medium' };
  }
  return null;
}

function assessPrice(price: number, low: number, high: number, sourceCount: number, hasManualReference: boolean): ValuationAssessment {
  if (price < low * 0.82) return 'attractive';
  if (price <= high * 1.08) return 'fair';
  if (!hasManualReference && sourceCount < 2 && price > high * 1.18) return 'uncertain';
  return 'overpriced';
}

function summarizeAssessment(
  price: number,
  low: number,
  high: number,
  label: string,
  assessment: ValuationAssessment,
  sources: ValuationContext['sources'],
  sampleSize: number | undefined,
  classificationSummary: string
): string {
  const base = `${assessment} vs ${label}: price ${price} against estimated range ${low}-${high}`;
  const sourceNames = sources.map((source) => source.source.replace('_', ' ')).join(', ');
  const localNote = sampleSize ? `; local sample n=${sampleSize}` : '';
  return `${base} (${sourceNames || 'no supporting sources'}${localNote}); ${classificationSummary}`;
}

function hasRiskyPricingContext(observation: ListingObservation, haystack: string, listingType: 'single_item' | 'bundle_or_set'): string | null {
  if (observation.price != null && observation.price <= 1) {
    return 'Price looks like a placeholder/bait amount, so valuation is uncertain';
  }
  if (observation.titleConfidence === 'low') {
    return 'Title parse confidence is low, so valuation is uncertain';
  }
  if (/\bfrom\s+(?:au\$|\$)?\s*\d|\beach\b|\bper\s+(?:item|piece|pc)\b/i.test(haystack)) {
    return listingType === 'bundle_or_set'
      ? 'Bundle uses per-item or from-price wording, so total value is uncertain'
      : 'Per-item or from-price wording makes true listing value uncertain';
  }
  if (listingType === 'bundle_or_set' && /\bbulk\b|\bmixed\b|\bassorted\b|\bjob\s+lot\b/i.test(haystack)) {
    return 'Bundle contains mixed-item wording, so valuation confidence is downgraded';
  }
  return null;
}

function inferReferenceScope(reference: ValuationReference): ListingTypeScope {
  const label = normalize(`${reference.label} ${reference.matchTerms.join(' ')}`);
  if (/\b(set|bundle|lot|pair|skis|irons)\b/.test(label)) return 'bundle_or_set';
  return 'single_item';
}

function scopeMatches(scope: ListingTypeScope, allowedScope: ListingTypeScope): boolean {
  return scope === 'any' || scope === allowedScope;
}

function normalize(value?: string | null): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function includesNormalized(value: string | null | undefined, term: string): boolean {
  return normalize(value).includes(normalize(term));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return (values[middle - 1] + values[middle]) / 2;
  }
  return values[middle];
}
