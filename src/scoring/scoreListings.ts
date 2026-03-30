import type { ListingObservation, ScoreReason, ScoredObservation, SearchProfile } from '../types.js';

export function scoreListing(observation: ListingObservation, profile: SearchProfile, isNewListing: boolean): ScoredObservation {
  const reasons: ScoreReason[] = [];
  const title = observation.title.toLowerCase();
  const description = (observation.description ?? '').toLowerCase();
  const haystack = `${title} ${description}`;

  for (const brand of profile.brandPreferences) {
    if (haystack.includes(brand.toLowerCase())) {
      reasons.push({ code: 'BRAND_MATCH', weight: 30, detail: `Brand match: ${brand}` });
    }
  }

  for (const keyword of profile.keywords ?? []) {
    if (haystack.includes(keyword.toLowerCase())) {
      reasons.push({ code: 'KEYWORD_MATCH', weight: 12, detail: `Keyword match: ${keyword}` });
    }
  }

  if (typeof observation.price === 'number') {
    if (typeof profile.minPrice === 'number' && observation.price < profile.minPrice) {
      reasons.push({ code: 'SUSPICIOUS_PRICE_PATTERN', weight: -8, detail: `Price ${observation.price} is below min ${profile.minPrice}` });
    }

    if (typeof profile.maxPrice === 'number') {
      if (observation.price <= profile.maxPrice) {
        reasons.push({ code: 'PRICE_UNDER_MAX', weight: 20, detail: `Price ${observation.price} <= max ${profile.maxPrice}` });
      } else {
        reasons.push({ code: 'PRICE_OVER_MAX', weight: -15, detail: `Price ${observation.price} > max ${profile.maxPrice}` });
      }
    }

    if (looksLikePlaceholderPrice(observation.price, observation.priceText)) {
      reasons.push({ code: 'PLACEHOLDER_PRICE', weight: -30, detail: `Placeholder/bait price detected: ${observation.priceText ?? observation.price}` });
    }
  } else {
    reasons.push({ code: 'MISSING_PRICE', weight: -5, detail: 'Price missing from listing card' });
  }

  if (isNewListing) {
    reasons.push({ code: 'NEW_LISTING', weight: 15, detail: 'First time seen locally' });
  }

  if (profile.locationLabel && observation.location?.toLowerCase().includes(profile.locationLabel.toLowerCase())) {
    reasons.push({ code: 'LOCATION_MATCH', weight: 5, detail: `Location mentions ${profile.locationLabel}` });
  }

  if (observation.titleConfidence === 'low') {
    reasons.push({ code: 'LOW_TITLE_CONFIDENCE', weight: -35, detail: 'Card title parse confidence is low' });
  } else if (observation.titleConfidence === 'medium') {
    reasons.push({ code: 'LOW_TITLE_CONFIDENCE', weight: -12, detail: 'Card title parse confidence is medium' });
  }

  if (observation.parserNotes?.includes('title_fallback_no_clean_candidate') || observation.parserNotes?.includes('title_missing')) {
    reasons.push({ code: 'TITLE_PARSE_FALLBACK', weight: -18, detail: `Title fallback used (${observation.parserNotes.join(', ')})` });
  }

  if (observation.parserNotes?.includes('title_looks_like_price') || observation.parserNotes?.includes('title_replaced_from_price_line')) {
    reasons.push({ code: 'TITLE_LOOKS_LIKE_PRICE', weight: -25, detail: 'Title looked like a price or had to be replaced from price line' });
  }

  const score = reasons.reduce((sum, reason) => sum + reason.weight, 0);

  return {
    ...observation,
    score,
    reasons,
    isNewListing
  };
}

function looksLikePlaceholderPrice(price: number, priceText?: string | null): boolean {
  if (price <= 1) return true;
  if (priceText && /^free$/i.test(priceText)) return true;

  const digits = String(Math.trunc(price));
  if (/^(1234|1111|2222|3333|4444|5555|9999)$/.test(digits)) return true;
  if (/^(12|123|1234|12345)$/.test(digits)) return true;

  return false;
}
