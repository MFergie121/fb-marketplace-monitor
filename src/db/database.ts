import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { BuyerBucket } from '../digest/generateDigest.js';
import type { DailyDigestCandidate, DailyDigestRunSummary } from '../digest/generateDailyDigest.js';
import type { RawListing, ScoredObservation, RunStatus, SearchProfile } from '../types.js';

export type AppDb = Database.Database;

export function openDatabase(dbPath: string): AppDb {
  const absolute = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const db = new Database(absolute);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function migrate(db: AppDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_message TEXT,
      suspicious_empty INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      canonical_url TEXT NOT NULL,
      title TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      latest_seen_at TEXT NOT NULL,
      latest_price REAL,
      latest_price_text TEXT,
      currency TEXT,
      image_url TEXT,
      seller_name TEXT,
      latest_description TEXT,
      latest_location TEXT,
      latest_condition TEXT,
      detail_collected_at TEXT,
      last_profile_id TEXT
    );

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      title TEXT NOT NULL,
      price REAL,
      currency TEXT,
      location TEXT,
      image_url TEXT,
      seller_name TEXT,
      description TEXT,
      condition TEXT,
      posted_text TEXT,
      detail_collected_at TEXT,
      score INTEGER NOT NULL,
      reason_codes_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS digest_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL,
      bucket TEXT NOT NULL,
      score INTEGER NOT NULL,
      valuation_assessment TEXT NOT NULL,
      buyer_angle TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, listing_id, profile_id, bucket)
    );

    CREATE TABLE IF NOT EXISTS run_locks (
      lock_name TEXT PRIMARY KEY,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_observations_run_id ON observations(run_id);
    CREATE INDEX IF NOT EXISTS idx_observations_listing_id ON observations(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listings_latest_seen_at ON listings(latest_seen_at);
    CREATE INDEX IF NOT EXISTS idx_digest_candidates_created_at ON digest_candidates(created_at);
    CREATE INDEX IF NOT EXISTS idx_digest_candidates_profile_id ON digest_candidates(profile_id);
  `);

  ensureColumn(db, 'listings', 'latest_condition', 'TEXT');
  ensureColumn(db, 'listings', 'detail_collected_at', 'TEXT');
  ensureColumn(db, 'listings', 'latest_price_text', 'TEXT');
  ensureColumn(db, 'observations', 'condition', 'TEXT');
  ensureColumn(db, 'observations', 'detail_collected_at', 'TEXT');
}

export function createRun(db: AppDb, startedAt: string): number {
  const stmt = db.prepare('INSERT INTO runs (status, started_at) VALUES (?, ?)');
  const result = stmt.run('partial', startedAt);
  return Number(result.lastInsertRowid);
}

export function finishRun(db: AppDb, runId: number, input: { status: RunStatus; finishedAt: string; errorMessage?: string | null; suspiciousEmpty: boolean; metadata: unknown; }): void {
  db.prepare(`UPDATE runs SET status = ?, finished_at = ?, error_message = ?, suspicious_empty = ?, metadata_json = ? WHERE id = ?`)
    .run(input.status, input.finishedAt, input.errorMessage ?? null, input.suspiciousEmpty ? 1 : 0, JSON.stringify(input.metadata), runId);
}

export function upsertListing(db: AppDb, listing: RawListing & { observedAt: string; profileId: string; }): { listingId: number; isNew: boolean; } {
  const existing = db.prepare('SELECT id FROM listings WHERE external_id = ?').get(listing.externalId) as { id: number } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE listings
      SET canonical_url = ?, title = ?, latest_seen_at = ?, latest_price = ?, latest_price_text = ?, currency = ?, image_url = ?, seller_name = ?, latest_description = ?, latest_location = ?, latest_condition = ?, detail_collected_at = ?, last_profile_id = ?
      WHERE id = ?
    `).run(
      listing.url,
      listing.title,
      listing.observedAt,
      listing.price ?? null,
      listing.priceText ?? null,
      listing.currency ?? null,
      listing.imageUrl ?? null,
      listing.sellerName ?? null,
      listing.description ?? null,
      listing.location ?? null,
      listing.condition ?? null,
      listing.detailCollectedAt ?? null,
      listing.profileId,
      existing.id
    );
    return { listingId: existing.id, isNew: false };
  }

  const insert = db.prepare(`
    INSERT INTO listings (
      external_id, canonical_url, title, first_seen_at, latest_seen_at, latest_price, latest_price_text, currency, image_url, seller_name, latest_description, latest_location, latest_condition, detail_collected_at, last_profile_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(
    listing.externalId,
    listing.url,
    listing.title,
    listing.observedAt,
    listing.observedAt,
    listing.price ?? null,
    listing.priceText ?? null,
    listing.currency ?? null,
    listing.imageUrl ?? null,
    listing.sellerName ?? null,
    listing.description ?? null,
    listing.location ?? null,
    listing.condition ?? null,
    listing.detailCollectedAt ?? null,
    listing.profileId
  );
  return { listingId: Number(result.lastInsertRowid), isNew: true };
}

export function insertObservation(db: AppDb, runId: number, listingId: number, observation: ScoredObservation): void {
  db.prepare(`
    INSERT INTO observations (
      run_id, listing_id, profile_id, observed_at, title, price, currency, location, image_url, seller_name, description, condition, posted_text, detail_collected_at, score, reason_codes_json, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    listingId,
    observation.profileId,
    observation.observedAt,
    observation.title,
    observation.price ?? null,
    observation.currency ?? null,
    observation.location ?? null,
    observation.imageUrl ?? null,
    observation.sellerName ?? null,
    observation.description ?? null,
    observation.condition ?? null,
    observation.postedText ?? null,
    observation.detailCollectedAt ?? null,
    observation.score,
    JSON.stringify(observation.reasons),
    JSON.stringify(observation)
  );
}

