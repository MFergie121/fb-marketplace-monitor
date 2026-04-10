import type { RunStatus, ScoredObservation, SearchProfile, ValuationAssessment } from '../types.js';

export type DigestFormat = 'discord' | 'email';
export type BuyerBucket = 'top_pick' | 'worth_a_look';

export type DigestInput = {
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  scored: ScoredObservation[];
  profiles: SearchProfile[];
  suspiciousProfiles: string[];
  failedProfiles?: Record<string, string>;
};

type BuyerProfileSection = {
  profile: SearchProfile;
  topPicks: ScoredObservation[];
  worthALook: ScoredObservation[];
  buyerSafeCount: number;
};

type BuyerSections = {
  byProfile: BuyerProfileSection[];
  topPicks: ScoredObservation[];
  worthALook: ScoredObservation[];
  filteredSummary: string[];
};

export type BuyerCandidate = {
  bucket: BuyerBucket;
  profile: SearchProfile;
  item: ScoredObservation;
};

const PROFILE_TOP_PICK_CAP = 1;
const PROFILE_WORTH_A_LOOK_CAP = 2;
const PROFILE_TOTAL_SURFACED_CAP = 3;

export function generateDigest(input: DigestInput, format: DigestFormat = 'discord'): string {
  const sections = buildBuyerSections(input.scored, input.profiles);
  const runTimeLabel = formatRunWindow(input.startedAt, input.finishedAt);
  const header = [
    'FB MARKETPLACE BUYER BRIEF',
    runTimeLabel,
    `Profiles: ${summarizeProfiles(input.profiles)}`
  ];

  const blocks = [
    renderBuyerProfiles(sections.byProfile, format),
    renderFilteredSummary(sections.filteredSummary),
    renderBuyerFooter(input, sections)
  ].filter(Boolean) as string[];

  return [...header, '', ...blocks].join('\n\n').trim();
}

export function generateDebugDigest(input: DigestInput, format: DigestFormat = 'discord'): string {
  const sections = buildLegacySections(input.scored);
  const failedProfileIds = Object.keys(input.failedProfiles ?? {});
  const runTimeLabel = formatRunWindow(input.startedAt, input.finishedAt);
  const buyerSections = buildBuyerSections(input.scored, input.profiles);
  const header = [
    'FB MARKETPLACE DEBUG DIGEST',
    `${runTimeLabel}`,
    `Profiles: ${summarizeProfiles(input.profiles)}`,
    `Seen ${input.scored.length} • Buyer top picks ${buyerSections.topPicks.length}${sections.watchlist.length > 0 ? ` • Debug watchlist ${sections.watchlist.length}` : ''}`
  ];

  if (input.status !== 'success') header.push(`Status: ${input.status}`);
  if (input.suspiciousProfiles.length > 0) header.push(`Suspicious empty: ${input.suspiciousProfiles.join(', ')}`);
  if (failedProfileIds.length > 0) header.push(`Failed profiles: ${failedProfileIds.join(', ')}`);

  const blocks = [
    renderDebugSection('🎯 DEBUG SHORTLIST', sections.shortlist, format),
    renderDebugSection('👀 DEBUG WATCHLIST', sections.watchlist, format),
    renderRunNotes(input)
  ].filter(Boolean) as string[];

  return [...header, '', ...blocks].join('\n\n').trim();
}

export function collectBuyerCandidates(scored: ScoredObservation[], profiles: SearchProfile[]): BuyerCandidate[] {
  const sections = buildBuyerSections(scored, profiles);
  return sections.byProfile.flatMap((section) => [
    ...section.topPicks.map((item) => ({ bucket: 'top_pick' as const, profile: section.profile, item })),
    ...section.worthALook.map((item) => ({ bucket: 'worth_a_look' as const, profile: section.profile, item }))
  ]);
}

function buildBuyerSections(scored: ScoredObservation[], profiles: SearchProfile[]): BuyerSections {
  const byProfile = profiles.map((profile) => {
    const ranked = scored
      .filter((item) => item.profileId === profile.id)
      .sort(compareItems);
    const buyerSafe = ranked.filter(isBuyerFacingSafe);
    const topPicks = buyerSafe.filter(isTopPick).slice(0, PROFILE_TOP_PICK_CAP);
    const worthALook = buyerSafe
      .filter((item) => isWorthALook(item) && !topPicks.some((pick) => pick.externalId === item.externalId))
      .slice(0, Math.max(0, Math.min(PROFILE_WORTH_A_LOOK_CAP, PROFILE_TOTAL_SURFACED_CAP - topPicks.length)));

    return {
      profile,
      topPicks,
      worthALook,
      buyerSafeCount: buyerSafe.length
    } satisfies BuyerProfileSection;
  });

  const topPicks = byProfile.flatMap((section) => section.topPicks);
  const worthALook = byProfile.flatMap((section) => section.worthALook);
  const filteredSummary = buildFilteredSummary(scored, { topPicks, worthALook });
  return { byProfile, topPicks, worthALook, filteredSummary };
}

