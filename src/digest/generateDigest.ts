import type { RunStatus, ScoredObservation, SearchProfile, ValuationAssessment } from '../types.js';

export type DigestFormat = 'discord' | 'email';

export type DigestInput = {
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  scored: ScoredObservation[];
  profiles: SearchProfile[];
  suspiciousProfiles: string[];
  failedProfiles?: Record<string, string>;
};

export function generateDigest(input: DigestInput, format: DigestFormat = 'discord'): string {
  const sections = buildSections(input.scored);
  const failedProfileIds = Object.keys(input.failedProfiles ?? {});
  const runTimeLabel = formatRunWindow(input.startedAt, input.finishedAt);
  const header = [
    'FB MARKETPLACE SHORTLIST',
    `${runTimeLabel}`,
    `Profiles: ${summarizeProfiles(input.profiles)}`,
    `Seen ${input.scored.length} • Shortlisted ${sections.shortlist.length}${sections.watchlist.length > 0 ? ` • Watchlist ${sections.watchlist.length}` : ''}`
  ];

  if (input.status !== 'success') header.push(`Status: ${input.status}`);
  if (input.suspiciousProfiles.length > 0) header.push(`Suspicious empty: ${input.suspiciousProfiles.join(', ')}`);
  if (failedProfileIds.length > 0) header.push(`Failed profiles: ${failedProfileIds.join(', ')}`);

  const blocks = [
    renderSection('🎯 SHORTLIST', sections.shortlist, format),
    renderSection('👀 WATCHLIST', sections.watchlist, format),
    renderRunNotes(input)
  ].filter(Boolean) as string[];

  return [...header, '', ...blocks].join('\n\n').trim();
}

function buildSections(scored: ScoredObservation[]) {
  const ranked = [...scored].sort(compareItems);
  const shortlist: ScoredObservation[] = [];
  const watchlist: ScoredObservation[] = [];

  for (const item of ranked) {
    if (isShortlistItem(item) && shortlist.length < 6) {
      shortlist.push(item);
      continue;
    }

    if (isWatchlistItem(item) && watchlist.length < 4) {
      watchlist.push(item);
    }
  }

  if (shortlist.length === 0) {
    shortlist.push(...ranked.filter(isWatchlistItem).slice(0, 3));
  }

  return { shortlist, watchlist };
}

function renderSection(title: string, items: ScoredObservation[], format: DigestFormat): string | null {
  if (items.length === 0) return null;
  return `${title}\n${items.map((item, index) => renderItem(item, index + 1, format)).join('\n')}`;
}

function renderItem(item: ScoredObservation, index: number, format: DigestFormat): string {
  const priceLabel = formatPrice(item.price, item.currency, item.priceText);
  const badge = getAssessmentBadge(item.valuation.assessment);
  const location = item.location ?? 'Unknown location';
  const range = getRangeLabel(item);
  const summary = summarizeForShortlist(item);
  const value = range ? `${getValueLabel(item.valuation.assessment)} vs ${range}` : getValueLabel(item.valuation.assessment);
  const link = format === 'discord' ? `<${item.url}>` : item.url;
  return `${index}) ${badge} ${item.title} — ${priceLabel} — ${location}\n   ${summary} | ${value} | ${link}`;
}

function renderRunNotes(input: DigestInput): string {
  const notes: string[] = [];
  const bundleCount = input.scored.filter((item) => item.valuation.classification.listingType === 'bundle_or_set').length;
  const withheldCount = input.scored.filter((item) => item.valuation.assessment === 'withheld' || item.valuation.assessment === 'uncertain').length;
  if (bundleCount > 0) notes.push(`${bundleCount} bundle/set listing${bundleCount === 1 ? '' : 's'} were kept out of the shortlist unless unusually strong.`);
  if (withheldCount > 0) notes.push(`${withheldCount} noisy/unclear listing${withheldCount === 1 ? '' : 's'} were downgraded or withheld.`);
  if (notes.length === 0) notes.push('Clean run.');
  return `🧠 NOTES\n- ${notes.slice(0, 2).join('\n- ')}`;
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

function isShortlistItem(item: ScoredObservation): boolean {
  return item.valuation.classification.listingType === 'single_item'
    && item.valuation.classification.confidence !== 'low'
    && item.valuation.assessment !== 'withheld'
    && item.valuation.assessment !== 'uncertain'
    && !hasHardFilterMiss(item)
    && item.score >= 55;
}

function isWatchlistItem(item: ScoredObservation): boolean {
  const goodBundle = item.valuation.classification.listingType === 'bundle_or_set'
    && item.valuation.classification.confidence !== 'low'
    && (item.valuation.assessment === 'attractive' || item.valuation.assessment === 'fair')
    && item.score >= 50;

  const goodSingle = item.valuation.classification.listingType === 'single_item'
    && item.valuation.classification.confidence !== 'low'
    && item.valuation.assessment !== 'withheld'
    && item.score >= 35;

  return !hasHardFilterMiss(item) && (goodSingle || goodBundle);
}

function hasHardFilterMiss(item: ScoredObservation): boolean {
  return item.reasons.some((reason) => reason.detail === 'Missing any required high-signal keyword for this profile' || reason.code === 'UNWANTED_VARIANT');
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

function summarizeForShortlist(item: ScoredObservation): string {
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