export function insertDigestCandidate(db: AppDb, input: { runId: number; listingId: number; profileId: string; bucket: BuyerBucket; score: number; valuationAssessment: string; buyerAngle: string; createdAt: string; }): void {
  db.prepare(`
    INSERT OR IGNORE INTO digest_candidates (
      run_id, listing_id, profile_id, bucket, score, valuation_assessment, buyer_angle, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.runId, input.listingId, input.profileId, input.bucket, input.score, input.valuationAssessment, input.buyerAngle, input.createdAt);
}

export function insertNotification(db: AppDb, runId: number, payload: string, channel = 'discord_digest_preview'): void {
  db.prepare('INSERT INTO notifications (run_id, listing_id, channel, status, payload_text, created_at) VALUES (?, NULL, ?, ?, ?, ?)')
    .run(runId, channel, 'generated', payload, new Date().toISOString());
}

export function getRecentObservedCounts(db: AppDb, profileId: string, limit = 3): number[] {
  const rows = db.prepare(`
    SELECT COUNT(*) as count
    FROM observations
    WHERE profile_id = ?
    GROUP BY run_id
    ORDER BY run_id DESC
    LIMIT ?
  `).all(profileId, limit) as Array<{ count: number }>;
  return rows.map((row) => row.count);
}

export function getDailyDigestCandidates(
  db: AppDb,
  input: { windowStart: string; windowEnd: string; profiles: SearchProfile[] }
): DailyDigestCandidate[] {
  const rows = db.prepare(`
    SELECT
      dc.listing_id as listingId,
      l.external_id as externalId,
      dc.profile_id as profileId,
      l.title as title,
      l.canonical_url as url,
      l.latest_price as latestPrice,
      l.latest_price_text as latestPriceText,
      l.currency as currency,
      l.latest_location as location,
      MAX(dc.score) as bestScore,
      MAX(CASE WHEN dc.created_at = last_seen.lastCreatedAt THEN dc.score ELSE NULL END) as latestScore,
      MAX(CASE WHEN dc.created_at = last_seen.lastCreatedAt THEN dc.valuation_assessment ELSE NULL END) as latestAssessment,
      MIN(dc.created_at) as firstSeenAt,
      MAX(dc.created_at) as lastSeenAt,
      GROUP_CONCAT(dc.run_id) as surfacedRunIds,
      COUNT(*) as surfacedCount,
      MAX(CASE WHEN dc.created_at = last_seen.lastCreatedAt THEN dc.buyer_angle ELSE NULL END) as buyerAngle,
      CASE WHEN SUM(CASE WHEN dc.bucket = 'top_pick' THEN 1 ELSE 0 END) > 0 THEN 'top_pick' ELSE 'worth_a_look' END as bucket
    FROM digest_candidates dc
    INNER JOIN listings l ON l.id = dc.listing_id
    INNER JOIN (
      SELECT listing_id, profile_id, MAX(created_at) as lastCreatedAt
      FROM digest_candidates
      WHERE created_at >= ? AND created_at < ?
      GROUP BY listing_id, profile_id
    ) last_seen
      ON last_seen.listing_id = dc.listing_id
      AND last_seen.profile_id = dc.profile_id
    WHERE dc.created_at >= ? AND dc.created_at < ?
    GROUP BY dc.listing_id, l.external_id, dc.profile_id, l.title, l.canonical_url, l.latest_price, l.latest_price_text, l.currency, l.latest_location
  `).all(input.windowStart, input.windowEnd, input.windowStart, input.windowEnd) as Array<{
    listingId: number;
    externalId: string;
    profileId: string;
    title: string;
    url: string;
    latestPrice: number | null;
    latestPriceText: string | null;
    currency: string | null;
    location: string | null;
    bestScore: number;
    latestScore: number | null;
    latestAssessment: string;
    firstSeenAt: string;
    lastSeenAt: string;
    surfacedRunIds: string;
    surfacedCount: number;
    buyerAngle: string | null;
    bucket: BuyerBucket;
  }>;

  const labels = new Map(input.profiles.map((profile) => [profile.id, profile.label]));
  return rows.map((row) => ({
    listingId: row.listingId,
    externalId: row.externalId,
    profileId: row.profileId,
    profileLabel: labels.get(row.profileId) ?? row.profileId,
    bucket: row.bucket,
    title: row.title,
    url: row.url,
    latestPrice: row.latestPrice,
    latestPriceText: row.latestPriceText,
    currency: row.currency,
    location: row.location,
    latestScore: row.latestScore ?? row.bestScore,
    bestScore: row.bestScore,
    latestAssessment: row.latestAssessment as DailyDigestCandidate['latestAssessment'],
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    surfacedRunIds: row.surfacedRunIds.split(',').map((value) => Number(value)).filter((value) => Number.isFinite(value)),
    surfacedCount: row.surfacedCount,
    buyerAngle: row.buyerAngle ?? ''
  }));
}

export function getRunSummariesInWindow(db: AppDb, windowStart: string, windowEnd: string): DailyDigestRunSummary[] {
  return db.prepare(`
    SELECT id as runId, status, finished_at as finishedAt
    FROM runs
    WHERE started_at >= ? AND started_at < ?
    ORDER BY started_at ASC
  `).all(windowStart, windowEnd) as DailyDigestRunSummary[];
}

export function cleanupOldData(db: AppDb, retentionDays: number): void {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM observations WHERE observed_at < ?').run(cutoff);
  db.prepare('DELETE FROM digest_candidates WHERE created_at < ?').run(cutoff);
  db.prepare('DELETE FROM notifications WHERE created_at < ?').run(cutoff);
  db.prepare(`DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?`).run(cutoff);
}

export function listProfilesSeen(db: AppDb): Array<{ profileId: string; lastSeenAt: string }> {
  return db.prepare('SELECT last_profile_id as profileId, latest_seen_at as lastSeenAt FROM listings WHERE last_profile_id IS NOT NULL ORDER BY latest_seen_at DESC').all() as Array<{ profileId: string; lastSeenAt: string }>;
}

function ensureColumn(db: AppDb, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
