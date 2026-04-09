import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig, CatalogTopic, ListingTypeScope, SearchProfile, TopicCatalog, TopicCatalogQuery, TopicDefinition } from '../types.js';

const listingTypeScopeSchema = z.enum(['single_item', 'bundle_or_set']);

const priceBandSchema = z.object({
  min: z.number().nonnegative(),
  max: z.number().nonnegative()
}).refine((value) => value.max >= value.min, { message: 'priceBand.max must be >= priceBand.min' });

const familySchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  brand: z.string().min(1),
  family: z.string().min(1),
  queries: z.array(z.string().min(1)).min(1),
  matchTerms: z.array(z.string().min(1)).min(1),
  searchTerms: z.array(z.string().min(1)).default([]),
  exclusions: z.array(z.string().min(1)).default([]),
  listingTypeScope: listingTypeScopeSchema.optional(),
  category: z.string().min(1).optional(),
  priceBand: priceBandSchema.optional(),
  valuation: z.object({
    priceLow: z.number().positive(),
    priceHigh: z.number().positive(),
    confidence: z.enum(['high', 'medium', 'low']).optional(),
    notes: z.string().optional()
  }).refine((value) => value.priceHigh >= value.priceLow, { message: 'valuation.priceHigh must be >= valuation.priceLow' })
});

const topicDefinitionSchema = z.object({
  version: z.literal(1).default(1),
  topics: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    enabled: z.boolean().default(true),
    market: z.string().min(1).default('melbourne'),
    locationLabel: z.string().min(1).default('Melbourne'),
    category: z.string().min(1),
    listingTypeScope: listingTypeScopeSchema,
    baseQuery: z.string().min(1),
    searchTerms: z.array(z.string().min(1)).default([]),
    priceBand: priceBandSchema,
    exclusions: z.array(z.string().min(1)).default([]),
    families: z.array(familySchema).min(1)
  })).min(1)
});

const catalogSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().min(1),
  metadata: z.object({
    sourceTopicPath: z.string().optional(),
    market: z.string().optional(),
    currency: z.string().optional(),
    description: z.string().optional(),
    scopeLabel: z.string().optional(),
    activeTopicIds: z.array(z.string()).default([]),
    queryVariantLimit: z.number().int().positive().optional(),
    stopAfterCollectedCount: z.number().int().positive().optional()
  }).default({ activeTopicIds: [] }),
  topics: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    enabled: z.boolean(),
    market: z.string().min(1),
    locationLabel: z.string().min(1),
    category: z.string().min(1),
    sourceTopicId: z.string().min(1),
    sourceTopicLabel: z.string().min(1),
    groupIds: z.array(z.string().min(1)).min(1),
    listingTypeScope: listingTypeScopeSchema,
    baseQuery: z.string().min(1),
    storedQueryTerms: z.array(z.object({
      label: z.string().min(1),
      query: z.string().min(1),
      kind: z.enum(['primary', 'expansion'])
    })).min(1),
    searchTerms: z.array(z.string().min(1)).default([]),
    exclusions: z.array(z.string().min(1)).default([]),
    brands: z.array(z.string().min(1)).default([]),
    modelFamilies: z.array(z.string().min(1)).default([]),
    requiredAnyKeywords: z.array(z.string().min(1)).default([]),
    priceBand: priceBandSchema,
    valuationReferences: z.array(z.object({
      label: z.string().min(1),
      matchTerms: z.array(z.string().min(1)).min(1),
      priceLow: z.number().positive(),
      priceHigh: z.number().positive(),
      confidence: z.enum(['high', 'medium', 'low']).optional(),
      notes: z.string().optional(),
      listingTypeScope: z.enum(['single_item', 'bundle_or_set', 'accessory_service_modification', 'any']).optional()
    })).default([])
  })).min(1)
});

const COMMON_UNWANTED = ['kids', 'junior', 'ladies', "women's", 'womens', 'bag', 'cover only'];
const GENERIC_TERMS = ['driver', 'putter', 'irons', 'iron set', 'wedge', 'golf', 'custom', 'helmet', 'skis', 'ski'];
const DEFAULT_POC_QUERY_VARIANT_LIMIT = 3;
const DEFAULT_POC_STOP_AFTER_COLLECTED_COUNT = 18;

export function loadTopicDefinition(topicPath: string): TopicDefinition {
  const absolutePath = path.resolve(topicPath);
  return topicDefinitionSchema.parse(JSON.parse(fs.readFileSync(absolutePath, 'utf8')));
}

