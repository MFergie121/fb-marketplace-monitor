import type { AppDb } from '../db/database.js';

export function acquireRunLock(db: AppDb, lockName: string, ttlMs: number): void {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const nowIso = now.toISOString();
  const current = db.prepare('SELECT expires_at as expiresAt FROM run_locks WHERE lock_name = ?').get(lockName) as { expiresAt: string } | undefined;

  if (current && new Date(current.expiresAt).getTime() > now.getTime()) {
    throw new Error(`Run lock already held for ${lockName} until ${current.expiresAt}`);
  }

  db.prepare(`
    INSERT INTO run_locks (lock_name, acquired_at, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(lock_name) DO UPDATE SET acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
  `).run(lockName, nowIso, expiresAt);
}

export function releaseRunLock(db: AppDb, lockName: string): void {
  db.prepare('DELETE FROM run_locks WHERE lock_name = ?').run(lockName);
}
