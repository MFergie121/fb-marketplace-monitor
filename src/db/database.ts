import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RawListing, ScoredObservation, RunStatus } from '../types.js';

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

    CREATE TABLE IF NOT EXISTS run_locks (
      lock_name TEXT PRIMARY KEY,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_observations_run_id ON observations(run_id);
    CREATE INDEX IF NOT EXISTS idx_observations_listing_id ON observations(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listings_latest_seen_at ON listings(latest_seen_at);
  `);

  ensureColumn(db, 'listings', 'latest_condition', 'TEXT');
  ensureColumn(db, 'listings', 'detail_collected_at', 'TEXT');
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
      SET canonical_url = ?, title = ?, latest_seen_at = ?, latest_price = ?, currency = ?, image_url = ?, seller_name = ?, latest_description = ?, latest_location = ?, latest_condition = ?, detail_collected_at = ?, last_profile_id = ?
      WHERE id = ?
    `).run(
      listing.url,
      listing.title,
      listing.observedAt,
      listing.price ?? null,
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
      external_id, canonical_url, title, first_seen_at, latest_seen_at, latest_price, currency, image_url, seller_name, latest_description, latest_location, latest_condition, detail_collected_at, last_profile_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(
    listing.externalId,
    listing.url,
    listing.title,
    listing.observedAt,
    listing.observedAt,
    listing.price ?? null,
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

export function insertNotification(db: AppDb, runId: number, payload: string): void {
  db.prepare('INSERT INTO notifications (run_id, listing_id, channel, status, payload_text, created_at) VALUES (?, NULL, ?, ?, ?, ?)')
    .run(runId, 'discord_digest_preview', 'generated', payload, new Date().toISOString());
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

export function cleanupOldData(db: AppDb, retentionDays: number): void {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM observations WHERE observed_at < ?').run(cutoff);
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