export function buildCatalogFromTopics(definition: TopicDefinition, sourceTopicPath?: string): TopicCatalog {
  const topics = definition.topics.flatMap((topic) => shouldSplitTopicIntoFamilyProfiles(topic)
    ? topic.families.map((family) => buildFamilyScopedCatalogTopic(topic, family))
    : [buildCatalogTopic(topic)]);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    metadata: {
      sourceTopicPath: sourceTopicPath ? path.resolve(sourceTopicPath) : undefined,
      market: unique(definition.topics.map((topic) => topic.market))[0],
      scopeLabel: topics.filter((topic) => topic.enabled).length === 1
        ? `POC single-topic focus: ${topics.find((topic) => topic.enabled)?.label ?? 'unknown'}`
        : `Multi-topic sweep: ${topics.filter((topic) => topic.enabled).length} active topics`,
      activeTopicIds: topics.filter((topic) => topic.enabled).map((topic) => topic.id),
      queryVariantLimit: DEFAULT_POC_QUERY_VARIANT_LIMIT,
      stopAfterCollectedCount: DEFAULT_POC_STOP_AFTER_COLLECTED_COUNT
    },
    topics
  };
}

export function loadCatalog(catalogPath: string): TopicCatalog {
  const absolutePath = path.resolve(catalogPath);
  return catalogSchema.parse(JSON.parse(fs.readFileSync(absolutePath, 'utf8')));
}

export function buildConfigFromCatalog(catalog: TopicCatalog): AppConfig {
  const profiles: SearchProfile[] = catalog.topics.map((topic) => {
    const primary = topic.storedQueryTerms.find((query) => query.kind === 'primary') ?? topic.storedQueryTerms[0];
    const searchExpansions = topic.storedQueryTerms
      .filter((query) => query.kind === 'expansion')
      .map((query) => ({ label: query.label, query: query.query }));

    return {
      id: `topic-${topic.id}`,
      label: `${topic.label} (catalog)`,
      url: buildMarketplaceSearchUrl(topic.market, primary.query),
      enabled: topic.enabled,
      category: topic.category,
      brandPreferences: topic.brands,
      modelFamilies: topic.modelFamilies,
      requiredAnyKeywords: topic.requiredAnyKeywords,
      keywords: topic.searchTerms,
      unwantedKeywords: topic.exclusions,
      maxPrice: topic.priceBand.max,
      minPrice: topic.priceBand.min,
      locationLabel: topic.locationLabel,
      searchExpansions,
      runtime: {
        activeQueryVariantLimit: catalog.metadata.queryVariantLimit,
        stopAfterCollectedCount: catalog.metadata.stopAfterCollectedCount
      },
      valuationReferences: topic.valuationReferences
    } satisfies SearchProfile;
  });

  return { profiles };
}

export function renderCatalogSummary(catalog: TopicCatalog): string {
  const lines: string[] = [];
  lines.push('Topic catalog');
  lines.push(`- Scope: ${catalog.metadata.scopeLabel ?? 'unspecified'}`);
  lines.push(`- Active topics: ${catalog.metadata.activeTopicIds.join(', ') || 'none'}`);
  if (catalog.metadata.queryVariantLimit) lines.push(`- POC query variant cap: ${catalog.metadata.queryVariantLimit}`);
  if (catalog.metadata.stopAfterCollectedCount) lines.push(`- Early stop after collected cards: ${catalog.metadata.stopAfterCollectedCount}`);
  for (const topic of catalog.topics) {
    lines.push(`- ${topic.label}`);
    lines.push(`  - Topic id: ${topic.id}`);
    lines.push(`  - Source topic: ${topic.sourceTopicId}`);
    lines.push(`  - Group ids: ${topic.groupIds.join(', ')}`);
    lines.push(`  - Queries stored: ${topic.storedQueryTerms.length}`);
    lines.push(`  - Enabled: ${topic.enabled ? 'yes' : 'no'}`);
    lines.push(`  - Brands: ${topic.brands.join(', ')}`);
    lines.push(`  - Families: ${topic.modelFamilies.join(', ')}`);
    lines.push(`  - Price band: ${topic.priceBand.min}-${topic.priceBand.max}`);
    lines.push(`  - Exclusions: ${topic.exclusions.length}`);
    lines.push(`  - Valuation refs: ${topic.valuationReferences.length}`);
  }
  return lines.join('\n');
}

function shouldSplitTopicIntoFamilyProfiles(topic: TopicDefinition['topics'][number]): boolean {
  return topic.id === 'custom' || topic.category === 'custom';
}

