import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig, ListingTypeScope, SearchProfile } from '../types.js';

const listingTypeScopeSchema = z.enum(['single_item', 'bundle_or_set']);

const catalogSchema = z.object({
  metadata: z.object({
    description: z.string().optional(),
    market: z.string().optional(),
    currency: z.string().optional(),
    generatedFrom: z.array(z.string()).optional()
  }).optional(),
  segments: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    category: z.string().min(1),
    listingTypeScope: listingTypeScopeSchema,
    baseQuery: z.string().min(1),
    searchTerms: z.array(z.string().min(1)).default([]),
    priceBand: z.object({
      min: z.number().positive(),
      max: z.number().positive()
    }).refine((value) => value.max >= value.min, { message: 'priceBand.max must be >= priceBand.min' }),
    accessoryExclusions: z.array(z.string().min(1)).default([]),
    families: z.array(z.object({
      brand: z.string().min(1),
      family: z.string().min(1),
      queries: z.array(z.string().min(1)).min(1),
      matchTerms: z.array(z.string().min(1)).min(1),
      valuation: z.object({
        priceLow: z.number().positive(),
        priceHigh: z.number().positive(),
        confidence: z.enum(['high', 'medium', 'low']).optional(),
        notes: z.string().optional()
      }).refine((value) => value.priceHigh >= value.priceLow, { message: 'valuation.priceHigh must be >= valuation.priceLow' })
    })).min(1)
  })).min(1)
});

type ResearchCatalog = z.infer<typeof catalogSchema>;

const COMMON_UNWANTED = ['kids', 'junior', 'ladies', "women's", 'womens', 'bag', 'cover only'];

export function loadResearchCatalog(catalogPath: string): ResearchCatalog {
  const absolutePath = path.resolve(catalogPath);
  return catalogSchema.parse(JSON.parse(fs.readFileSync(absolutePath, 'utf8')));
}

export function buildConfigFromResearchCatalog(catalog: ResearchCatalog, market = 'melbourne'): AppConfig {
  const profiles: SearchProfile[] = catalog.segments.map((segment) => {
    const brands = unique(segment.families.map((family) => family.brand));
    const modelFamilies = unique(segment.families.map((family) => family.family));
    const requiredAnyKeywords = unique(segment.families.flatMap((family) => family.matchTerms.filter((term) => {
      const normalized = term.trim().toLowerCase();
      return normalized.length >= 3 && !brands.some((brand) => brand.toLowerCase() === normalized) && !['driver', 'putter', 'irons', 'iron set', 'wedge', 'golf'].includes(normalized);
    })));
    const valuationReferences = segment.families.map((family) => ({
      label: `${family.brand} ${family.family}`,
      matchTerms: family.matchTerms,
      priceLow: family.valuation.priceLow,
      priceHigh: family.valuation.priceHigh,
      confidence: family.valuation.confidence,
      notes: family.valuation.notes,
      listingTypeScope: segment.listingTypeScope as ListingTypeScope
    }));

    const searchExpansions = unique(segment.families.flatMap((family) => family.queries))
      .slice(0, 12)
      .map((query) => ({ label: query, query }));

    return {
      id: `research-${segment.id}`,
      label: `${segment.label} (research-led)`,
      url: buildMarketplaceSearchUrl(market, segment.families[0]?.queries[0] ?? segment.baseQuery),
      enabled: true,
      category: segment.category,
      brandPreferences: brands,
      modelFamilies,
      requiredAnyKeywords,
      keywords: segment.searchTerms,
      unwantedKeywords: unique([...COMMON_UNWANTED, ...segment.accessoryExclusions]),
      maxPrice: segment.priceBand.max,
      minPrice: segment.priceBand.min,
      locationLabel: 'Melbourne',
      searchExpansions,
      valuationReferences
    } satisfies SearchProfile;
  });

  return { profiles };
}

export function renderResearchSummary(config: AppConfig): string {
  const lines: string[] = [];
  lines.push('Research-generated golf watchlist');
  for (const profile of config.profiles) {
    lines.push(`- ${profile.label}`);
    lines.push(`  - Brands: ${profile.brandPreferences.join(', ')}`);
    lines.push(`  - Model families: ${(profile.modelFamilies ?? []).join(', ')}`);
    lines.push(`  - Price band: ${profile.minPrice ?? '?'}-${profile.maxPrice ?? '?'}`);
    lines.push(`  - Query count: ${1 + (profile.searchExpansions?.length ?? 0)}`);
    lines.push(`  - Valuation refs: ${profile.valuationReferences?.length ?? 0}`);
  }
  return lines.join('\n');
}

function buildMarketplaceSearchUrl(market: string, query: string): string {
  const encodedMarket = encodeURIComponent(market);
  const encodedQuery = encodeURIComponent(query);
  return `https://www.facebook.com/marketplace/${encodedMarket}/search?query=${encodedQuery}`;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}
