import type { RunStatus, ScoredObservation, SearchProfile, ValuationAssessment, ListingType, ListingTypeConfidence } from '../types.js';

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
  const enrichedCount = input.scored.filter((item) => Boolean(item.description || item.condition || item.detailCollectedAt)).length;
  const strongCount = sections.topPicks.length;
  const profileSummary = summarizeProfiles(input.profiles);
  const searchSummary = summarizeSearches(input.profiles);
  const runTimeLabel = formatRunWindow(input.startedAt, input.finishedAt);
  const divider = format === 'email' ? ' | ' : ' • ';
  const sectionSpacer = format === 'email' ? '\n\n' : '\n';

  const header = [
    'FB MARKETPLACE DIGEST',
    `Profiles: ${profileSummary}`,
    `Run: ${runTimeLabel}`,
    `Searches used: ${searchSummary}`,
    `Seen: ${input.scored.length}${divider}Enriched: ${enrichedCount}${divider}Strong candidates: ${strongCount}`,
    `Summary: ${summarizeSections(sections)}`
  ];

  if (input.status !== 'success') {
    header.push(`Status: ${input.status}`);
  }

  if (input.suspiciousProfiles.length > 0) {
    header.push(`Suspicious empty: ${input.suspiciousProfiles.join(', ')}`);
  }

  if (failedProfileIds.length > 0) {
    header.push(`Failed profiles: ${failedProfileIds.join(', ')}`);
  }

  const legend = [
    'Legend',
    '🟢 strong deal   🟡 possible deal   ⚪ fair / relevant   🔴 overpriced   ⚫ withheld / uncertain',
    '🎯 single item   📦 bundle / set    🧩 accessory / mod   ❓ ambiguous',
    '✅ high confidence   ☑️ medium confidence   ⚠️ low confidence'
  ];

  const sectionBlocks = [
    renderSection('🔥 TOP PICKS', sections.topPicks, format),
    renderSection('👀 WORTH CHECKING', sections.worthChecking, format),
    renderSection('📦 BUNDLES / SETS', sections.bundles, format),
    renderSection('⚫ WITHHELD / UNCERTAIN', sections.withheld, format),
    renderRunNotes(input, format)
  ].filter(Boolean) as string[];

  return [...header, '', ...legend, '', sectionBlocks.join(sectionSpacer)].join('\n').trim();
}

function buildSections(scored: ScoredObservation[]) {
  const ranked = [...scored].sort(compareItems);
  const sections = {
    topPicks: [] as ScoredObservation[],
    worthChecking: [] as ScoredObservation[],
    bundles: [] as ScoredObservation[],
    withheld: [] as ScoredObservation[]
  };

  for (const item of ranked) {
    if (isWithheldSection(item)) {
      if (sections.withheld.length < 4) sections.withheld.push(item);
      continue;
    }

    if (item.valuation.classification.listingType === 'bundle_or_set') {
      if (sections.bundles.length < 4) sections.bundles.push(item);
      continue;
    }

    if (isTopPick(item) && sections.topPicks.length < 5) {
      sections.topPicks.push(item);
      continue;
    }

    if (sections.worthChecking.length < 5) {
      sections.worthChecking.push(item);
    }
  }

  if (sections.topPicks.length === 0 && sections.worthChecking.length > 0) {
    sections.topPicks.push(...sections.worthChecking.splice(0, Math.min(3, sections.worthChecking.length)));
  }

  return sections;
}

function renderSection(title: string, items: ScoredObservation[], format: DigestFormat): string | null {
  if (items.length === 0) return null;
  const body = items.map((item, index) => renderItem(item, index + 1, format)).join(format === 'email' ? '\n\n' : '\n');
  return `${title}\n\n${body}`;
}

