import type { RunStatus, ScoredObservation, SearchProfile } from '../types.js';

export function generateDigest(input: {
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  scored: ScoredObservation[];
  profiles: SearchProfile[];
  suspiciousProfiles: string[];
  failedProfiles?: Record<string, string>;
}): string {
  const top = [...input.scored].sort((a, b) => b.score - a.score).slice(0, 12);
  const failedProfileIds = Object.keys(input.failedProfiles ?? {});
  const enrichedCount = input.scored.filter((item) => Boolean(item.description || item.condition || item.detailCollectedAt)).length;
  const header = [
    `Facebook Marketplace monitor`,
    `Status: ${input.status}`,
    `Window: ${input.startedAt} → ${input.finishedAt}`,
    `Profiles scanned: ${input.profiles.length}`,
    `Listings seen: ${input.scored.length}`,
    `Listings enriched: ${enrichedCount}`
  ];

  if (input.suspiciousProfiles.length > 0) {
    header.push(`Suspicious empty profiles: ${input.suspiciousProfiles.join(', ')}`);
  }

  if (failedProfileIds.length > 0) {
    header.push(`Failed profiles: ${failedProfileIds.join(', ')}`);
  }

  const failureBody = failedProfileIds.length === 0
    ? []
    : ['', 'Profile failures:', ...failedProfileIds.map((profileId) => `- ${profileId}: ${input.failedProfiles?.[profileId] ?? 'unknown error'}`)];

  const body = top.length === 0
    ? ['No listings scored this run.']
    : top.map((item, index) => {
        const reasons = item.reasons.map((reason) => `${reason.code}(${reason.weight >= 0 ? '+' : ''}${reason.weight})`).join(', ');
        const confidenceLabel = formatConfidence(item.titleConfidence);
        const flags = [
          item.titleConfidence === 'low' ? 'weak-title' : null,
          item.reasons.some((reason) => reason.code === 'PLACEHOLDER_PRICE') ? 'placeholder-price' : null,
          item.reasons.some((reason) => reason.code === 'TITLE_LOOKS_LIKE_PRICE') ? 'title-from-price-risk' : null,
          item.description ? 'detail-enriched' : null,
          item.valuation.classification.listingType === 'bundle_or_set' ? 'bundle' : null,
          item.valuation.assessment === 'withheld' ? 'valuation-withheld' : null
        ].filter(Boolean).join(', ');
        const summaryBits = [
          item.location ?? 'Unknown location',
          item.condition ? `Condition: ${item.condition}` : null,
          `Title confidence: ${confidenceLabel}`,
          `Type: ${item.valuation.classification.listingType} (${item.valuation.classification.confidence})`,
          `Valuation confidence: ${item.valuation.confidence}`
        ].filter(Boolean).join(' | ');
        const description = summarizeDescription(item.description);
        const valuationSources = item.valuation.sources
          .map((source) => `${source.source}:${source.label} ${source.priceLow}-${source.priceHigh}`)
          .join('; ');

        return `${index + 1}. [${item.profileId}] ${item.title} — ${formatPrice(item.price, item.currency, item.priceText)} — score ${item.score}${flags ? ` — flags: ${flags}` : ''}
   ${summaryBits}
   Classification: ${item.valuation.classification.summary}
   Value: ${capitalize(item.valuation.assessment)} — ${item.valuation.summary}
${valuationSources ? `   Value sources: ${valuationSources}
` : ''}   Reasons: ${reasons || 'none'}
${description ? `   Description: ${description}
` : ''}   ${item.url}`;
      });

  return [...header, ...failureBody, '', ...body].join('\n');
}

function formatPrice(price?: number | null, currency?: string | null, priceText?: string | null): string {
  if (priceText && /^free$/i.test(priceText)) return 'Free';
  if (typeof price !== 'number') return 'Price n/a';
  return `${currency ?? 'AUD'} ${price}`;
}

function formatConfidence(confidence?: 'high' | 'medium' | 'low'): string {
  switch (confidence) {
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'unknown';
  }
}

function summarizeDescription(description?: string | null): string | null {
  if (!description) return null;
  const compact = description.replace(/\s+/g, ' ').trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`;
}

function capitalize(value: string): string {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}
