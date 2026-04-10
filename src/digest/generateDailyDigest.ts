import type { BuyerBucket, DigestFormat } from './generateDigest.js';
import type { RunStatus, ValuationAssessment } from '../types.js';

export type DailyDigestCandidate = {
  listingId: number;
  externalId: string;
  profileId: string;
  profileLabel: string;
  bucket: BuyerBucket;
  title: string;
  url: string;
  latestPrice: number | null;
  latestPriceText: string | null;
  currency: string | null;
  location: string | null;
  latestScore: number;
  bestScore: number;
  latestAssessment: ValuationAssessment;
  firstSeenAt: string;
  lastSeenAt: string;
  surfacedRunIds: number[];
  surfacedCount: number;
  buyerAngle: string;
};

export type DailyDigestRunSummary = {
  runId: number;
  status: RunStatus;
  finishedAt: string | null;
};

export type DailyDigestInput = {
  dayLabel: string;
  windowStart: string;
  windowEnd: string;
  channelId?: string;
  profiles: Array<{ id: string; label: string }>;
  candidates: DailyDigestCandidate[];
  runs: DailyDigestRunSummary[];
};

type DailyProfileSection = {
  profileId: string;
  profileLabel: string;
  items: DailyDigestCandidate[];
};

const PROFILE_DAILY_CAP = 3;
const DAILY_TOP_PICK_CAP = 6;

export function generateDailyDigest(input: DailyDigestInput, format: DigestFormat = 'discord'): string {
  const sections = buildDailySections(input);
  const header = [
    'FB MARKETPLACE DAILY DIGEST',
    `${input.dayLabel} Melbourne`,
    `Window: ${formatWindow(input.windowStart, input.windowEnd)}`,
    `Profiles: ${summarizeProfiles(input.profiles.map((profile) => profile.label))}`
  ];

  const blocks = [
    renderDailyTopPicks(sections.topPicks, format),
    renderDailyByProfile(sections.byProfile, format),
    renderDailyFooter(input, sections)
  ].filter(Boolean) as string[];

  return [...header, '', ...blocks].join('\n\n').trim();
}

function buildDailySections(input: DailyDigestInput): { topPicks: DailyDigestCandidate[]; byProfile: DailyProfileSection[] } {
  const ranked = [...input.candidates].sort(compareDailyCandidates);
  const topPicks = ranked.slice(0, DAILY_TOP_PICK_CAP);
  const byProfile = input.profiles.map((profile) => ({
    profileId: profile.id,
    profileLabel: profile.label,
    items: ranked.filter((item) => item.profileId === profile.id).slice(0, PROFILE_DAILY_CAP)
  }));
  return { topPicks, byProfile };
}

function renderDailyTopPicks(items: DailyDigestCandidate[], format: DigestFormat): string {
  if (items.length === 0) {
    return '🔥 BEST OF THE DAY\n- No buyer-safe daily candidates were collected.';
  }

  return `🔥 BEST OF THE DAY\n${items.map((item, index) => `- ${index + 1}) ${renderDailyItem(item, format)}`).join('\n')}`;
}

function renderDailyByProfile(sections: DailyProfileSection[], format: DigestFormat): string {
  const blocks = sections.map((section) => {
    if (section.items.length === 0) {
      return `• ${section.profileLabel}\n  - Nothing buyer-safe survived the trust filters across today\'s runs.`;
    }

    return `• ${section.profileLabel}\n${section.items.map((item, index) => `  - ${index + 1}) ${renderDailyItem(item, format)}`).join('\n')}`;
  });

  return `🧭 BY SUBTOPIC\n${blocks.join('\n\n')}`;
}

function renderDailyItem(item: DailyDigestCandidate, format: DigestFormat): string {
  const link = format === 'discord' ? `<${item.url}>` : item.url;
  const price = formatPrice(item.latestPrice, item.currency, item.latestPriceText);
  const sightings = item.surfacedCount === 1
    ? 'seen once today'
    : `seen in ${item.surfacedCount} runs today`;
  const bucket = item.bucket === 'top_pick' ? 'top pick' : 'worth a look';
  const location = item.location ?? 'Unknown location';
  return `${item.title} — ${price} — ${location}\n    ${item.buyerAngle} • ${bucket} • ${sightings} | ${link}`;
}

function renderDailyFooter(input: DailyDigestInput, sections: { topPicks: DailyDigestCandidate[]; byProfile: DailyProfileSection[] }): string {
  const successfulRuns = input.runs.filter((run) => run.status === 'success').length;
  const partialRuns = input.runs.filter((run) => run.status === 'partial' || run.status === 'suspicious_empty').length;
  const failedRuns = input.runs.filter((run) => run.status === 'failed').length;
  const surfacedProfiles = sections.byProfile.filter((section) => section.items.length > 0).length;
  const footer = [
    `Collected ${input.candidates.length} unique buyer-safe candidate${input.candidates.length === 1 ? '' : 's'} from ${input.runs.length} run${input.runs.length === 1 ? '' : 's'}.`,
    `${surfacedProfiles}/${sections.byProfile.length} active subtopic${sections.byProfile.length === 1 ? '' : 's'} produced digest-worthy listings.`
  ];

  if (partialRuns > 0) footer.push(`${partialRuns} run${partialRuns === 1 ? '' : 's'} finished partial or suspicious-empty.`);
  if (failedRuns > 0) footer.push(`${failedRuns} run${failedRuns === 1 ? '' : 's'} failed and may have missed listings.`);
  if (input.channelId) footer.push(`Ready for Discord delivery to channel ${input.channelId}.`);
  if (successfulRuns === 0 && input.runs.length > 0) footer.push('No fully successful runs landed in this window. Treat with extra caution.');

  return `ℹ️ FOOTER\n- ${footer.join('\n- ')}`;
}

function compareDailyCandidates(left: DailyDigestCandidate, right: DailyDigestCandidate): number {
  return getBucketRank(right.bucket) - getBucketRank(left.bucket)
    || getAssessmentRank(right.latestAssessment) - getAssessmentRank(left.latestAssessment)
    || right.bestScore - left.bestScore
    || right.surfacedCount - left.surfacedCount
    || left.title.localeCompare(right.title);
}

function getBucketRank(bucket: BuyerBucket): number {
  return bucket === 'top_pick' ? 2 : 1;
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

function summarizeProfiles(labels: string[]): string {
  return labels.length <= 3 ? labels.join(', ') : `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more`;
}

function formatWindow(windowStart: string, windowEnd: string): string {
  const formatter = new Intl.DateTimeFormat('en-AU', {
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Australia/Melbourne'
  });
  return `${formatter.format(new Date(windowStart))} → ${formatter.format(new Date(windowEnd))}`;
}

function formatPrice(price?: number | null, currency?: string | null, priceText?: string | null): string {
  if (priceText && /^free$/i.test(priceText)) return 'Free';
  if (priceText && typeof price !== 'number') return priceText;
  if (typeof price !== 'number') return 'Price n/a';
  return `${currency === 'AUD' || !currency ? '$' : `${currency} `}${Math.round(price)}`;
}
