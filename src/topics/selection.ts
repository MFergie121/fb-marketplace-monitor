import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const topicSelectionSchema = z.object({
  version: z.literal(1).default(1),
  topicPath: z.string().min(1),
  activeTopicIds: z.array(z.string().min(1)).default([])
});

export type TopicSelection = z.infer<typeof topicSelectionSchema>;

export function loadTopicSelection(selectionPath: string): TopicSelection {
  const absolutePath = path.resolve(selectionPath);
  return topicSelectionSchema.parse(JSON.parse(fs.readFileSync(absolutePath, 'utf8')));
}
