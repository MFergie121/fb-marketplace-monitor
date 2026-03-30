import type { AppDb } from '../db/database.js';
import type { ListingObservation, SearchProfile, ValuationAssessment, ValuationContext, ValuationHeuristicRule, ValuationReference } from '../types.js';

const CATEGORY_HEURISTICS: Record<string, ValuationHeuristicRule[]> = {
  golf: [
    { key: 'golf-driver-premium', appliesWhen: ['driver'], referenceLow: 350, referenceHigh: 650, note: 'Premium used golf drivers often trade in the mid-hundreds locally' },
    { key: 'golf-irons-set', appliesWhen: ['irons'], referenceLow: 300, referenceHigh: 900, note: 'Complete used iron sets usually sit above single-club pricing' },
    { key: 'golf-putter', appliesWhen: ['putter'], referenceLow: 120, referenceHigh: 350, note: 'Recognisable used putters commonly hold value better than generic clubs' },
    { key: 'golf-wedge', appliesWhen: ['wedge'], referenceLow: 70, referenceHigh: 180, note: 'Single wedges usually price lower than drivers or iron sets' },
    { key: 'golf-club-generic', appliesWhen: ['golf', 'club'], referenceLow: 80, referenceHigh: 300, note: 'Fallback used golf-club range when model match is unclear' },
    { key: 'golf-bag', appliesWhen: ['bag'], referenceLow: 40, referenceHigh: 180, note: 'Golf bags tend to be lower-value unless premium branded' }
  ],
  skis: [
    { key: 'ski', appliesWhen: ['ski', 'skis'], referenceLow: 180, referenceHigh: 550, note: 'Used skis often depend heavily on age and bindings, so confidence stays modest' }
  ],
  'ski-goggles': [
    { key: 'goggles', appliesWhen: ['goggles'], referenceLow: 40, referenceHigh: 120, note: 'Used goggles are usually accessory-priced unless premium lenses are specified' }
  ],
  'ski-helmet': [
    { key: 'helmet', appliesWhen: ['helmet'], referenceLow: 30, referenceHigh: 120, note: 'Used helmets carry more condition uncertainty so pricing confidence is conservative' }
  ]
};

export function buildValuationContext(db: AppDb, observation: ListingObservation, profile: SearchProfile): ValuationContext {
  const haystack = normalize([observation.title, observation.description].filter(Boolean).join(' '));
  const reference = pickManualReference(profile.valuationReferences ?? [], haystack);
  const heuristic = pickHeuristic(profile, haystack);
  const localBaseline = getLocalBaseline(db, profile, observation, reference, heuristic);
  const riskyPricing = hasRiskyPricingContext(observation, haystack);

  const sources = [] as ValuationContext['sources'];
  if (reference) {
    sources.push({
      source: 'manual_reference',
      label: reference.label,
      priceLow: reference.priceLow,
      priceHigh: reference.priceHigh,
      confidence: reference.confidence ?? 'high',
      detail: reference.notes ?? `Manual reference matched terms: ${reference.matchTerms.join(', ')}`
    });
  }

  if (heuristic) {
    sources.push({
      source: 'category_heuristic',
      label: heuristic.key,
      priceLow: heuristic.referenceLow,
      priceHigh: heuristic.referenceHigh,
      confidence: 'medium',
      detail: heuristic.note
    });
  }

  if (localBaseline) {
    sources.push({
      source: 'local_baseline',
      label: localBaseline.label,
      priceLow: localBaseline.priceLow,
      priceHigh: localBaseline.priceHigh,
      confidence: localBaseline.sampleSize >= 5 ? 'medium' : 'low',
      detail: `Based on ${localBaseline.sampleSize} local observation${localBaseline.sampleSize === 1 ? '' : 's'}; median ${Math.round(localBaseline.medianPrice)}`
    });
  }

  if (riskyPricing) {
    return {
      assessment: 'uncertain',
      summary: riskyPricing,
      price: observation.price ?? null,
      matchedReferenceLabel: reference?.label,
      sources,
      confidence: 'low'
    };
  }

  if (typeof observation.price !== 'number') {
    return {
      assessment: 'uncertain',
      summary: 'No numeric price, so value cannot be judged reliably',
      price: observation.price ?? null,
      matchedReferenceLabel: reference?.label,
      sources,
      confidence: 'low'
    };
  }

  const anchor = chooseAnchor(reference, heuristic, localBaseline);
  if (!anchor) {
    return {
      assessment: 'uncertain',
      summary: 'No manual reference, category heuristic, or local baseline matched this listing',
      price: observation.price,
      matchedReferenceLabel: reference?.label,
      sources,
      confidence: 'low'
    };
  }

  const assessment = assessPrice(observation.price, anchor.priceLow, anchor.priceHigh, sources.length, Boolean(reference));
  const summary = summarizeAssessment(observation.price, anchor.priceLow, anchor.priceHigh, anchor.label, assessment, sources, localBaseline?.sampleSize);

  return {
    assessment,
    summary,
    price: observation.price,
    matchedReferenceLabel: reference?.label,
    sources,
    confidence: anchor.confidence
  };
}

function pickManualReference(references: ValuationReference[], haystack: string): ValuationReference | null {
  let best: ValuationReference | null = null;
  let bestScore = -1;

  for (const reference of references) {
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

function pickHeuristic(profile: SearchProfile, haystack: string): ValuationHeuristicRule | null {
  const category = profile.category ?? 'generic';
  const rules = CATEGORY_HEURISTICS[category] ?? [];
  let best: ValuationHeuristicRule | null = null;
  let bestScore = -1;

  for (const rule of rules) {
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
  heuristic: ValuationHeuristicRule | null
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
  const params: Array<string | number> = [profile.id, observation.externalId];
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
  sampleSize?: number
): string {
  const base = `${assessment} vs ${label}: price ${price} against estimated range ${low}-${high}`;
  const sourceNames = sources.map((source) => source.source.replace('_', ' ')).join(', ');
  const localNote = sampleSize ? `; local sample n=${sampleSize}` : '';
  return `${base} (${sourceNames || 'no supporting sources'}${localNote})`;
}

function hasRiskyPricingContext(observation: ListingObservation, haystack: string): string | null {
  if (observation.price != null && observation.price <= 1) {
    return 'Price looks like a placeholder/bait amount, so valuation is uncertain';
  }
  if (observation.titleConfidence === 'low') {
    return 'Title parse confidence is low, so valuation is uncertain';
  }
  if (/\bfrom\s+(?:au\$|\$)?\s*\d|\beach\b|\bper\s+(?:item|piece|pc)\b/i.test(haystack)) {
    return 'Per-item or from-price wording makes true listing value uncertain';
  }
  if (/\bbulk\b|\bbundle\b|\bmixed\b|\bassorted\b|\bjob\s+lot\b/i.test(haystack)) {
    return 'Bundle/mixed-item wording makes single-item valuation uncertain';
  }
  return null;
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
