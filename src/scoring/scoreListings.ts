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
    if (typeof profile.maxPrice === 'number') {
      if (observation.price <= profile.maxPrice) {
        reasons.push({ code: 'PRICE_UNDER_MAX', weight: 20, detail: `Price ${observation.price} <= max ${profile.maxPrice}` });
      } else {
        reasons.push({ code: 'PRICE_OVER_MAX', weight: -15, detail: `Price ${observation.price} > max ${profile.maxPrice}` });
      }
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

  const score = reasons.reduce((sum, reason) => sum + reason.weight, 0);

  return {
    ...observation,
    score,
    reasons,
    isNewListing
  };
}