function buildLegacySections(scored: ScoredObservation[]) {
  const ranked = [...scored].sort(compareItems);
  const shortlist: ScoredObservation[] = [];
  const watchlist: ScoredObservation[] = [];

  for (const item of ranked) {
    if (isTopPick(item) && shortlist.length < 6) {
      shortlist.push(item);
      continue;
    }

    if (isWorthALook(item) && watchlist.length < 4) {
      watchlist.push(item);
    }
  }

  if (shortlist.length === 0) {
    shortlist.push(...ranked.filter(isWorthALook).slice(0, 3));
  }

  return { shortlist, watchlist };
}

function renderBuyerProfiles(sections: BuyerProfileSection[], format: DigestFormat): string {
  const blocks = sections.map((section) => renderBuyerProfileSection(section, format));
  return `🧭 BY ACTIVE SUBTOPIC\n${blocks.join('\n\n')}`;
}

function renderBuyerProfileSection(section: BuyerProfileSection, format: DigestFormat): string {
  const surfaced = [...section.topPicks, ...section.worthALook];
  const title = `• ${section.profile.label}`;

  if (surfaced.length === 0) {
    return `${title}\n  - No buyer-safe listings cleared the minimum quality floor this run.`;
  }

  const lines: string[] = [];
  if (section.topPicks.length > 0) {
    lines.push(...section.topPicks.map((item, index) => `  - 🔥 ${renderBuyerItem(item, index + 1, format)}`));
  }
  if (section.worthALook.length > 0) {
    lines.push(...section.worthALook.map((item, index) => `  - 👀 ${renderBuyerItem(item, section.topPicks.length + index + 1, format)}`));
  }
  if (section.buyerSafeCount > surfaced.length) {
    lines.push(`  - +${section.buyerSafeCount - surfaced.length} more buyer-safe option${section.buyerSafeCount - surfaced.length === 1 ? '' : 's'} in this subtopic.`);
  }

  return `${title}\n${lines.join('\n')}`;
}

function renderBuyerItem(item: ScoredObservation, index: number, format: DigestFormat): string {
  const priceLabel = formatPrice(item.price, item.currency, item.priceText);
  const location = item.location ?? 'Unknown location';
  const link = format === 'discord' ? `<${item.url}>` : item.url;
  const angle = describeBuyerAngle(item);
  return `${index}) ${item.title} — ${priceLabel} — ${location}\n    ${angle} | ${link}`;
}

function renderFilteredSummary(summary: string[]): string {
  return `🧹 FILTERED OUT\n- ${summary.join('\n- ')}`;
}

function renderBuyerFooter(input: DigestInput, sections: BuyerSections): string {
  const failedProfiles = Object.keys(input.failedProfiles ?? {});
  const profilesWithHits = sections.byProfile.filter((section) => section.topPicks.length + section.worthALook.length > 0).length;
  const profilesWithoutHits = sections.byProfile.length - profilesWithHits;
  const footer: string[] = [
    `Seen ${input.scored.length} listings • surfaced ${sections.topPicks.length + sections.worthALook.length} buyer-safe candidates across ${profilesWithHits}/${sections.byProfile.length} active subtopics`
  ];

  if (profilesWithoutHits > 0) footer.push(`${profilesWithoutHits} active subtopic${profilesWithoutHits === 1 ? '' : 's'} had no listings strong enough to include.`);
  if (input.status !== 'success') footer.push(`Run status: ${input.status}`);
  if (input.suspiciousProfiles.length > 0) footer.push(`Suspicious empty: ${input.suspiciousProfiles.join(', ')}`);
  if (failedProfiles.length > 0) footer.push(`Failed profiles: ${failedProfiles.join(', ')}`);

  return `ℹ️ FOOTER\n- ${footer.join('\n- ')}`;
}

function renderDebugSection(title: string, items: ScoredObservation[], format: DigestFormat): string | null {
  if (items.length === 0) return null;
  return `${title}\n${items.map((item, index) => renderDebugItem(item, index + 1, format)).join('\n')}`;
}

function renderDebugItem(item: ScoredObservation, index: number, format: DigestFormat): string {
  const priceLabel = formatPrice(item.price, item.currency, item.priceText);
  const badge = getAssessmentBadge(item.valuation.assessment);
  const location = item.location ?? 'Unknown location';
  const range = getRangeLabel(item);
  const summary = summarizeForDebug(item);
  const value = range ? `${getValueLabel(item.valuation.assessment)} vs ${range}` : getValueLabel(item.valuation.assessment);
  const link = format === 'discord' ? `<${item.url}>` : item.url;
  return `${index}) ${badge} ${item.title} — ${priceLabel} — ${location}\n   ${summary} | ${value} | ${link}`;
}

