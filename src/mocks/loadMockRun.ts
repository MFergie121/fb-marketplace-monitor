import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MockInput } from '../types.js';

const schema = z.object({
  profiles: z.array(z.object({
    profileId: z.string(),
    items: z.array(z.object({
      externalId: z.string(),
      title: z.string(),
      url: z.string(),
      price: z.number().nullable().optional(),
      priceText: z.string().nullable().optional(),
      currency: z.string().nullable().optional(),
      location: z.string().nullable().optional(),
      imageUrl: z.string().nullable().optional(),
      sellerName: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      postedText: z.string().nullable().optional(),
      titleConfidence: z.enum(['high', 'medium', 'low']).optional(),
      parserNotes: z.array(z.string()).optional()
    }))
  }))
});

export function loadMockRun(mockPath: string): MockInput {
  const absolutePath = path.resolve(mockPath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  return schema.parse(JSON.parse(raw));
}
