import type { ListingObservation, ScoreReason, ScoredObservation, SearchProfile, ValuationContext } from '../types.js';

const SPEC_PATTERNS: Array<{ pattern: RegExp; detail: string; weight: number }> = [
  { pattern: /\b(\d{2,3}(?:\.\d)?\s?cm)\b/i, detail: 'Length spec present', weight: 6 },
  { pattern: /\b(\d{1,2}(?:\.\d)?\s?°|degree|deg)\b/i, detail: 'Loft/angle spec present', weight: 7 },
  { pattern: /\b(stiff|regular|senior|x-stiff|extra stiff)\b/i, detail: 'Flex spec present', weight: 7 },
  { pattern: /\b(left\s*hand(?:ed)?|right\s*hand(?:ed)?)\b/i, detail: 'Handedness spec present', weight: 5 },
  { pattern: /\b(mips|polarized|photochromic|carbon|graphite|forged|twin tip|all mountain)\b/i, detail: 'Useful feature/spec cue present', weight: 6 },
  { pattern: /\b(10\.5|9\.0|170|175|180)\b/i, detail: 'Model/spec number present', weight: 4 }
];

export function scoreListing(
  observation: ListingObservation,
  profile: SearchProfile,
  isNewListing: boolean,
  valuation: ValuationContext
): ScoredObservation {
  const reasons: ScoreReason[] = [];
  const title = normalize(observation.title);
  const description = normalize(observation.description);
  const haystack = [title, description].filter(Boolean).join(' ');

  for (const brand of profile.brandPreferences) {
    if (includesTerm(haystack, brand)) {
      reasons.push({ code: 'BRAND_MATCH', weight: 30, detail: `Brand match: ${brand}` });
    }
  }

  for (const family of profile.modelFamilies ?? []) {
    if (includesTerm(haystack, family)) {
      reasons.push({ code: 'MODEL_FAMILY_MATCH', weight: 18, detail: `Model family match: ${family}` });
    }
  }

  let keywordMatches = 0;
  for (const keyword of profile.keywords ?? []) {
    if (includesTerm(haystack, keyword)) {
      keywordMatches += 1;
      reasons.push({ code: 'KEYWORD_MATCH', weight: 8, detail: `Keyword match: ${keyword}` });
    }
  }

  const requiredAnyKeywords = profile.requiredAnyKeywords ?? [];
  const requiredMatches = requiredAnyKeywords.filter((keyword) => includesTerm(haystack, keyword));
  if (requiredAnyKeywords.length > 0) {
    if (requiredMatches.length > 0) {
      reasons.push({ code: 'SPECIFIC_LISTING', weight: 18, detail: `High-signal keyword match: ${requiredMatches.slice(0, 2).join(', ')}` });
    } else {
      reasons.push({ code: 'VAGUE_LISTING', weight: -70, detail: 'Missing any required high-signal keyword for this profile' });
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

  const fromPriceDetail = detectFromPricePattern(haystack);
  if (fromPriceDetail) {
    reasons.push({ code: 'FROM_PRICE_PATTERN', weight: -18, detail: fromPriceDetail });
  }

  const quickSaleDetail = detectQuickSalePhrase(haystack);
  if (quickSaleDetail) {
    reasons.push({ code: 'QUICK_SALE_PHRASE', weight: -8, detail: quickSaleDetail });
  }

  const bulkDetail = detectBulkMixedWording(haystack);
  if (bulkDetail) {
    reasons.push({ code: 'BULK_MIXED_WORDING', weight: -14, detail: bulkDetail });
  }

  for (const unwanted of profile.unwantedKeywords ?? []) {
    if (includesTerm(haystack, unwanted)) {
      reasons.push({ code: 'UNWANTED_VARIANT', weight: -24, detail: `Unwanted variant match: ${unwanted}` });
      break;
    }
  }

  const categoryMismatch = detectGolfCategoryMismatch(haystack, profile);
  if (categoryMismatch) {
    reasons.push({ code: 'UNWANTED_VARIANT', weight: -26, detail: categoryMismatch });
  }

  const brandMatched = profile.brandPreferences.some((brand) => includesTerm(haystack, brand));
  const modelMatched = (profile.modelFamilies ?? []).some((family) => includesTerm(haystack, family));
  if (keywordMatches > 0 && !brandMatched && !modelMatched) {
    reasons.push({ code: 'VAGUE_LISTING', weight: -24, detail: 'Generic keyword match without preferred brand/model signal' });
  }

  const specificity = scoreSpecificity(observation.title, observation.description);
  if (specificity.singleItemSignal) {
    reasons.push({ code: 'SINGLE_ITEM_SIGNAL', weight: 8, detail: specificity.singleItemSignal });
  }
  if (specificity.specificListing) {
    reasons.push({ code: 'SPECIFIC_LISTING', weight: 10, detail: specificity.specificListing });
  }
  if (specificity.vagueListing) {
    reasons.push({ code: 'VAGUE_LISTING', weight: -12, detail: specificity.vagueListing });
  }

  reasons.push(...classificationReasons(valuation));

  for (const cue of detectSpecCues(haystack)) {
    reasons.push(cue);
  }

  reasons.push(...valuationReasons(valuation));

  const score = reasons.reduce((sum, reason) => sum + reason.weight, 0);

  return {
    ...observation,
    score,
    reasons,
    isNewListing,
    valuation
  };
}

function detectGolfCategoryMismatch(haystack: string, profile: SearchProfile): string | null {
  const wantsDriver = (profile.keywords ?? []).some((keyword) => keyword.toLowerCase() === 'driver');
  const wantsPutter = (profile.keywords ?? []).some((keyword) => keyword.toLowerCase() === 'putter');
  const wantsIronSet = (profile.keywords ?? []).some((keyword) => keyword.toLowerCase().includes('iron'));

  if (wantsDriver && !includesTerm(haystack, 'driver') && /(hybrid|fairway wood|3 wood|5 wood|7 wood|wood\b)/i.test(haystack)) {
    return 'Category mismatch: driver profile matched a non-driver club listing';
  }

  if (wantsPutter && !includesTerm(haystack, 'putter') && /(driver|hybrid|fairway wood|iron set|irons\b|wedge\b)/i.test(haystack)) {
    return 'Category mismatch: putter profile matched a non-putter club listing';
  }

  if (wantsIronSet && !/(iron set|irons\b|4-pw|5-pw|4-p\b|5-p\b)/i.test(haystack) && /(driver|putter|hybrid|fairway wood|wedge\b)/i.test(haystack)) {
    return 'Category mismatch: iron-set profile matched a non-iron listing';
  }

  return null;
}

function classificationReasons(valuation: ValuationContext): ScoreReason[] {
  const summary = valuation.classification.summary;
  switch (valuation.classification.listingType) {
    case 'single_item':
      return [{ code: 'LISTING_TYPE_SINGLE_ITEM', weight: 10, detail: summary }];
    case 'bundle_or_set':
      return [{ code: 'LISTING_TYPE_BUNDLE', weight: valuation.classification.canDecomposeBundle ? -8 : -18, detail: summary }];
    case 'accessory_service_modification':
      return [{ code: 'LISTING_TYPE_ACCESSORY_SERVICE', weight: -40, detail: summary }];
    case 'ambiguous':
    default:
      return [{ code: 'LISTING_TYPE_AMBIGUOUS', weight: -12, detail: summary }];
  }
}

function valuationReasons(valuation: ValuationContext): ScoreReason[] {
  switch (valuation.assessment) {
    case 'attractive':
      return [{ code: 'VALUATION_ATTRACTIVE', weight: 28, detail: valuation.summary }];
    case 'fair':
      return [{ code: 'VALUATION_FAIR', weight: 8, detail: valuation.summary }];
    case 'overpriced':
      return [{ code: 'VALUATION_OVERPRICED', weight: -22, detail: valuation.summary }];
    case 'withheld':
      return [{ code: 'VALUATION_WITHHELD', weight: -10, detail: valuation.summary }];
    case 'uncertain':
    default:
      return [{ code: 'VALUATION_UNCERTAIN', weight: -4, detail: valuation.summary }];
  }
}

function normalize(value?: string | null): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function includesTerm(haystack: string, term: string): boolean {
  return haystack.includes(normalize(term));
}

function looksLikePlaceholderPrice(price: number, priceText?: string | null): boolean {
  if (price <= 1) return true;
  if (priceText && /^free$/i.test(priceText)) return true;

  const digits = String(Math.trunc(price));
  if (/^(1234|1111|2222|3333|4444|5555|9999)$/.test(digits)) return true;
  if (/^(12|123|1234|12345)$/.test(digits)) return true;
  if (/^\d{2,}$/.test(digits) && new Set(digits.split('')).size === 1) return true;

  return false;
}

function detectFromPricePattern(text: string): string | null {
  if (/\bfrom\s+(?:au\$|\$)\s*\d/i.test(text)) return 'From-price wording detected';
  if (/\bfrom\s+\d[\d,.]*\s*(?:au\$|\$)/i.test(text)) return 'From-price wording detected';
  if (/\bfrom\s+\d[\d,.]*\s+each\b/i.test(text)) return 'From-price each wording detected';
  if (/\beach\b/i.test(text)) return '"each" implies multi-item listing';
  if (/\bper\s+(?:item|piece|pc)\b/i.test(text)) return 'Per-item wording detected';
  if (/(?<![a-z])\bea\b(?![a-z])/i.test(text) && /\d/.test(text)) return '"ea" abbreviation with price implies multi-item listing';
  return null;
}

function detectQuickSalePhrase(text: string): string | null {
  if (/\bquick\s+sale\b/i.test(text)) return '"quick sale" phrase detected';
  if (/\bmust\s+sell\b/i.test(text)) return '"must sell" phrase detected';
  if (/\bmust\s+go\b/i.test(text)) return '"must go" phrase detected';
  if (/\basap\b/i.test(text)) return 'ASAP/urgent selling phrase detected';
  if (/\burgent\s+(?:sale|sell)\b/i.test(text)) return 'Urgent sale wording detected';
  return null;
}

function detectBulkMixedWording(text: string): string | null {
  if (/\bbulk\b/i.test(text)) return 'Bulk wording suggests multi-item lot';
  if (/\bmixed\b/i.test(text) && /\b(set|bundle|lot|items?)\b/i.test(text)) return 'Mixed bundle wording detected';
  if (/\bjob\s+lot\b/i.test(text)) return 'Job lot wording detected';
  if (/\bassorted\b/i.test(text)) return 'Assorted wording suggests vague bundle';
  if (/\blot\s+of\s+\d+\b/i.test(text)) return 'Lot-of-N wording detected';
  if (/\bbundle\b/i.test(text) && !/\bwith\b/i.test(text)) return 'Bundle wording suggests multi-item sale';
  if (/\bset\b/i.test(text) && !/\b(iron|club)\s+set\b/i.test(text)) return 'Generic set wording detected';
  if (/\b\d+\s*x\b|\bx\s*\d+\b/i.test(text)) return 'Quantity prefix/suffix detected';
  return null;
}

function scoreSpecificity(title?: string | null, description?: string | null): { singleItemSignal?: string; specificListing?: string; vagueListing?: string } {
  const titleText = normalize(title);
  const descriptionText = normalize(description);
  const result: { singleItemSignal?: string; specificListing?: string; vagueListing?: string } = {};

  if (titleText.length > 0 && titleText.split(/\s+/).length <= 2) {
    result.vagueListing = 'Very short title reads generic rather than model-specific';
  }

  if (/\b(with|includes?|incl\.?|headcover|bindings|helmet bag|case)\b/i.test(`${titleText} ${descriptionText}`)) {
    result.singleItemSignal = 'Accessory/include wording suggests a concrete single listing';
  }

  const titleTokens = titleText.split(/\s+/).filter(Boolean);
  if (titleTokens.length >= 4 && /\d/.test(titleText)) {
    result.specificListing = 'Specific title includes multiple tokens and a model/spec number';
  } else if (titleTokens.length >= 5) {
    result.specificListing = 'Specific multi-token title';
  }

  if (/\b(misc|various|random|bundle|job lot|bulk|mixed|assorted|stuff|gear)\b/i.test(`${titleText} ${descriptionText}`)) {
    result.vagueListing = 'Vague or mixed-item wording detected';
  }

  return result;
}

function detectSpecCues(haystack: string): ScoreReason[] {
  const seen = new Set<string>();
  const reasons: ScoreReason[] = [];

  for (const candidate of SPEC_PATTERNS) {
    if (candidate.pattern.test(haystack) && !seen.has(candidate.detail)) {
      seen.add(candidate.detail);
      reasons.push({ code: 'SPEC_CUE', weight: candidate.weight, detail: candidate.detail });
    }
  }

  return reasons;
}
