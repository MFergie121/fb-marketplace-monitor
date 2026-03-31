import path from 'node:path';
import type { Logger } from '../logging.js';
import type { AppConfig, ListingObservation, RawListing, RunResult, RunStatus, ScoredObservation } from '../types.js';
import { collectMarketplaceListings } from '../collector/marketplaceCollector.js';
import { openDatabase, migrate, createRun, finishRun, upsertListing, insertObservation, insertNotification, getRecentObservedCounts, cleanupOldData } from '../db/database.js';
import { generateDebugDigest, generateDigest } from '../digest/generateDigest.js';
import { loadMockRun } from '../mocks/loadMockRun.js';
import { acquireRunLock, releaseRunLock } from './lock.js';
import { scoreListing } from '../scoring/scoreListings.js';
import { buildValuationContext } from '../scoring/valuation.js';

export type RunOptions = {
  dbPath: string;
  browserProfileDir: string;
  headless: boolean;
  navTimeoutMs: number;
  runTimeoutMs: number;
  profileTimeoutMs: number;
  maxListingsPerProfile: number;
  detailEnrichmentTopN: number;
  detailWaitMs: number;
  retentionDays: number;
  emptyResultsThreshold: number;
  suspiciousEmptyMinProfiles: number;
  debug: boolean;
  logger: Logger;
  mockPath?: string;
};

export async function runMonitor(config: AppConfig, options: RunOptions): Promise<RunResult> {
  options.logger.info(`Opening DB at ${path.resolve(options.dbPath)}`);
  const db = openDatabase(options.dbPath);
  migrate(db);
  cleanupOldData(db, options.retentionDays);
  options.logger.info(`DB ready, acquiring run lock marketplace-monitor (ttl ${options.runTimeoutMs}ms)`);
  acquireRunLock(db, 'marketplace-monitor', options.runTimeoutMs);
  options.logger.info('Run lock acquired');

  const startedAt = new Date().toISOString();
  const runId = createRun(db, startedAt);
  options.logger.info(`Run ${runId} created`);

  try {
    const observedAt = new Date().toISOString();
    const collection = await withTimeout(loadItems(config, options), options.runTimeoutMs, 'Run timed out');
    const scored: ScoredObservation[] = [];
    const profileSummaries: RunResult['profileSummaries'] = [];
    const suspiciousProfiles: string[] = [];

    for (const profile of config.profiles.filter((item) => item.enabled)) {
      const items = collection.itemsByProfile[profile.id] ?? [];
      const priorCounts = getRecentObservedCounts(db, profile.id, options.emptyResultsThreshold);
      const suspiciousEmpty = items.length === 0 && priorCounts.some((count) => count > 0);
      if (suspiciousEmpty) suspiciousProfiles.push(profile.id);
      profileSummaries.push({
        profileId: profile.id,
        collected: items.length,
        enriched: collection.enrichmentCounts?.[profile.id] ?? countEnriched(items),
        suspiciousEmpty,
        status: collection.failures[profile.id] ? 'failed' : 'success',
        errorMessage: collection.failures[profile.id] ?? null
      });

      for (const item of items) {
        const observation: ListingObservation = { ...item, profileId: profile.id, observedAt };
        const valuation = buildValuationContext(db, observation, profile);
        const { listingId, isNew } = upsertListing(db, observation);
        const scoredObservation = scoreListing(observation, profile, isNew, valuation);
        insertObservation(db, runId, listingId, scoredObservation);
        scored.push(scoredObservation);
      }
    }

    const status: RunStatus = suspiciousProfiles.length >= options.suspiciousEmptyMinProfiles
      ? 'suspicious_empty'
      : Object.keys(collection.failures).length > 0
        ? 'partial'
        : 'success';
    const finishedAt = new Date().toISOString();
    options.logger.info('Generating digest');
    const digestInput = {
      status,
      startedAt,
      finishedAt,
      scored,
      profiles: config.profiles.filter((item) => item.enabled),
      suspiciousProfiles,
      failedProfiles: collection.failures
    };
    const digests = {
      discord: generateDigest(digestInput, 'discord'),
      email: generateDigest(digestInput, 'email'),
      debugDiscord: generateDebugDigest(digestInput, 'discord'),
      debugEmail: generateDebugDigest(digestInput, 'email')
    };
    insertNotification(db, runId, digests.discord);
    finishRun(db, runId, {
      status,
      finishedAt,
      suspiciousEmpty: suspiciousProfiles.length > 0,
      metadata: {
        profileSummaries,
        failedProfiles: collection.failures,
        enrichmentCounts: collection.enrichmentCounts,
        digestPathHint: path.resolve('runtime/latest-digest.txt')
      }
    });

    options.logger.info(`Run ${runId} finished with status=${status}`);
    return { runId, status, startedAt, finishedAt, profileSummaries, digest: digests.discord, digests };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    finishRun(db, runId, {
      status: 'failed',
      finishedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      suspiciousEmpty: false,
      metadata: {}
    });
    throw error;
  } finally {
    releaseRunLock(db, 'marketplace-monitor');
    options.logger.info('Run lock released');
    db.close();
    options.logger.info('DB closed');
  }
}

async function loadItems(config: AppConfig, options: RunOptions): Promise<{ itemsByProfile: Record<string, RawListing[]>; failures: Record<string, string>; enrichmentCounts: Record<string, number>; }> {
  if (options.mockPath) {
    options.logger.info(`Loading mock data from ${options.mockPath}`);
    const mock = loadMockRun(options.mockPath);
    const itemsByProfile = Object.fromEntries(mock.profiles.map((profile) => [profile.profileId, profile.items]));
    return {
      itemsByProfile,
      failures: {},
      enrichmentCounts: Object.fromEntries(Object.entries(itemsByProfile).map(([profileId, items]) => [profileId, countEnriched(items)]))
    };
  }

  return collectMarketplaceListings(config.profiles, {
    profileDir: options.browserProfileDir,
    headless: options.headless,
    navTimeoutMs: options.navTimeoutMs,
    profileTimeoutMs: options.profileTimeoutMs,
    maxListingsPerProfile: options.maxListingsPerProfile,
    detailEnrichmentTopN: options.detailEnrichmentTopN,
    detailWaitMs: options.detailWaitMs,
    debug: options.debug,
    logger: options.logger
  });
}

function countEnriched(items: RawListing[]): number {
  return items.filter((item) => Boolean(item.description || item.condition || item.detailCollectedAt)).length;
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
