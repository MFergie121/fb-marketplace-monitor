import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from './config/loadConfig.js';
import { migrate, openDatabase } from './db/database.js';
import { createLogger } from './logging.js';
import { runMonitor } from './run/runMonitor.js';

dotenv.config();

const command = process.argv[2] ?? 'run';
const args = process.argv.slice(3);
const debugFlagEnabled = hasFlag('--debug');
const debug = debugFlagEnabled || String(process.env.FBM_DEBUG ?? 'false') === 'true';
const logger = createLogger(debug);

const env = {
  dbPath: process.env.FBM_DB_PATH ?? './runtime/fbm.sqlite',
  configPath: process.env.FBM_CONFIG_PATH ?? './config/search-profiles.json',
  browserProfileDir: process.env.FBM_BROWSER_PROFILE_DIR ?? '/Users/maxfergie/.openclaw/browser-profiles/fb-marketplace-monitor',
  headless: String(process.env.FBM_HEADLESS ?? 'false') === 'true',
  navTimeoutMs: Number(process.env.FBM_NAV_TIMEOUT_MS ?? 45000),
  runTimeoutMs: Number(process.env.FBM_RUN_TIMEOUT_MS ?? 300000),
  profileTimeoutMs: Number(process.env.FBM_PROFILE_TIMEOUT_MS ?? 90000),
  maxListingsPerProfile: Number(process.env.FBM_MAX_LISTINGS_PER_PROFILE ?? 40),
  retentionDays: Number(process.env.FBM_RETENTION_DAYS ?? 30),
  emptyResultsThreshold: Number(process.env.FBM_EMPTY_RESULTS_THRESHOLD ?? 2),
  suspiciousEmptyMinProfiles: Number(process.env.FBM_SUSPICIOUS_EMPTY_MIN_PROFILES ?? 1),
  debug
};

async function main(): Promise<void> {
  switch (command) {
    case 'init-db': {
      logger.info(`Opening DB at ${path.resolve(env.dbPath)}`);
      const db = openDatabase(env.dbPath);
      migrate(db);
      db.close();
      console.log(`DB initialised at ${path.resolve(env.dbPath)}`);
      return;
    }
    case 'run': {
      logger.info(`Startup: loading config from ${path.resolve(env.configPath)}`);
      const config = loadConfig(env.configPath);
      const profileFilter = getFlagValue('--profile');
      const filteredProfiles = profileFilter
        ? config.profiles.filter((profile) => profile.id === profileFilter)
        : config.profiles;

      if (profileFilter && filteredProfiles.length === 0) {
        throw new Error(`No profile matched --profile ${profileFilter}`);
      }

      const effectiveConfig = { profiles: filteredProfiles };
      const mockPath = getFlagValue('--mock');
      logger.info(`Config loaded: ${effectiveConfig.profiles.filter((profile) => profile.enabled).length} enabled profile(s)`);
      if (profileFilter) {
        logger.info(`Diagnostic mode: restricted to profile ${profileFilter}`);
      }
      if (mockPath) {
        logger.info(`Mock mode enabled with ${path.resolve(mockPath)}`);
      }

      const result = await runMonitor(effectiveConfig, {
        ...env,
        mockPath: mockPath ? path.resolve(mockPath) : undefined,
        logger
      });
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

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
