import { chromium, type BrowserContext, type Page } from 'playwright';
import type { Logger } from '../logging.js';
import { scoreListing } from '../scoring/scoreListings.js';
import type { RawListing, SearchExpansion, SearchProfile, TitleConfidence } from '../types.js';

export type CollectorOptions = {
  profileDir: string;
  headless: boolean;
  navTimeoutMs: number;
  profileTimeoutMs: number;
  maxListingsPerProfile: number;
  detailEnrichmentTopN: number;
  detailWaitMs: number;
  debug: boolean;
  logger: Logger;
};

export async function collectMarketplaceListings(profiles: SearchProfile[], options: CollectorOptions): Promise<{ itemsByProfile: Record<string, RawListing[]>; failures: Record<string, string>; enrichmentCounts: Record<string, number>; }> {
  options.logger.info(`Browser launch starting (profile=${options.profileDir}, headless=${options.headless})`);
  const context = await chromium.launchPersistentContext(options.profileDir, {
    channel: 'chrome',
    headless: options.headless,
    viewport: { width: 1440, height: 1400 }
  });
  options.logger.info('Browser launched');

  try {
    const itemsByProfile: Record<string, RawListing[]> = {};
    const failures: Record<string, string> = {};
    const enrichmentCounts: Record<string, number> = {};

    for (const profile of profiles.filter((item) => item.enabled)) {
      options.logger.info(`Profile ${profile.id} starting`);
      try {
        const items = await withTimeout(
          collectProfile(context, profile, options),
          options.profileTimeoutMs,
          `Profile ${profile.id} timed out after ${options.profileTimeoutMs}ms`
        );

        itemsByProfile[profile.id] = items;
        enrichmentCounts[profile.id] = 0;

        options.logger.info(`Profile ${profile.id} completed with ${items.length} item(s)`);

        if (options.detailEnrichmentTopN > 0 && items.length > 0) {
          const shortlist = shortlistForEnrichment(profile, items, options.detailEnrichmentTopN);
          if (shortlist.length > 0) {
            options.logger.info(`Profile ${profile.id}: enriching ${shortlist.length} shortlisted item(s)`);
            enrichmentCounts[profile.id] = await enrichShortlistedItems(context, profile, items, shortlist, options);
            options.logger.info(`Profile ${profile.id}: enriched ${enrichmentCounts[profile.id]} item(s)`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures[profile.id] = message;
        itemsByProfile[profile.id] = [];
        enrichmentCounts[profile.id] = 0;
        options.logger.warn(`Profile ${profile.id} failed: ${message}`);
      }
    }

    return { itemsByProfile, failures, enrichmentCounts };
  } finally {
    options.logger.info('Closing browser context');
    await context.close();
  }
}

async function collectProfile(context: BrowserContext, profile: SearchProfile, options: CollectorOptions): Promise<RawListing[]> {
  const variants = buildSearchVariants(profile);
  const items: RawListing[] = [];

  for (const variant of variants) {
    options.logger.debug(`Profile ${profile.id}: variant ${variant.label} -> ${variant.url}`);
    const variantItems = await collectProfileVariant(context, profile, variant, options);
    for (const item of variantItems) {
      if (!items.some((existing) => existing.externalId === item.externalId)) {
        items.push(item);
      }
      if (items.length >= options.maxListingsPerProfile) {
        return items.slice(0, options.maxListingsPerProfile);
      }
    }
  }

  return items;
}

function buildSearchVariants(profile: SearchProfile): Array<{ label: string; url: string }> {
  const variants: Array<{ label: string; url: string }> = [{ label: 'primary', url: profile.url }];
  for (const expansion of profile.searchExpansions ?? []) {
    variants.push({ label: expansion.label, url: applySearchExpansion(profile.url, expansion) });
  }
  return variants;
}

function applySearchExpansion(baseUrl: string, expansion: SearchExpansion): string {
  const url = new URL(baseUrl);
  url.searchParams.set('query', expansion.query);
  return url.toString();
}

async function collectProfileVariant(
  context: BrowserContext,
  profile: SearchProfile,
  variant: { label: string; url: string },
  options: CollectorOptions
): Promise<RawListing[]> {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(options.navTimeoutMs);
  page.setDefaultTimeout(options.navTimeoutMs);

  try {
    await page.goto(variant.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    await autoScroll(page, options.logger, `${profile.id}:${variant.label}`);

    const cards = page.locator('a[href*="/marketplace/item/"]');
    const rawCount = await cards.count();
    const count = Math.min(rawCount, options.maxListingsPerProfile);
    const items: RawListing[] = [];

    for (let i = 0; i < count; i += 1) {
      const card = cards.nth(i);
      const raw = await card.evaluate((node) => {
        const el = node as HTMLAnchorElement;
        const text = (el.innerText || '').split('\n').map((part) => part.trim()).filter(Boolean);
        const href = el.href;
        const externalIdMatch = href.match(/\/item\/(\d+)/);
        const image = el.querySelector('img');
        return {
          externalId: externalIdMatch?.[1] ?? href,
          text,
          href,
          imageUrl: image?.getAttribute('src') ?? null
        };
      });

      const parsed = parseMarketplaceCard(raw.text);
      const listing: RawListing = {
        externalId: raw.externalId,
        title: parsed.title,
        url: raw.href,
        price: parsed.price,
        priceText: parsed.priceText,
        currency: parsed.currency,
        location: parsed.location,
        imageUrl: raw.imageUrl,
        sellerName: null,
        description: null,
        postedText: raw.text.join(' | '),
        condition: null,
        detailCollectedAt: null,
        titleConfidence: parsed.titleConfidence,
        parserNotes: parsed.parserNotes
      };

      if (!items.some((item) => item.externalId === listing.externalId)) {
        items.push(listing);
      }
    }

    if (options.debug) {
      options.logger.debug(`Profile ${profile.id}: variant ${variant.label} collected ${items.length} unique card(s)`);
    }

    return items;
  } finally {
    await page.close();
  }
}

async function enrichShortlistedItems(
  context: BrowserContext,
  profile: SearchProfile,
  allItems: RawListing[],
  shortlist: RawListing[],
  options: CollectorOptions
): Promise<number> {
  let enriched = 0;

  for (const candidate of shortlist) {
    try {
      const detail = await withTimeout(
        collectListingDetail(context, candidate.url, profile.id, options),
        Math.max(15_000, Math.min(options.profileTimeoutMs, options.navTimeoutMs * 2)),
        `Detail enrichment timed out for ${candidate.externalId}`
      );

      const target = allItems.find((item) => item.externalId === candidate.externalId);
      if (!target) continue;

      if (detail.description) target.description = detail.description;
      if (detail.location) target.location = detail.location;
      if (detail.sellerName) target.sellerName = detail.sellerName;
      if (detail.condition) target.condition = detail.condition;
      if (detail.postedText) target.postedText = mergePostedText(target.postedText, detail.postedText);
      target.detailCollectedAt = new Date().toISOString();
      enriched += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn(`Profile ${profile.id}: detail enrichment failed for ${candidate.externalId}: ${message}`);
    }
  }

  return enriched;
}

async function collectListingDetail(context: BrowserContext, url: string, profileId: string, options: CollectorOptions): Promise<Partial<RawListing>> {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(options.navTimeoutMs);
  page.setDefaultTimeout(options.navTimeoutMs);

  try {
    options.logger.debug(`Profile ${profileId}: opening detail ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(options.detailWaitMs);
    await clickSeeMoreButtons(page);

    const detail = await page.evaluate(() => {
      const text = document.body.innerText
        .split('\n')
        .map((part) => part.trim())
        .filter(Boolean);

      const description = extractDescription(text);
      const condition = extractFieldValue(text, ['Condition']);
      const sellerName = extractSellerName(text);
      const location = extractLocation(text);
      const postedText = extractPostedText(text);

      return {
        description,
        condition,
        sellerName,
        location,
        postedText
      };

      function extractDescription(lines: string[]): string | null {
        const startIndex = lines.findIndex((line) => /^description$/i.test(line));
        if (startIndex === -1) return null;
        const collected: string[] = [];
        for (let index = startIndex + 1; index < lines.length; index += 1) {
          const line = lines[index];
          if (/^(condition|seller information|seller details|listed|location|message|details|category)$/i.test(line)) break;
          if (/^(marketplace|share|save|send seller a message)$/i.test(line)) break;
          collected.push(line);
          if (collected.length >= 8) break;
        }
        return collected.length > 0 ? collected.join(' ').slice(0, 1500) : null;
      }

      function extractFieldValue(lines: string[], labels: string[]): string | null {
        for (const label of labels) {
          const index = lines.findIndex((line) => line.toLowerCase() === label.toLowerCase());
          if (index !== -1) {
            const next = lines[index + 1];
            if (next && next.toLowerCase() !== label.toLowerCase()) return next.slice(0, 200);
          }
        }
        return null;
      }

      function extractSellerName(lines: string[]): string | null {
        const idx = lines.findIndex((line) => /^seller details$/i.test(line) || /^seller information$/i.test(line));
        if (idx !== -1) {
          const next = lines[idx + 1];
          if (next) return next.slice(0, 200);
        }
        return null;
      }

      function extractLocation(lines: string[]): string | null {
        const explicit = extractFieldValue(lines, ['Location']);
        if (explicit) return explicit;
        return lines.find((line) => /,\s*(VIC|NSW|QLD|SA|WA|TAS|ACT|NT)\b/i.test(line)) ?? null;
      }

      function extractPostedText(lines: string[]): string | null {
        return lines.find((line) => /\b(listed|ago|hours?|days?|weeks?)\b/i.test(line)) ?? null;
      }
    });

    return detail;
  } finally {
    await page.close();
  }
}

async function clickSeeMoreButtons(page: Page): Promise<void> {
  const seeMore = page.getByRole('button', { name: /see more/i });
  const count = await seeMore.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 2); index += 1) {
    await seeMore.nth(index).click().catch(() => undefined);
    await page.waitForTimeout(200).catch(() => undefined);
  }
}

function shortlistForEnrichment(profile: SearchProfile, items: RawListing[], topN: number): RawListing[] {
  return [...items]
    .map((item) => ({
      item,
      score: scoreListing(
        { ...item, profileId: profile.id, observedAt: new Date(0).toISOString() },
        profile,
        false,
        {
          assessment: 'uncertain',
          summary: 'Pre-enrichment shortlist uses non-valuation scoring only',
          price: item.price ?? null,
          confidence: 'low',
          sources: [],
          classification: {
            listingType: 'ambiguous',
            confidence: 'low',
            summary: 'Pre-enrichment shortlist has not classified the listing yet',
            matchedSignals: [],
            identifiedComponents: [],
            canDecomposeBundle: false
          }
        }
      ).score
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, topN)
    .map((entry) => entry.item);
}

function mergePostedText(existing?: string | null, detail?: string | null): string | null {
  if (!existing) return detail ?? null;
  if (!detail) return existing;
  if (existing.includes(detail)) return existing;
  return `${existing} | ${detail}`;
}

export function parseMarketplaceCard(text: string[]): {
  title: string;
  price: number | null;
  priceText: string | null;
  currency: string | null;
  location: string | null;
  titleConfidence: TitleConfidence;
  parserNotes: string[];
} {
  const lines = text.map((line) => line.trim()).filter(Boolean);
  const parserNotes: string[] = [];
  const priceLine = lines.find(isPriceLine) ?? null;
  const price = parsePrice(priceLine);
  const titleCandidates = lines.filter((line) => !isPriceLine(line) && !isMetaLine(line) && !looksLikeLocation(line));
  let title = titleCandidates.find((line) => line.length >= 4) ?? titleCandidates[0] ?? lines.find((line) => !isPriceLine(line) && !isMetaLine(line)) ?? lines[0] ?? 'Untitled listing';
  let titleConfidence: TitleConfidence = 'high';

  if (!titleCandidates.length) {
    parserNotes.push('title_fallback_no_clean_candidate');
    titleConfidence = 'low';
  }

  if (isPriceLine(title)) {
    parserNotes.push('title_looks_like_price');
    titleConfidence = 'low';
  }

  if (title.length < 5 || /^\d+[a-z]?$/i.test(title)) {
    parserNotes.push('title_too_short_or_numeric');
    titleConfidence = titleConfidence === 'low' ? 'low' : 'medium';
  }

  const locationCandidates = lines.filter((line) => !isPriceLine(line) && !isMetaLine(line) && line !== title && looksLikeLocation(line));
  const location = locationCandidates.at(-1) ?? null;

  if (!location && lines.length > 1) {
    const tail = lines.at(-1) ?? null;
    if (tail && tail !== title && !isPriceLine(tail) && !isMetaLine(tail)) {
      parserNotes.push('location_tail_fallback');
    }
  }

  if (priceLine && title === priceLine) {
    title = titleCandidates[1] ?? titleCandidates[0] ?? 'Untitled listing';
    parserNotes.push('title_replaced_from_price_line');
    titleConfidence = title === 'Untitled listing' ? 'low' : 'medium';
  }

  if (title === 'Untitled listing') {
    parserNotes.push('title_missing');
    titleConfidence = 'low';
  }

  return {
    title,
    price,
    priceText: priceLine,
    currency: priceLine && /\$|aud/i.test(priceLine) ? 'AUD' : null,
    location,
    titleConfidence,
    parserNotes
  };
}

function isPriceLine(value: string): boolean {
  return /^(?:au\$|\$)\s*\d[\d,.]*(?:\.\d{2})?$/i.test(value)
    || /^free$/i.test(value)
    || /^\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/.test(value);
}

function parsePrice(value: string | null): number | null {
  if (!value) return null;
  if (/^free$/i.test(value)) return 0;
  const numeric = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function isMetaLine(value: string): boolean {
  return /^(listed|shipping|seller|condition|available|in stock|minutes?|hours?|days?|weeks?)\b/i.test(value)
    || /\bago\b/i.test(value)
    || /^shared with/i.test(value)
    || /^details$/i.test(value);
}

function looksLikeLocation(value: string): boolean {
  return /,\s*[A-Z]{2,3}$/i.test(value)
    || /\bvic\b|\bnsw\b|\bqld\b|\bsa\b|\bwa\b|\btas\b|\bact\b|\bnt\b/i.test(value)
    || /^\d+\s?km$/i.test(value)
    || /^[A-Za-z][A-Za-z\s'-]+$/.test(value) && value.split(/\s+/).length <= 3 && !/helmet|driver|watch|golf|bike|iphone|club/i.test(value);
}

async function autoScroll(page: import('playwright').Page, logger: Logger, profileId: string): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    logger.debug(`Profile ${profileId}: scroll pass ${i + 1}/3`);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(1200);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