function renderRunNotes(input: DigestInput): string {
  const notes: string[] = [];
  const bundleCount = input.scored.filter((item) => item.valuation.classification.listingType === 'bundle_or_set').length;
  const withheldCount = input.scored.filter((item) => item.valuation.assessment === 'withheld' || item.valuation.assessment === 'uncertain').length;
  const accessoryCount = input.scored.filter((item) => item.valuation.classification.listingType === 'accessory_service_modification').length;
  if (bundleCount > 0) notes.push(`${bundleCount} bundle/set listing${bundleCount === 1 ? '' : 's'} were kept out of buyer-facing top picks unless unusually strong.`);
  if (accessoryCount > 0) notes.push(`${accessoryCount} accessory/modification listing${accessoryCount === 1 ? '' : 's'} were excluded from the buyer brief.`);
  if (withheldCount > 0) notes.push(`${withheldCount} noisy/unclear listing${withheldCount === 1 ? '' : 's'} were downgraded or withheld.`);
  if (notes.length === 0) notes.push('Clean run.');
  return `🧠 NOTES\n- ${notes.slice(0, 3).join('\n- ')}`;
}

function summarizeProfiles(profiles: SearchProfile[]): string {
  const labels = profiles.map((profile) => profile.label);
  return labels.length <= 3 ? labels.join(', ') : `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more`;
}

function formatRunWindow(startedAt: string, finishedAt: string): string {
  const end = new Date(finishedAt);
  const start = new Date(startedAt);
  const dateLabel = new Intl.DateTimeFormat('en-AU', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Australia/Melbourne'
  }).format(end);
  const durationMinutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  return `${dateLabel} Melbourne${durationMinutes > 0 ? ` (${durationMinutes} min)` : ''}`;
}

function isTopPick(item: ScoredObservation): boolean {
  return isBuyerFacingSafe(item)
    && item.valuation.assessment === 'attractive'
    && item.score >= 70;
}

function isWorthALook(item: ScoredObservation): boolean {
  return isBuyerFacingSafe(item)
    && (item.valuation.assessment === 'attractive' || item.valuation.assessment === 'fair')
    && item.score >= 52;
}

function isBuyerFacingSafe(item: ScoredObservation): boolean {
  const listingType = item.valuation.classification.listingType;
  const allowedListingType = listingType === 'single_item'
    || (listingType === 'bundle_or_set' && item.valuation.classification.canDecomposeBundle);
  if (!allowedListingType) return false;
  if (item.valuation.classification.confidence === 'low') return false;
  if (item.valuation.assessment === 'withheld' || item.valuation.assessment === 'uncertain') return false;
  if (hasHardFilterMiss(item)) return false;
  if (looksAccessoryOrModificationHeavy(item)) return false;
  if (item.score < 45) return false;
  return true;
}

function looksAccessoryOrModificationHeavy(item: ScoredObservation): boolean {
  const haystack = [item.title, item.description, item.postedText, item.condition].filter(Boolean).join(' ').toLowerCase();
  const hardTerms = [
    'head only', 'shaft only', 'no head', 'no shaft', 'driver head', 'club head', 'headcover only', 'grip only', 'grips', 'adapter', 'adaptor',
    'tool', 'torque wrench', 'wrench', 'bag only', 'cover only', 'for parts', 'broken', 'reshaft', 'paint fill', 'paintfill'
  ];

  if (hardTerms.some((term) => haystack.includes(term))) return true;

  return item.reasons.some((reason) => {
    if (reason.code === 'UNWANTED_VARIANT' || reason.code === 'LISTING_TYPE_ACCESSORY_SERVICE') return true;
    return /head only|shaft only|headcover only|adapter|adaptor|grip|cover only|bag only|tool|wrench|for parts|broken/i.test(reason.detail);
  });
}

function hasHardFilterMiss(item: ScoredObservation): boolean {
  return item.reasons.some((reason) => reason.detail === 'Missing any required high-signal keyword for this profile' || reason.code === 'UNWANTED_VARIANT');
}

