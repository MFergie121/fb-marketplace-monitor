import { chromium, type BrowserContext } from 'playwright';
import type { Logger } from '../logging.js';
import type { RawListing, SearchProfile, TitleConfidence } from '../types.js';

export type CollectorOptions = {
  profileDir: string;
  headless: boolean;
  navTimeoutMs: number;
  profileTimeoutMs: number;
  maxListingsPerProfile: number;
  debug: boolean;
  logger: Logger;
};

export async function collectMarketplaceListings(profiles: SearchProfile[], options: CollectorOptions): Promise<{ itemsByProfile: Record<string, RawListing[]>; failures: Record<string, string>; }> {
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
    for (const profile of profiles.filter((item) => item.enabled)) {
      options.logger.info(`Profile ${profile.id} starting`);
      try {
        const items = await withTimeout(
          collectProfile(context, profile, options),
          options.profileTimeoutMs,
          `Profile ${profile.id} timed out after ${options.profileTimeoutMs}ms`
        );
        itemsByProfile[profile.id] = items;
        options.logger.info(`Profile ${profile.id} completed with ${items.length} item(s)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures[profile.id] = message;
        itemsByProfile[profile.id] = [];
        options.logger.warn(`Profile ${profile.id} failed: ${message}`);
      }
    }
    return { itemsByProfile, failures };
  } finally {
    options.logger.info('Closing browser context');
    await context.close();
  }
}

async function collectProfile(context: BrowserContext, profile: SearchProfile, options: CollectorOptions): Promise<RawListing[]> {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(options.navTimeoutMs);
  page.setDefaultTimeout(options.navTimeoutMs);

  try {
    options.logger.debug(`Profile ${profile.id}: navigating to ${profile.url}`);
    await page.goto(profile.url, { waitUntil: 'domcontentloaded' });
    options.logger.debug(`Profile ${profile.id}: page loaded, waiting for Marketplace cards`);
    await page.waitForTimeout(5000);
    await autoScroll(page, options.logger, profile.id);

    const cards = page.locator('a[href*="/marketplace/item/"]');
    const rawCount = await cards.count();
    const count = Math.min(rawCount, options.maxListingsPerProfile);
    options.logger.debug(`Profile ${profile.id}: found ${rawCount} candidate card(s), reading ${count}`);
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
        titleConfidence: parsed.titleConfidence,
        parserNotes: parsed.parserNotes
      };

      if (!items.some((item) => item.externalId === listing.externalId)) {
        items.push(listing);
      }
    }

    if (options.debug) {
      options.logger.debug(`Profile ${profile.id}: collected ${items.length} unique card(s)`);
    }

    return items;
  } finally {
    await page.close();
  }
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
