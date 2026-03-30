import { chromium, type BrowserContext } from 'playwright';
import type { RawListing, SearchProfile } from '../types.js';

export type CollectorOptions = {
  profileDir: string;
  headless: boolean;
  navTimeoutMs: number;
  maxListingsPerProfile: number;
  debug: boolean;
};

export async function collectMarketplaceListings(profiles: SearchProfile[], options: CollectorOptions): Promise<Record<string, RawListing[]>> {
  const context = await chromium.launchPersistentContext(options.profileDir, {
    channel: 'chrome',
    headless: options.headless,
    viewport: { width: 1440, height: 1400 }
  });

  try {
    const results: Record<string, RawListing[]> = {};
    for (const profile of profiles.filter((item) => item.enabled)) {
      results[profile.id] = await collectProfile(context, profile, options);
    }
    return results;
  } finally {
    await context.close();
  }
}

async function collectProfile(context: BrowserContext, profile: SearchProfile, options: CollectorOptions): Promise<RawListing[]> {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(options.navTimeoutMs);
  page.setDefaultTimeout(options.navTimeoutMs);

  await page.goto(profile.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await autoScroll(page);

  const cards = page.locator('a[href*="/marketplace/item/"]');
  const count = Math.min(await cards.count(), options.maxListingsPerProfile);
  const items: RawListing[] = [];

  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    const raw = await card.evaluate((node) => {
      const el = node as HTMLAnchorElement;
      const text = (el.innerText || '').split('\n').map((part) => part.trim()).filter(Boolean);
      const href = el.href;
      const externalIdMatch = href.match(/\/item\/(\d+)/);
      const image = el.querySelector('img');
      const title = text.find((part) => !/^\$/.test(part)) ?? text[0] ?? 'Untitled listing';
      const priceCandidate = text.find((part) => /\$\s?\d/.test(part));
      const price = priceCandidate ? Number(priceCandidate.replace(/[^\d.]/g, '')) : null;
      const location = text.at(-1) ?? null;
      return {
        externalId: externalIdMatch?.[1] ?? href,
        title,
        url: href,
        price: Number.isFinite(price) ? price : null,
        currency: priceCandidate ? 'AUD' : null,
        location,
        imageUrl: image?.getAttribute('src') ?? null,
        sellerName: null,
        description: null,
        postedText: text.join(' | ')
      };
    });

    if (!items.some((item) => item.externalId === raw.externalId)) {
      items.push(raw);
    }
  }

  if (options.debug) {
    console.log(`Collected ${items.length} cards for ${profile.id}`);
  }

  await page.close();
  return items;
}

async function autoScroll(page: import('playwright').Page): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(1200);
  }
}
