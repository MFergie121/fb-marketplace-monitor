import type { RunStatus, ScoredObservation, SearchProfile } from '../types.js';

export function generateDigest(input: {
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  scored: ScoredObservation[];
  profiles: SearchProfile[];
  suspiciousProfiles: string[];
}): string {
  const top = [...input.scored].sort((a, b) => b.score - a.score).slice(0, 12);
  const header = [
    `Facebook Marketplace monitor`,
    `Status: ${input.status}`,
    `Window: ${input.startedAt} → ${input.finishedAt}`,
    `Profiles scanned: ${input.profiles.length}`,
    `Listings seen: ${input.scored.length}`
  ];

  if (input.suspiciousProfiles.length > 0) {
    header.push(`Suspicious empty profiles: ${input.suspiciousProfiles.join(', ')}`);
  }

  const body = top.length === 0
    ? ['No listings scored this run.']
    : top.map((item, index) => {
        const reasons = item.reasons.map((reason) => reason.code).join(', ');
        const confidenceLabel = formatConfidence(item.titleConfidence);
        const flags = [
          item.titleConfidence === 'low' ? 'weak-title' : null,
          item.reasons.some((reason) => reason.code === 'PLACEHOLDER_PRICE') ? 'placeholder-price' : null,
          item.reasons.some((reason) => reason.code === 'TITLE_LOOKS_LIKE_PRICE') ? 'title-from-price-risk' : null
        ].filter(Boolean).join(', ');

        return `${index + 1}. [${item.profileId}] ${item.title} — ${formatPrice(item.price, item.currency, item.priceText)} — score ${item.score}${flags ? ` — flags: ${flags}` : ''}\n   ${item.location ?? 'Unknown location'}\n   Title confidence: ${confidenceLabel}\n   Reasons: ${reasons || 'none'}\n   ${item.url}`;
      });

  return [...header, '', ...body].join('\n');
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
