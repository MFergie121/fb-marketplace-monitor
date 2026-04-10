import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from './config/loadConfig.js';
import { getDailyDigestCandidates, getRunSummariesInWindow, insertNotification, migrate, openDatabase } from './db/database.js';
import { createLogger } from './logging.js';
import { runMonitor } from './run/runMonitor.js';
import { loadMockRun } from './mocks/loadMockRun.js';
import { buildCatalogFromTopics, buildConfigFromCatalog, loadCatalog, loadTopicDefinition, renderCatalogSummary } from './topics/catalog.js';
import { loadTopicSelection } from './topics/selection.js';
import { generateDailyDigest } from './digest/generateDailyDigest.js';
import type { DigestFormat } from './digest/generateDigest.js';
import type { AppConfig, TopicCatalog } from './types.js';

dotenv.config();

const command = process.argv[2] ?? 'run';
const args = process.argv.slice(3);
const debugFlagEnabled = hasFlag('--debug');
const debug = debugFlagEnabled || String(process.env.FBM_DEBUG ?? 'false') === 'true';
const logger = createLogger(debug);

const env = {
  dbPath: process.env.FBM_DB_PATH ?? './runtime/fbm.sqlite',
  configPath: process.env.FBM_CONFIG_PATH ?? './config/search-profiles.json',
  topicSelectionPath: process.env.FBM_TOPIC_SELECTION_PATH ?? './config/topics/selection.json',
  topicPath: process.env.FBM_TOPIC_PATH,
  catalogPath: process.env.FBM_CATALOG_PATH ?? './runtime/topic-catalog.json',
  browserProfileDir: process.env.FBM_BROWSER_PROFILE_DIR ?? '/Users/maxfergie/.openclaw/browser-profiles/fb-marketplace-monitor',
  headless: String(process.env.FBM_HEADLESS ?? 'false') === 'true',
  navTimeoutMs: Number(process.env.FBM_NAV_TIMEOUT_MS ?? 45000),
  runTimeoutMs: Number(process.env.FBM_RUN_TIMEOUT_MS ?? 300000),
  profileTimeoutMs: Number(process.env.FBM_PROFILE_TIMEOUT_MS ?? 45000),
  maxListingsPerProfile: Number(process.env.FBM_MAX_LISTINGS_PER_PROFILE ?? 24),
  maxQueryVariantsPerProfile: Number(process.env.FBM_MAX_QUERY_VARIANTS_PER_PROFILE ?? 3),
  stopAfterCollectedCount: Number(process.env.FBM_STOP_AFTER_COLLECTED_COUNT ?? 18),
  detailEnrichmentTopN: Number(process.env.FBM_DETAIL_ENRICHMENT_TOP_N ?? 3),
  detailWaitMs: Number(process.env.FBM_DETAIL_WAIT_MS ?? 2500),
  retentionDays: Number(process.env.FBM_RETENTION_DAYS ?? 30),
  emptyResultsThreshold: Number(process.env.FBM_EMPTY_RESULTS_THRESHOLD ?? 2),
  suspiciousEmptyMinProfiles: Number(process.env.FBM_SUSPICIOUS_EMPTY_MIN_PROFILES ?? 1),
  dailyDigestChannelId: process.env.FBM_DAILY_DIGEST_DISCORD_CHANNEL_ID ?? '1487057203105108000',
  debug
};

