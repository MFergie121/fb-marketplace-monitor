import path from 'node:path';
import type { AppConfig, ListingObservation, RawListing, RunResult, RunStatus, ScoredObservation } from '../types.js';
import { collectMarketplaceListings } from '../collector/marketplaceCollector.js';
import { openDatabase, migrate, createRun, finishRun, upsertListing, insertObservation, insertNotification, getRecentObservedCounts, cleanupOldData } from '../db/database.js';
import { generateDigest } from '../digest/generateDigest.js';
import { loadMockRun } from '../mocks/loadMockRun.js';
import { acquireRunLock, releaseRunLock } from './lock.js';
import { scoreListing } from '../scoring/scoreListings.js';

export type RunOptions = {
  dbPath: string;
  browserProfileDir: string;
  headless: boolean;
  navTimeoutMs: number;
  runTimeoutMs: number;
  maxListingsPerProfile: number;
  retentionDays: number;
  emptyResultsThreshold: number;
  suspiciousEmptyMinProfiles: number;
  debug: boolean;
  mockPath?: string;
};

export async function runMonitor(config: AppConfig, options: RunOptions): Promise<RunResult> {
  const db = openDatabase(options.dbPath);
  migrate(db);
  cleanupOldData(db, options.retentionDays);
  acquireRunLock(db, 'marketplace-monitor', options.runTimeoutMs);

  const startedAt = new Date().toISOString();
  const runId = createRun(db, startedAt);

  try {
    const observedAt = new Date().toISOString();
    const profileItems = await withTimeout(loadItems(config, options), options.runTimeoutMs, 'Run timed out');
    const scored: ScoredObservation[] = [];
    const profileSummaries: RunResult['profileSummaries'] = [];
    const suspiciousProfiles: string[] = [];

    for (const profile of config.profiles.filter((item) => item.enabled)) {
      const items = profileItems[profile.id] ?? [];
      const priorCounts = getRecentObservedCounts(db, profile.id, options.emptyResultsThreshold);
      const suspiciousEmpty = items.length === 0 && priorCounts.some((count) => count > 0);
      if (suspiciousEmpty) suspiciousProfiles.push(profile.id);
      profileSummaries.push({ profileId: profile.id, collected: items.length, suspiciousEmpty });

      for (const item of items) {
        const observation: ListingObservation = { ...item, profileId: profile.id, observedAt };
        const { listingId, isNew } = upsertListing(db, observation);
        const scoredObservation = scoreListing(observation, profile, isNew);
        insertObservation(db, runId, listingId, scoredObservation);
        scored.push(scoredObservation);
      }
    }

    const status: RunStatus = suspiciousProfiles.length >= options.suspiciousEmptyMinProfiles
      ? 'suspicious_empty'
      : 'success';
    const finishedAt = new Date().toISOString();
    const digest = generateDigest({ status, startedAt, finishedAt, scored, profiles: config.profiles.filter((item) => item.enabled), suspiciousProfiles });
    insertNotification(db, runId, digest);
    finishRun(db, runId, {
      status,
      finishedAt,
      suspiciousEmpty: suspiciousProfiles.length > 0,
      metadata: { profileSummaries, digestPathHint: path.resolve('runtime/latest-digest.txt') }
    });

    return { runId, status, startedAt, finishedAt, profileSummaries, digest };
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
    db.close();
  }
}

async function loadItems(config: AppConfig, options: RunOptions): Promise<Record<string, RawListing[]>> {
  if (options.mockPath) {
    const mock = loadMockRun(options.mockPath);
    return Object.fromEntries(mock.profiles.map((profile) => [profile.profileId, profile.items]));
  }

  return collectMarketplaceListings(config.profiles, {
    profileDir: options.browserProfileDir,
    headless: options.headless,
    navTimeoutMs: options.navTimeoutMs,
    maxListingsPerProfile: options.maxListingsPerProfile,
    debug: options.debug
  });
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
