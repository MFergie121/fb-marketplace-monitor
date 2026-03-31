import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from './config/loadConfig.js';
import { migrate, openDatabase } from './db/database.js';
import { createLogger } from './logging.js';
import { runMonitor } from './run/runMonitor.js';
import { loadMockRun } from './mocks/loadMockRun.js';
import type { DigestFormat } from './digest/generateDigest.js';

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
  detailEnrichmentTopN: Number(process.env.FBM_DETAIL_ENRICHMENT_TOP_N ?? 5),
  detailWaitMs: Number(process.env.FBM_DETAIL_WAIT_MS ?? 2500),
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

      const mockPath = getFlagValue('--mock');
      const mockProfileIds = mockPath
        ? new Set(loadMockRun(path.resolve(mockPath)).profiles.map((profile) => profile.profileId))
        : null;
      const effectiveConfig = {
        profiles: mockProfileIds && !profileFilter
          ? filteredProfiles.filter((profile) => mockProfileIds.has(profile.id))
          : filteredProfiles
      };
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
      const digestFormat = getDigestFormat();
      const digestToPrint = result.digests[digestFormat];
      fs.mkdirSync(path.resolve('runtime'), { recursive: true });
      fs.writeFileSync(path.resolve('runtime/latest-digest.txt'), digestToPrint, 'utf8');
      fs.writeFileSync(path.resolve('runtime/latest-digest.discord.txt'), result.digests.discord, 'utf8');
      fs.writeFileSync(path.resolve('runtime/latest-digest.email.txt'), result.digests.email, 'utf8');
      console.log(digestToPrint);
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

function getDigestFormat(): DigestFormat {
  const value = getFlagValue('--digest-format');
  if (!value) return 'discord';
  if (value === 'discord' || value === 'email') return value;
  throw new Error(`Invalid --digest-format value: ${value}. Expected discord or email.`);
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