function buildCatalogTopic(topic: TopicDefinition['topics'][number]): CatalogTopic {
  const brands = unique(topic.families.map((family) => family.brand));
  const modelFamilies = unique(topic.families.map((family) => family.family));
  const requiredAnyKeywords = unique(topic.families.flatMap((family) => family.matchTerms.filter((term) => {
    const normalized = term.trim().toLowerCase();
    return normalized.length >= 3
      && !brands.some((brand) => brand.toLowerCase() === normalized)
      && !GENERIC_TERMS.includes(normalized);
  })));

  const expansions = unique(topic.families.flatMap((family) => family.queries))
    .slice(0, 12)
    .map<TopicCatalogQuery>((query) => ({ label: query, query, kind: 'expansion' }));

  return {
    id: topic.id,
    label: topic.label,
    enabled: topic.enabled,
    market: topic.market,
    locationLabel: topic.locationLabel,
    category: topic.category,
    sourceTopicId: topic.id,
    sourceTopicLabel: topic.label,
    groupIds: [topic.id],
    listingTypeScope: topic.listingTypeScope,
    baseQuery: topic.baseQuery,
    storedQueryTerms: [
      { label: `${topic.label} primary`, query: topic.families[0]?.queries[0] ?? topic.baseQuery, kind: 'primary' },
      ...expansions
    ],
    searchTerms: unique(topic.searchTerms),
    exclusions: unique([...COMMON_UNWANTED, ...topic.exclusions]),
    brands,
    modelFamilies,
    requiredAnyKeywords,
    priceBand: topic.priceBand,
    valuationReferences: topic.families.map((family) => ({
      label: `${family.brand} ${family.family}`,
      matchTerms: family.matchTerms,
      priceLow: family.valuation.priceLow,
      priceHigh: family.valuation.priceHigh,
      confidence: family.valuation.confidence,
      notes: family.valuation.notes,
      listingTypeScope: topic.listingTypeScope as ListingTypeScope
    }))
  } satisfies CatalogTopic;
}

function buildFamilyScopedCatalogTopic(topic: TopicDefinition['topics'][number], family: TopicDefinition['topics'][number]['families'][number]): CatalogTopic {
  const profileId = family.id ?? `${topic.id}-${slugify(family.label ?? family.family)}`;
  const label = family.label ?? family.family;
  const listingTypeScope = family.listingTypeScope ?? topic.listingTypeScope;
  const category = family.category ?? topic.category;
  const priceBand = family.priceBand ?? topic.priceBand;
  const searchTerms = unique([...
    topic.searchTerms,
    ...family.searchTerms ?? [],
    ...family.matchTerms
  ]);
  const exclusions = unique([...COMMON_UNWANTED, ...topic.exclusions, ...family.exclusions ?? []]);
  const brands = unique([family.brand]);
  const modelFamilies = unique([family.family]);
  const requiredAnyKeywords = unique(family.matchTerms.filter((term) => {
    const normalized = term.trim().toLowerCase();
    return normalized.length >= 3
      && !brands.some((brand) => brand.toLowerCase() === normalized)
      && !GENERIC_TERMS.includes(normalized);
  }));
  const storedQueryTerms = unique(family.queries)
    .slice(0, 12)
    .map<TopicCatalogQuery>((query, index) => ({ label: query, query, kind: index === 0 ? 'primary' : 'expansion' }));

  return {
    id: profileId,
    label,
    enabled: topic.enabled,
    market: topic.market,
    locationLabel: topic.locationLabel,
    category,
    sourceTopicId: topic.id,
    sourceTopicLabel: topic.label,
    groupIds: unique([topic.id, profileId]),
    listingTypeScope,
    baseQuery: family.queries[0] ?? topic.baseQuery,
    storedQueryTerms: storedQueryTerms.length > 0
      ? storedQueryTerms
      : [{ label: `${label} primary`, query: topic.baseQuery, kind: 'primary' }],
    searchTerms,
    exclusions,
    brands,
    modelFamilies,
    requiredAnyKeywords,
    priceBand,
    valuationReferences: [{
      label,
      matchTerms: family.matchTerms,
      priceLow: family.valuation.priceLow,
      priceHigh: family.valuation.priceHigh,
      confidence: family.valuation.confidence,
      notes: family.valuation.notes,
      listingTypeScope
    }]
  } satisfies CatalogTopic;
}

function buildMarketplaceSearchUrl(market: string, query: string): string {
  return `https://www.facebook.com/marketplace/${encodeURIComponent(market)}/search?query=${encodeURIComponent(query)}`;
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