async function main(): Promise<void> {
  switch (command) {
    case 'list-topics': {
      const selection = resolveTopicSelection();
      const topicPath = resolveTopicPath(selection);
      const activeTopicIds = getActiveTopicIds(selection);
      const catalog = applyRuntimeScope(buildCatalogFromTopics(loadTopicDefinition(topicPath), topicPath), activeTopicIds);
      console.log(`Topic selection file: ${path.resolve(env.topicSelectionPath)}`);
      console.log(`Topic definition file: ${path.resolve(topicPath)}`);
      console.log(renderCatalogSummary(catalog));
      return;
    }
    case 'build-catalog': {
      const selection = resolveTopicSelection();
      const topicPath = resolveTopicPath(selection);
      const outputPath = path.resolve(getFlagValue('--out') ?? env.catalogPath);
      const definition = loadTopicDefinition(topicPath);
      const catalog = applyRuntimeScope(buildCatalogFromTopics(definition, topicPath), getActiveTopicIds(selection));
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
      console.log(renderCatalogSummary(catalog));
      console.log(`\nWrote topic catalog to ${outputPath}`);
      return;
    }
    case 'build-research-config': {
      const selection = resolveTopicSelection();
      const topicPath = resolveTopicPath(selection);
      const outputPath = path.resolve(getFlagValue('--out') ?? './runtime/research-generated-search-profiles.json');
      const definition = loadTopicDefinition(topicPath);
      const catalog = applyRuntimeScope(buildCatalogFromTopics(definition, topicPath), getActiveTopicIds(selection));
      const config = buildConfigFromCatalog(catalog);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      console.log(renderCatalogSummary(catalog));
      console.log(`\nWrote catalog-derived config to ${outputPath}`);
      return;
    }
    case 'init-db': {
      logger.info(`Opening DB at ${path.resolve(env.dbPath)}`);
      const db = openDatabase(env.dbPath);
      migrate(db);
      db.close();
      console.log(`DB initialised at ${path.resolve(env.dbPath)}`);
      return;
    }
    case 'run': {
      await handleRunCommand();
      return;
    }
    case 'daily-digest': {
      handleDailyDigestCommand();
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function handleRunCommand(): Promise<void> {
  const { config, sourceLabel, pipelineLabel, catalog } = resolveRuntimeConfig();
  logger.info(`Startup: ${sourceLabel}`);
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
  const effectiveConfig: AppConfig = {
    profiles: mockProfileIds && !profileFilter
      ? filteredProfiles.filter((profile) => mockProfileIds.has(profile.id))
      : filteredProfiles
  };
  logger.info(`Config loaded: ${effectiveConfig.profiles.filter((profile) => profile.enabled).length} enabled profile(s)`);
  if (profileFilter) logger.info(`Diagnostic mode: restricted to profile ${profileFilter}`);
  if (mockPath) logger.info(`Mock mode enabled with ${path.resolve(mockPath)}`);
  logger.info(pipelineLabel);
  logger.info(`Runtime caps: queryVariants<=${env.maxQueryVariantsPerProfile}, stopAfterCollected>=${env.stopAfterCollectedCount}, maxListings<=${env.maxListingsPerProfile}, detailEnrichmentTopN<=${env.detailEnrichmentTopN}, profileTimeoutMs=${env.profileTimeoutMs}`);
  if (catalog) {
    persistCatalogSnapshot(catalog, env.catalogPath);
    logger.info(`Catalog scope: ${catalog.metadata.scopeLabel ?? 'unspecified'}`);
    logger.info(`Catalog topics active: ${catalog.metadata.activeTopicIds.join(', ') || 'none'}`);
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
  fs.writeFileSync(path.resolve('runtime/latest-digest.debug.discord.txt'), result.digests.debugDiscord, 'utf8');
  fs.writeFileSync(path.resolve('runtime/latest-digest.debug.email.txt'), result.digests.debugEmail, 'utf8');
  console.log(digestToPrint);
  console.log(`\nRun ${result.runId} finished with status=${result.status}`);
}

function handleDailyDigestCommand(): void {
  const { config } = resolveRuntimeConfig();
  const window = resolveDigestWindow(getFlagValue('--date'));
  const db = openDatabase(env.dbPath);
  migrate(db);
  const candidates = getDailyDigestCandidates(db, {
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    profiles: config.profiles.filter((profile) => profile.enabled)
  });
  const runs = getRunSummariesInWindow(db, window.windowStart, window.windowEnd);
  const discordDigest = generateDailyDigest({
    dayLabel: window.dayLabel,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    channelId: env.dailyDigestChannelId,
    profiles: config.profiles.filter((profile) => profile.enabled).map((profile) => ({ id: profile.id, label: profile.label })),
    candidates,
    runs
  }, 'discord');
  const emailDigest = generateDailyDigest({
    dayLabel: window.dayLabel,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    channelId: env.dailyDigestChannelId,
    profiles: config.profiles.filter((profile) => profile.enabled).map((profile) => ({ id: profile.id, label: profile.label })),
    candidates,
    runs
  }, 'email');

  fs.mkdirSync(path.resolve('runtime'), { recursive: true });
  fs.writeFileSync(path.resolve('runtime/daily-digest.discord.txt'), discordDigest, 'utf8');
  fs.writeFileSync(path.resolve('runtime/daily-digest.email.txt'), emailDigest, 'utf8');
  fs.writeFileSync(path.resolve('runtime/daily-digest.meta.json'), `${JSON.stringify({
    channelId: env.dailyDigestChannelId,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    dayLabel: window.dayLabel,
    candidateCount: candidates.length,
    runCount: runs.length,
    discordPath: path.resolve('runtime/daily-digest.discord.txt')
  }, null, 2)}\n`, 'utf8');

  const latestRunId = runs.at(-1)?.runId ?? 0;
  if (latestRunId > 0) insertNotification(db, latestRunId, discordDigest, 'discord_daily_digest_preview');
  db.close();
  console.log(discordDigest);
  console.log(`\nDaily digest prepared for Discord channel ${env.dailyDigestChannelId}`);
}

function resolveDigestWindow(dateArg?: string): { dayLabel: string; windowStart: string; windowEnd: string } {
  const dayKey = dateArg ?? new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  const windowStart = new Date(`${dayKey}T00:00:00+10:00`).toISOString();
  const windowEnd = new Date(`${dayKey}T24:00:00+10:00`).toISOString();
  const label = new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'Australia/Melbourne'
  }).format(new Date(`${dayKey}T12:00:00+10:00`));
  return { dayLabel: label, windowStart, windowEnd };
}

function resolveRuntimeConfig(): { config: AppConfig; sourceLabel: string; pipelineLabel: string; catalog?: TopicCatalog } {
  const selection = resolveTopicSelection();
  const configPath = getFlagValue('--config') ?? env.configPath;
  const catalogPath = getFlagValue('--catalog') ?? env.catalogPath;
  const topicPath = resolveTopicPath(selection);
  const activeTopicIds = getActiveTopicIds(selection);

  if (hasFlag('--config')) {
    return {
      config: loadConfig(configPath),
      sourceLabel: `loading static config from ${path.resolve(configPath)}`,
      pipelineLabel: 'Pipeline 2: runtime consuming static profile config (legacy mode)'
    };
  }

  if (hasFlag('--topic')) {
    const catalog = applyRuntimeScope(buildCatalogFromTopics(loadTopicDefinition(topicPath), topicPath), activeTopicIds);
    return {
      catalog,
      config: buildConfigFromCatalog(catalog),
      sourceLabel: `building topic catalog in-memory from ${path.resolve(topicPath)}`,
      pipelineLabel: 'Pipeline 2: runtime consuming topic-derived catalog built on demand'
    };
  }

  if (fs.existsSync(path.resolve(catalogPath))) {
    const catalog = applyRuntimeScope(loadCatalog(catalogPath), activeTopicIds);
    return {
      catalog,
      config: buildConfigFromCatalog(catalog),
      sourceLabel: `loading topic catalog from ${path.resolve(catalogPath)}`,
      pipelineLabel: 'Pipeline 2: runtime consuming stored topic catalog'
    };
  }

  const catalog = applyRuntimeScope(buildCatalogFromTopics(loadTopicDefinition(topicPath), topicPath), activeTopicIds);
  return {
    catalog,
    config: buildConfigFromCatalog(catalog),
    sourceLabel: `catalog missing, building from topic definition ${path.resolve(topicPath)}`,
    pipelineLabel: 'Pipeline 2: runtime consuming topic-derived catalog (auto-built fallback)'
  };
}

function persistCatalogSnapshot(catalog: TopicCatalog, catalogPath: string): void {
  const absolutePath = path.resolve(catalogPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}

function getActiveTopicIds(selection?: { activeTopicIds?: string[] }): string[] | undefined {
  const fromFlag = getFlagValue('--topic-ids') ?? getFlagValue('--topic-id');
  const fromEnv = process.env.FBM_ACTIVE_TOPIC_IDS;
  const fromSelection = selection?.activeTopicIds?.join(',');
  const raw = fromFlag ?? fromEnv ?? fromSelection;
  if (!raw) return undefined;
  const ids = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

function resolveTopicSelection(): { topicPath: string; activeTopicIds: string[] } | undefined {
  if (!fs.existsSync(path.resolve(env.topicSelectionPath))) return undefined;
  return loadTopicSelection(env.topicSelectionPath);
}

function resolveTopicPath(selection?: { topicPath: string }): string {
  return getFlagValue('--topic') ?? env.topicPath ?? selection?.topicPath ?? './config/topics/all-topics.json';
}

function applyRuntimeScope(catalog: TopicCatalog, activeTopicIds?: string[]): TopicCatalog {
  const activeSet = activeTopicIds ? new Set(activeTopicIds) : null;
  const topics = catalog.topics.map((topic) => ({
    ...topic,
    enabled: activeSet ? topic.groupIds.some((groupId) => activeSet.has(groupId)) || activeSet.has(topic.id) : topic.enabled
  }));
  const active = topics.filter((topic) => topic.enabled).map((topic) => topic.id);
  return {
    ...catalog,
    topics,
    metadata: {
      ...catalog.metadata,
      activeTopicIds: active,
      scopeLabel: active.length === 1
        ? `POC single-topic focus: ${topics.find((topic) => topic.enabled)?.label ?? active[0]}`
        : `Multi-topic sweep: ${active.length} active topics`
    }
  };
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