function renderItem(item: ScoredObservation, index: number, format: DigestFormat): string {
  const statusBadge = getAssessmentBadge(item.valuation.assessment);
  const typeBadge = getListingTypeBadge(item.valuation.classification.listingType);
  const confidenceBadge = getConfidenceBadge(item.valuation.classification.confidence);
  const priceLabel = formatPrice(item.price, item.currency, item.priceText);
  const valueLabel = getValueLabel(item.valuation.assessment);
  const linkLabel = format === 'discord' ? `<${item.url}>` : item.url;
  const why = summarizeWhyItMatters(item, format);
  const watchOuts = summarizeWatchOuts(item, format);
  const lines = [
    `${index}) ${statusBadge} ${item.title}`,
    formatDetailLine(format, 'Price', priceLabel),
    formatDetailLine(format, 'Type', `${typeBadge} ${getListingTypeLabel(item.valuation.classification.listingType)}`),
    formatDetailLine(format, 'Location', item.location ?? 'Unknown'),
    formatDetailLine(format, 'Confidence', `${confidenceBadge} ${getConfidenceLabel(item.valuation.classification.confidence)}`),
    ...renderValuationLines(item, format, valueLabel),
    formatDetailLine(format, 'Why it matters', why),
    formatDetailLine(format, 'Watch-outs', watchOuts),
    formatDetailLine(format, 'Link', linkLabel)
  ];

  return lines.join('\n');
}

function renderValuationLines(item: ScoredObservation, format: DigestFormat, valueLabel: string): string[] {
  if (item.valuation.assessment === 'withheld' || item.valuation.assessment === 'uncertain') {
    return [formatDetailLine(format, 'Value', 'Withheld / uncertain'), formatDetailLine(format, 'Why withheld', compact(item.valuation.summary, 120))];
  }

  const range = getRangeLabel(item);
  const lines = [formatDetailLine(format, 'Value', valueLabel)];
  if (range) lines.push(formatDetailLine(format, 'Est. range', range));
  return lines;
}

function renderRunNotes(input: DigestInput, format: DigestFormat): string {
  const notes = buildRunNotes(input);
  const prefix = format === 'email' ? '- ' : '- ';
  return ['🧠 RUN NOTES', '', ...notes.map((note) => `${prefix}${note}`)].join('\n');
}

function buildRunNotes(input: DigestInput): string[] {
  const notes: string[] = [];
  const profilesWithExpansions = input.profiles.filter((profile) => (profile.searchExpansions?.length ?? 0) > 0);
  if (profilesWithExpansions.length > 0) {
    notes.push(`Search augmentation was active for ${profilesWithExpansions.length} profile${profilesWithExpansions.length === 1 ? '' : 's'}, helping widen coverage without changing scoring rules.`);
  }

  const bundleCount = input.scored.filter((item) => item.valuation.classification.listingType === 'bundle_or_set').length;
  if (bundleCount > 0) {
    notes.push(`Bundle/set listings were separated from clean single-item comps so mixed lots do not read like like-for-like deals.`);
  }

  const withheldCount = input.scored.filter((item) => isWithheldSection(item)).length;
  if (withheldCount > 0) {
    notes.push(`${withheldCount} listing${withheldCount === 1 ? '' : 's'} were withheld or downgraded because pricing/context was too noisy for an honest valuation.`);
  }

  if (input.suspiciousProfiles.length > 0) {
    notes.push(`Suspiciously empty profiles: ${input.suspiciousProfiles.join(', ')}.`);
  }

  const failedProfileIds = Object.keys(input.failedProfiles ?? {});
  if (failedProfileIds.length > 0) {
    notes.push(`Profile failures: ${failedProfileIds.map((profileId) => `${profileId} (${input.failedProfiles?.[profileId] ?? 'unknown error'})`).join(', ')}.`);
  }

  if (notes.length === 0) {
    notes.push('No unusual run conditions were detected.');
  }

  return notes.slice(0, 4);
}

function summarizeSections(sections: ReturnType<typeof buildSections>): string {
  const bits = [
    `${sections.topPicks.length} top pick${sections.topPicks.length === 1 ? '' : 's'}`,
    `${sections.worthChecking.length} worth checking`,
    `${sections.bundles.length} bundle${sections.bundles.length === 1 ? '' : 's'}`,
    `${sections.withheld.length} withheld`
  ];
  return bits.join(' • ');
}

function summarizeProfiles(profiles: SearchProfile[]): string {
  const labels = profiles.map((profile) => profile.label);
  return labels.length <= 2 ? labels.join(', ') : `${labels.slice(0, 2).join(', ')} +${labels.length - 2} more`;
}

function summarizeSearches(profiles: SearchProfile[]): string {
  const labels = profiles.flatMap((profile) => [profile.label, ...(profile.searchExpansions?.map((item) => item.label) ?? [])]);
  const unique = [...new Set(labels)];
  return unique.length <= 4 ? unique.join(' | ') : `${unique.slice(0, 4).join(' | ')} | +${unique.length - 4} more`;
}

