import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from './config/loadConfig.js';
import { migrate, openDatabase } from './db/database.js';
import { runMonitor } from './run/runMonitor.js';

dotenv.config();

const command = process.argv[2] ?? 'run';
const args = process.argv.slice(3);

const env = {
  dbPath: process.env.FBM_DB_PATH ?? './runtime/fbm.sqlite',
  configPath: process.env.FBM_CONFIG_PATH ?? './config/search-profiles.json',
  browserProfileDir: process.env.FBM_BROWSER_PROFILE_DIR ?? '/Users/maxfergie/.openclaw/browser-profiles/fb-marketplace-monitor',
  headless: String(process.env.FBM_HEADLESS ?? 'false') === 'true',
  navTimeoutMs: Number(process.env.FBM_NAV_TIMEOUT_MS ?? 45000),
  runTimeoutMs: Number(process.env.FBM_RUN_TIMEOUT_MS ?? 300000),
  maxListingsPerProfile: Number(process.env.FBM_MAX_LISTINGS_PER_PROFILE ?? 40),
  retentionDays: Number(process.env.FBM_RETENTION_DAYS ?? 30),
  emptyResultsThreshold: Number(process.env.FBM_EMPTY_RESULTS_THRESHOLD ?? 2),
  suspiciousEmptyMinProfiles: Number(process.env.FBM_SUSPICIOUS_EMPTY_MIN_PROFILES ?? 1),
  debug: String(process.env.FBM_DEBUG ?? 'false') === 'true'
};

async function main(): Promise<void> {
  switch (command) {
    case 'init-db': {
      const db = openDatabase(env.dbPath);
      migrate(db);
      db.close();
      console.log(`DB initialised at ${path.resolve(env.dbPath)}`);
      return;
    }
    case 'run': {
      const config = loadConfig(env.configPath);
      const mockPath = getFlagValue('--mock');
      const result = await runMonitor(config, { ...env, mockPath: mockPath ? path.resolve(mockPath) : undefined });
      fs.mkdirSync(path.resolve('runtime'), { recursive: true });
      fs.writeFileSync(path.resolve('runtime/latest-digest.txt'), result.digest, 'utf8');
      console.log(result.digest);
      console.log(`\nRun ${result.runId} finished with status=${result.status}`);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function getFlagValue(flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
