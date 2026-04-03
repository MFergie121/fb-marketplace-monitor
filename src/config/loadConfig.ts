import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../types.js';

const listingTypeScopeSchema = z.enum(['single_item', 'bundle_or_set', 'accessory_service_modification', 'any']);

const searchExpansionSchema = z.object({
  label: z.string().min(1),
  query: z.string().min(1)
});

const valuationReferenceSchema = z.object({
  label: z.string().min(1),
  matchTerms: z.array(z.string().min(1)).min(1),
  priceLow: z.number().positive(),
  priceHigh: z.number().positive(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  notes: z.string().optional(),
  listingTypeScope: listingTypeScopeSchema.optional()
}).refine((value) => value.priceHigh >= value.priceLow, {
  message: 'priceHigh must be >= priceLow'
});

const profileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  url: z.string().url(),
  enabled: z.boolean().default(true),
  category: z.string().optional(),
  brandPreferences: z.array(z.string()).default([]),
  keywords: z.array(z.string()).optional(),
  modelFamilies: z.array(z.string()).optional(),
  requiredAnyKeywords: z.array(z.string().min(1)).optional(),
  unwantedKeywords: z.array(z.string()).optional(),
  maxPrice: z.number().optional(),
  minPrice: z.number().optional(),
  locationLabel: z.string().optional(),
  searchExpansions: z.array(searchExpansionSchema).optional(),
  runtime: z.object({
    activeQueryVariantLimit: z.number().int().positive().optional(),
    stopAfterCollectedCount: z.number().int().positive().optional()
  }).optional(),
  valuationReferences: z.array(valuationReferenceSchema).optional()
});

const configSchema = z.object({
  profiles: z.array(profileSchema).min(1)
});

export function loadConfig(configPath: string): AppConfig {
  const absolutePath = path.resolve(configPath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  return configSchema.parse(JSON.parse(raw));
}