function formatRunWindow(startedAt: string, finishedAt: string): string {
  const end = new Date(finishedAt);
  const start = new Date(startedAt);
  const dateLabel = new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Australia/Melbourne'
  }).format(end);
  const durationMinutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  return `${dateLabel} Melbourne time${durationMinutes > 0 ? ` (${durationMinutes} min)` : ''}`;
}

function isTopPick(item: ScoredObservation): boolean {
  const assessment = item.valuation.assessment;
  const confidence = item.valuation.classification.confidence;
  return item.valuation.classification.listingType === 'single_item'
    && (assessment === 'attractive' || assessment === 'fair')
    && (confidence === 'high' || confidence === 'medium')
    && item.score >= 40;
}

function isWithheldSection(item: ScoredObservation): boolean {
  return item.valuation.assessment === 'withheld'
    || item.valuation.assessment === 'uncertain'
    || item.valuation.classification.listingType === 'accessory_service_modification'
    || item.valuation.classification.listingType === 'ambiguous'
    || item.valuation.classification.confidence === 'low';
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
      return 'Attractive';
    case 'fair':
      return 'Fair';
    case 'overpriced':
      return 'Overpriced';
    case 'uncertain':
    case 'withheld':
      return 'Withheld / uncertain';
    default:
      return 'Unknown';
  }
}

function getListingTypeBadge(listingType: ListingType): string {
  switch (listingType) {
    case 'single_item':
      return '🎯';
    case 'bundle_or_set':
      return '📦';
    case 'accessory_service_modification':
      return '🧩';
    case 'ambiguous':
      return '❓';
    default:
      return '❓';
  }
}

function getListingTypeLabel(listingType: ListingType): string {
  switch (listingType) {
    case 'single_item':
      return 'Single item';
    case 'bundle_or_set':
      return 'Bundle / set';
    case 'accessory_service_modification':
      return 'Accessory / mod';
    case 'ambiguous':
      return 'Ambiguous';
    default:
      return 'Unknown';
  }
}

function getConfidenceBadge(confidence: ListingTypeConfidence): string {
  switch (confidence) {
    case 'high':
      return '✅';
    case 'medium':
      return '☑️';
    case 'low':
      return '⚠️';
    default:
      return '⚠️';
  }
}

function getConfidenceLabel(confidence: ListingTypeConfidence): string {
  switch (confidence) {
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    case 'low':
      return 'Low';
    default:
      return 'Unknown';
  }
}

function getRangeLabel(item: ScoredObservation): string | null {
  if (item.valuation.sources.length === 0) return null;
  const low = Math.min(...item.valuation.sources.map((source) => source.priceLow));
  const high = Math.max(...item.valuation.sources.map((source) => source.priceHigh));
  return `${formatCurrency(low, item.currency)}–${formatCurrency(high, item.currency)}`;
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

function summarizeWhyItMatters(item: ScoredObservation, format: DigestFormat): string {
  const parts = [
    item.valuation.classification.summary,
    item.valuation.assessment !== 'withheld' && item.valuation.assessment !== 'uncertain' ? item.valuation.summary : null,
    item.description ? summarizeDescription(item.description, format === 'email' ? 120 : 90) : null
  ].filter(Boolean) as string[];
  return compact(parts.join('; '), format === 'email' ? 140 : 110);
}

function summarizeWatchOuts(item: ScoredObservation, format: DigestFormat): string {
  const priority = [
    item.valuation.assessment === 'withheld' || item.valuation.assessment === 'uncertain' ? item.valuation.summary : null,
    ...item.reasons
      .filter((reason) => reason.weight < 0 || /placeholder|from-price|ambiguous|bundle|head-only|left-handed|low/i.test(reason.detail))
      .map((reason) => reason.detail),
    item.valuation.classification.confidence !== 'high' ? `listing-type confidence is ${item.valuation.classification.confidence}` : null
  ].filter(Boolean) as string[];

  const unique = [...new Set(priority.map((entry) => compact(entry, 80)))];
  if (unique.length === 0) return 'none obvious';
  return compact(unique.slice(0, 2).join('; '), format === 'email' ? 140 : 110);
}

function summarizeDescription(description?: string | null, maxLength = 120): string | null {
  if (!description) return null;
  return compact(description, maxLength);
}

function formatDetailLine(format: DigestFormat, label: string, value: string): string {
  return format === 'email' ? `   ${label}: ${value}` : `- ${label}: ${value}`;
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