function buildFilteredSummary(scored: ScoredObservation[], sections: { topPicks: ScoredObservation[]; worthALook: ScoredObservation[] }): string[] {
  const surfacedIds = new Set([...sections.topPicks, ...sections.worthALook].map((item) => item.externalId));
  const filtered = scored.filter((item) => !surfacedIds.has(item.externalId));
  const accessoryCount = filtered.filter((item) => looksAccessoryOrModificationHeavy(item) || item.valuation.classification.listingType === 'accessory_service_modification').length;
  const bundleCount = filtered.filter((item) => item.valuation.classification.listingType === 'bundle_or_set').length;
  const weakSignalCount = filtered.filter((item) => hasHardFilterMiss(item) || item.valuation.assessment === 'withheld' || item.valuation.assessment === 'uncertain' || item.score < 45).length;
  const overpricedCount = filtered.filter((item) => item.valuation.assessment === 'overpriced').length;

  const lines: string[] = [];
  if (accessoryCount > 0) lines.push(`${accessoryCount} accessory / modification listing${accessoryCount === 1 ? '' : 's'} kept out of the buyer brief.`);
  if (bundleCount > 0) lines.push(`${bundleCount} bundle / set listing${bundleCount === 1 ? '' : 's'} held back to avoid muddy comps.`);
  if (weakSignalCount > 0) lines.push(`${weakSignalCount} weak-signal or unclear listing${weakSignalCount === 1 ? '' : 's'} omitted on trust grounds.`);
  if (overpricedCount > 0) lines.push(`${overpricedCount} overpriced listing${overpricedCount === 1 ? '' : 's'} skipped.`);
  if (lines.length === 0) lines.push('Nothing major was filtered beyond the surfaced picks.');
  return lines.slice(0, 3);
}

function compareItems(a: ScoredObservation, b: ScoredObservation): number {
  return getAssessmentRank(b.valuation.assessment) - getAssessmentRank(a.valuation.assessment)
    || b.score - a.score
    || a.title.localeCompare(b.title);
}

function getAssessmentRank(assessment: ValuationAssessment): number {
  switch (assessment) {
    case 'attractive':
      return 5;
    case 'fair':
      return 4;
    case 'overpriced':
      return 3;
    case 'uncertain':
      return 2;
    case 'withheld':
      return 1;
    default:
      return 0;
  }
}

function getAssessmentBadge(assessment: ValuationAssessment): string {
  switch (assessment) {
    case 'attractive':
      return '🟢';
    case 'fair':
      return '⚪';
    case 'overpriced':
      return '🔴';
    case 'uncertain':
      return '🟡';
    case 'withheld':
      return '⚫';
    default:
      return '⚪';
  }
}

function getValueLabel(assessment: ValuationAssessment): string {
  switch (assessment) {
    case 'attractive':
      return 'attractive';
    case 'fair':
      return 'fair';
    case 'overpriced':
      return 'overpriced';
    case 'uncertain':
      return 'uncertain';
    case 'withheld':
      return 'withheld';
    default:
      return 'unknown';
  }
}

function getRangeLabel(item: ScoredObservation): string | null {
  if (item.valuation.sources.length === 0) return null;
  const low = Math.min(...item.valuation.sources.map((source) => source.priceLow));
  const high = Math.max(...item.valuation.sources.map((source) => source.priceHigh));
  return `${formatCurrency(low, item.currency)}–${formatCurrency(high, item.currency)}`;
}

function summarizeForDebug(item: ScoredObservation): string {
  const positiveReasons = item.reasons
    .filter((reason) => reason.weight > 0)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 2)
    .map((reason) => reason.detail.replace(/^Brand match: /, '').replace(/^Model family match: /, ''));

  const watchout = item.reasons
    .filter((reason) => reason.weight < 0)
    .sort((left, right) => left.weight - right.weight)[0]?.detail;

  const parts = [
    positiveReasons.length > 0 ? positiveReasons.join(', ') : compact(item.valuation.classification.summary, 70),
    watchout ? `watch: ${compact(watchout, 55)}` : null
  ].filter(Boolean) as string[];

  return compact(parts.join(' | '), 140);
}

export function describeBuyerAngle(item: ScoredObservation): string {
  const range = getRangeLabel(item);
  const modelOrBrand = item.reasons
    .filter((reason) => reason.code === 'MODEL_FAMILY_MATCH' || reason.code === 'BRAND_MATCH')
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 2)
    .map((reason) => reason.detail.replace(/^Brand match: /, '').replace(/^Model family match: /, ''));
  const why = modelOrBrand.length > 0 ? modelOrBrand.join(', ') : item.valuation.classification.summary;
  const value = item.valuation.assessment === 'attractive'
    ? (range ? `priced well vs ${range}` : 'priced attractively')
    : (range ? `roughly in the ${range} used range` : 'worth a closer look');
  return compact(`${why} • ${value}`, 120);
}

function formatPrice(price?: number | null, currency?: string | null, priceText?: string | null): string {
  if (priceText && /^free$/i.test(priceText)) return 'Free';
  if (priceText && typeof price !== 'number') return priceText;
  if (typeof price !== 'number') return 'Price n/a';
  return formatCurrency(price, currency);
}

function formatCurrency(value: number, currency?: string | null): string {
  return `${currency === 'AUD' || !currency ? '$' : `${currency} `}${Math.round(value)}`;
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
