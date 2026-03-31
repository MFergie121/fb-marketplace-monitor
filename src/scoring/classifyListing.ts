import type { ListingClassification, ListingObservation } from '../types.js';

const ACCESSORY_TERMS = [
  'shaft', 'shafts', 'headcover', 'head cover', 'grip', 'grips', 'bag', 'cover', 'strap', 'case', 'lens', 'replacement', 'spare',
  'accessory', 'accessories', 'parts', 'part', 'repair', 'service', 'fitting', 'lessons', 'lesson', 'booking', 'hire', 'rental',
  'custom', 'reshaft', 'paint fill', 'paintfill', 'trade in', 'trade-in', 'adapter', 'adaptor', 'sleeve', 'tool', 'torque wrench', 'wrench'
];

const HARD_MODIFICATION_TERMS = ['head only', 'shaft only', 'no head', 'no shaft', 'headcover only', 'cover only', 'bag only', 'grip only', 'for parts', 'broken'];
const BUNDLE_TERMS = ['bundle', 'lot', 'bulk', 'assorted', 'mixed', 'collection', 'job lot', 'package deal'];
const MULTI_ITEM_TERMS = ['driver', 'fairway wood', 'wood', 'hybrid', 'irons', 'iron set', 'putter', 'wedge', 'bag', 'helmet', 'goggles', 'bindings', 'boots', 'rods', 'reels'];
const PRIMARY_ITEM_TERMS = ['driver', 'fairway wood', 'wood', 'hybrid', 'irons', 'iron set', 'putter', 'wedge', 'watch', 'helmet', 'goggles', 'skis', 'rod', 'reel'];
const SET_TERMS = ['set', 'full set', 'iron set'];

export function classifyListing(observation: ListingObservation): ListingClassification {
  const haystack = normalize([observation.title, observation.description, observation.postedText].filter(Boolean).join(' '));
  const matchedSignals = new Set<string>();
  const identifiedComponents = detectComponents(haystack);

  const accessoryHits = ACCESSORY_TERMS.filter((term) => haystack.includes(term));
  const modificationHits = HARD_MODIFICATION_TERMS.filter((term) => haystack.includes(term));
  const bundleHits = BUNDLE_TERMS.filter((term) => haystack.includes(term));
  const hasSetWording = SET_TERMS.some((term) => haystack.includes(term));
  const hasPerItemPricing = /\bfrom\s+(?:au\$|\$)?\s*\d|\beach\b|\bper\s+(?:item|piece|pc)\b|(?<![a-z])\bea\b(?![a-z])/i.test(haystack);
  const hasQuantitySignal = /\b\d+\s*x\b|\bx\s*\d+\b|\b\d+\s+(?:clubs|items|pairs|pieces|pcs|rods)\b/i.test(haystack);
  const looksLikeService = /\b(service|repair|lesson|lessons|booking|fitting|rental|hire)\b/i.test(haystack);
  const hasPrimaryItemSignal = PRIMARY_ITEM_TERMS.some((term) => haystack.includes(term));
  const hardAccessoryOnly = modificationHits.length > 0;
  const looksLikeAccessoryOnly = accessoryHits.length > 0 || hardAccessoryOnly || looksLikeService;

  if (hardAccessoryOnly) {
    accessoryHits.forEach((hit) => matchedSignals.add(`accessory:${hit}`));
    modificationHits.forEach((hit) => matchedSignals.add(`modification:${hit}`));
    return {
      listingType: 'accessory_service_modification',
      confidence: 'high',
      summary: 'Head-only / shaft-only / parts wording makes this unsafe as a buyer-facing club listing',
      matchedSignals: [...matchedSignals],
      identifiedComponents,
      canDecomposeBundle: false
    };
  }

  if (looksLikeAccessoryOnly && !hasPrimaryItemSignal && identifiedComponents.length <= 1 && !hasSetWording && bundleHits.length === 0) {
    accessoryHits.forEach((hit) => matchedSignals.add(`accessory:${hit}`));
    modificationHits.forEach((hit) => matchedSignals.add(`modification:${hit}`));
    if (looksLikeService) matchedSignals.add('service_wording');
    return {
      listingType: 'accessory_service_modification',
      confidence: 'high',
      summary: 'Accessory, service, or modification wording dominates the listing',
      matchedSignals: [...matchedSignals],
      identifiedComponents,
      canDecomposeBundle: false
    };
  }

  if (bundleHits.length > 0 || hasPerItemPricing || hasQuantitySignal || (hasSetWording && !/\b(single|one)\b/i.test(haystack)) || identifiedComponents.length >= 2) {
    bundleHits.forEach((hit) => matchedSignals.add(`bundle:${hit}`));
    if (hasPerItemPricing) matchedSignals.add('per_item_pricing');
    if (hasQuantitySignal) matchedSignals.add('quantity_signal');
    if (hasSetWording) matchedSignals.add('set_wording');
    if (identifiedComponents.length >= 2) matchedSignals.add(`components:${identifiedComponents.join('+')}`);

    const confidence = identifiedComponents.length >= 2 || hasSetWording ? 'high' : 'medium';
    return {
      listingType: 'bundle_or_set',
      confidence,
      summary: identifiedComponents.length >= 2
        ? `Bundle/set listing with identifiable components: ${identifiedComponents.join(', ')}`
        : 'Bundle/set listing detected, but components are only partially identified',
      matchedSignals: [...matchedSignals],
      identifiedComponents,
      canDecomposeBundle: identifiedComponents.length >= 2 || hasSetWording
    };
  }

  const singleItemSignals: string[] = [];
  if (/\bwith\b|\bincludes?\b|\bheadcover\b|\bbindings\b/i.test(haystack)) singleItemSignals.push('includes_accessory_language');
  if (identifiedComponents.length === 1) singleItemSignals.push(`component:${identifiedComponents[0]}`);
  if (/\b(driver|putter|helmet|goggles|watch|rod|reel)\b/i.test(haystack) && !/\b(set|bundle|lot|bulk)\b/i.test(haystack)) singleItemSignals.push('single_item_noun');

  if (singleItemSignals.length > 0) {
    singleItemSignals.forEach((signal) => matchedSignals.add(signal));
    return {
      listingType: 'single_item',
      confidence: identifiedComponents.length === 1 ? 'high' : 'medium',
      summary: identifiedComponents.length === 1
        ? `Single-item listing centred on ${identifiedComponents[0]}`
        : 'Single-item wording dominates without bundle/service signals',
      matchedSignals: [...matchedSignals],
      identifiedComponents,
      canDecomposeBundle: false
    };
  }

  return {
    listingType: 'ambiguous',
    confidence: 'low',
    summary: 'Listing does not read cleanly as a single item, clear bundle, or accessory/service listing',
    matchedSignals: [...matchedSignals],
    identifiedComponents,
    canDecomposeBundle: false
  };
}

function detectComponents(text: string): string[] {
  const found = new Set<string>();
  for (const term of MULTI_ITEM_TERMS) {
    if (text.includes(term)) found.add(term);
  }
  if (/\birons?\b/i.test(text)) found.add('irons');
  if (/\bdriver\b/i.test(text)) found.add('driver');
  if (/\bputter\b/i.test(text)) found.add('putter');
  if (/\bwedge\b/i.test(text)) found.add('wedge');
  if (/\bhelmet\b/i.test(text)) found.add('helmet');
  if (/\bgoggles\b/i.test(text)) found.add('goggles');
  if (/\bskis?\b/i.test(text)) found.add('skis');
  return [...found];
}

function normalize(value?: string | null): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
