require('dotenv').config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const pino = require("pino");
const pinoHttp = require("pino-http");
const { z } = require("zod");

const { getConfig } = require("./config");
const { state, log, ensureDayCounter, getStats } = require("./state");
const path = require("path");
const { runUnfollowJob, runFollowJob, runScanJob, requestStop } = require("./jobs");
const { loadSnapshot } = require("./persistence");
const { startImporter, getImporterStatus } = require("./importer");

const config = getConfig();
const isDev = config.nodeEnv === 'development';

// Pino logger with pretty printing in dev
const logger = pino({
  level: config.logLevel,
  transport: isDev ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    }
  } : undefined,
});

const app = express();

/* ---------------- Middleware ---------------- */

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// CORS
const corsOptions = {
  origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// Body parsing
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Request logging — suppress noisy polling endpoints
const QUIET_ROUTES = ['/api/unfollow/status', '/health', '/api/config'];
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => QUIET_ROUTES.includes(req.url),
  },
}));

// Trust proxy (for Railway, Render, etc.)
if (config.nodeEnv === 'production') {
  app.set('trust proxy', 1);
}

// Static UI — served from Backend/public/. Visit http://localhost:4545/
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------------- Routes ---------------- */

// Health check
app.get("/health", (_req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    nodeEnv: config.nodeEnv,
  });
});

// Get current status
app.get("/api/unfollow/status", (_req, res) => {
  try {
    ensureDayCounter();
    
    const stats = getStats();
    const recentLogs = state.logs.slice(0, 120).map(entry => {
      if (typeof entry === 'string') {
        return entry;
      }
      return `[${entry.timestamp}] ${entry.message}`;
    });

    res.json({
      ok: true,
      ...stats,
      daily: {
        ...stats.daily,
        limit: config.dailyLimit,
        remaining: Math.max(0, config.dailyLimit - stats.daily.count),
      },
      minDelayMs: config.minDelayMs,
      maxDelayMs: config.maxDelayMs,
      dryRun: config.dryRun,
      logs: recentLogs,
    });
  } catch (err) {
    logger.error({ err }, 'Error fetching status');
    res.status(500).json({ 
      ok: false, 
      message: 'Error fetching status',
      error: err.message 
    });
  }
});

// Stop current run
app.post("/api/unfollow/stop", (_req, res) => {
  try {
    if (!state.running) {
      return res.json({ 
        ok: false, 
        message: 'No job is currently running' 
      });
    }

    requestStop();
    res.json({ 
      ok: true, 
      message: 'Stop requested. Job will end after current action.' 
    });
  } catch (err) {
    logger.error({ err }, 'Error stopping job');
    res.status(500).json({ 
      ok: false, 
      message: 'Error stopping job',
      error: err.message 
    });
  }
});

// Start unfollow job
app.post("/api/unfollow/start", async (req, res) => {
  try {
    // Validate request body
    const schema = z.object({
      usernames: z.array(z.string().min(1).max(100))
        .min(1, "At least one username required")
        .max(50_000, "Maximum 50000 usernames allowed"),
      minDelayMs: z.number().int().positive().optional(),
      maxDelayMs: z.number().int().positive().optional(),
      dailyLimit: z.number().int().positive().max(5000).optional(),
      dryRun: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body);
    
    if (!parsed.success) {
      return res.status(400).json({ 
        ok: false, 
        message: "Invalid request body", 
        errors: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const body = parsed.data;

    // Merge with default config
    const runConfig = {
      ...config,
      minDelayMs: body.minDelayMs ?? config.minDelayMs,
      maxDelayMs: body.maxDelayMs ?? config.maxDelayMs,
      dailyLimit: body.dailyLimit ?? config.dailyLimit,
      dryRun: body.dryRun ?? config.dryRun,
    };

    // Validate delay configuration
    if (runConfig.minDelayMs >= runConfig.maxDelayMs) {
      return res.status(400).json({
        ok: false,
        message: 'minDelayMs must be less than maxDelayMs',
      });
    }

    // Log configuration warnings
    if (!runConfig.chromeUserDataDir) {
      logger.warn('⚠️  CHROME_USER_DATA_DIR not set - browser will start fresh (not logged in)');
    }

    logger.info({ 
      usernames: body.usernames.length,
      dryRun: runConfig.dryRun,
      dailyLimit: runConfig.dailyLimit,
    }, 'Starting unfollow job');

    // Fire and forget - run in background
    runUnfollowJob({ 
      usernames: body.usernames, 
      config: runConfig 
    }).catch((err) => {
      logger.error({ err }, 'Background job error');
    });

    res.json({ 
      ok: true, 
      started: true,
      message: 'Job started successfully',
      queueSize: body.usernames.length,
    });

  } catch (err) {
    logger.error({ err }, 'Error starting job');
    res.status(500).json({ 
      ok: false, 
      message: 'Error starting job',
      error: err.message 
    });
  }
});

// Start follow job (scrapes a source profile, then follows N random users)
app.post("/api/follow/start", async (req, res) => {
  try {
    const schema = z.object({
      source: z.object({
        username: z.string().min(1).max(100),
        type: z.enum(['followers', 'following']),
      }),
      count: z.number().int().positive().max(5000),
      minDelayMs: z.number().int().positive().optional(),
      maxDelayMs: z.number().int().positive().optional(),
      dailyLimit: z.number().int().positive().max(5000).optional(),
      dryRun: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        message: "Invalid request body",
        errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const body = parsed.data;
    const runConfig = {
      ...config,
      minDelayMs: body.minDelayMs ?? config.minDelayMs,
      maxDelayMs: body.maxDelayMs ?? config.maxDelayMs,
      dailyLimit: body.dailyLimit ?? config.dailyLimit,
      dryRun: body.dryRun ?? config.dryRun,
    };

    if (runConfig.minDelayMs >= runConfig.maxDelayMs) {
      return res.status(400).json({ ok: false, message: 'minDelayMs must be less than maxDelayMs' });
    }

    logger.info({ source: body.source, count: body.count, dryRun: runConfig.dryRun }, 'Starting follow job');

    runFollowJob({ source: body.source, count: body.count, config: runConfig })
      .catch((err) => logger.error({ err }, 'Background follow-job error'));

    res.json({
      ok: true,
      started: true,
      message: 'Follow job started successfully',
      target: body.count,
    });
  } catch (err) {
    logger.error({ err }, 'Error starting follow job');
    res.status(500).json({ ok: false, message: 'Error starting follow job', error: err.message });
  }
});

// Generic stop alias — works for any running job (follow or unfollow)
app.post("/api/job/stop", (_req, res) => {
  if (!state.running) {
    return res.json({ ok: false, message: 'No job is currently running' });
  }
  requestStop();
  res.json({ ok: true, message: 'Stop requested. Job will end after current action.' });
});

// Start an account scan — scrapes the logged-in user's followers + following
// and caches the result to data/snapshot.json
app.post("/api/scan/start", async (req, res) => {
  try {
    if (state.running) {
      return res.status(409).json({ ok: false, message: 'A job is already running' });
    }
    const schema = z.object({
      ownerUsername: z.string().min(1).max(100).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, message: 'Invalid request body' });
    }

    logger.info({ ownerUsername: parsed.data.ownerUsername }, 'Starting scan job');
    runScanJob({ ownerUsername: parsed.data.ownerUsername, config })
      .catch((err) => logger.error({ err }, 'Background scan-job error'));

    res.json({ ok: true, started: true, message: 'Scan started' });
  } catch (err) {
    logger.error({ err }, 'Error starting scan');
    res.status(500).json({ ok: false, message: 'Error starting scan', error: err.message });
  }
});

// Upload pre-extracted followers/following from Instagram's data download.
// Frontend reads the JSON files locally (FileReader) and posts the extracted
// usernames here, so we don't need a multipart/zip dependency.
app.post("/api/scan/upload", (req, res) => {
  try {
    if (state.running) {
      return res.status(409).json({ ok: false, message: "A job is currently running" });
    }

    const schema = z.object({
      owner: z.string().min(1).max(100),
      followers: z.array(z.string().min(1).max(100)).max(1_000_000),
      following: z.array(z.string().min(1).max(100)).max(1_000_000),
    });

    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        message: "Invalid upload payload",
        errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    const { normalizeUsername } = require("./utils");
    const owner = normalizeUsername(parsed.data.owner);
    const followers = Array.from(new Set(parsed.data.followers.map(normalizeUsername).filter(Boolean)));
    const followingArr = Array.from(new Set(parsed.data.following.map(normalizeUsername).filter(Boolean)));

    const { saveSnapshot } = require("./persistence");
    saveSnapshot({
      owner,
      scannedAt: new Date().toISOString(),
      source: "data_download",
      followers,
      following: followingArr,
    });

    state.lastUsername = owner;
    log(`📥 Imported data download for @${owner}: ${followers.length} followers, ${followingArr.length} following`);

    res.json({
      ok: true,
      owner,
      counts: { followers: followers.length, following: followingArr.length },
    });
  } catch (err) {
    logger.error({ err }, "Error importing data download");
    res.status(500).json({ ok: false, message: "Error importing data download", error: err.message });
  }
});

// Status of the auto-import watcher (watched dir, last import, errors).
app.get("/api/import/status", (_req, res) => {
  res.json({ ok: true, status: getImporterStatus(config) });
});

// Read the latest snapshot from disk and return computed comparison.
app.get("/api/scan/latest", (_req, res) => {
  const snap = loadSnapshot();
  if (!snap) return res.json({ ok: true, snapshot: null });

  const followers = snap.followers || [];
  const following = snap.following || [];
  const fSet = new Set(followers);
  const gSet = new Set(following);
  const comparison = {
    notFollowingBack: following.filter((u) => !fSet.has(u)),
    mutuals: following.filter((u) => fSet.has(u)),
    fans: followers.filter((u) => !gSet.has(u)),
  };

  res.json({
    ok: true,
    snapshot: {
      owner: snap.owner,
      scannedAt: snap.scannedAt,
      counts: {
        followers: followers.length,
        following: following.length,
        notFollowingBack: comparison.notFollowingBack.length,
        mutuals: comparison.mutuals.length,
        fans: comparison.fans.length,
      },
      lists: comparison,
    },
  });
});

// Get config (useful for frontend)
app.get("/api/config", (_req, res) => {
  res.json({
    ok: true,
    config: {
      dailyLimit: config.dailyLimit,
      minDelayMs: config.minDelayMs,
      maxDelayMs: config.maxDelayMs,
      dryRun: config.dryRun,
      hasChromeProfile: !!config.chromeUserDataDir,
    }
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ 
    ok: false, 
    message: 'Route not found' 
  });
});

// Error handler
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ 
    ok: false, 
    message: 'Internal server error',
    error: isDev ? err.message : undefined,
  });
});

/* ---------------- Server Start ---------------- */

const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      nodeEnv: config.nodeEnv,
      minDelayMs: config.minDelayMs,
      maxDelayMs: config.maxDelayMs,
      dailyLimit: config.dailyLimit,
      dryRun: config.dryRun,
      corsOrigin: config.corsOrigin,
    },
    '🚀 Instagram automation service started'
  );
  
  logger.info(
    {
      CHROME_USER_DATA_DIR: config.chromeUserDataDir || '(not set)',
      CHROME_PROFILE_DIR: config.chromeProfileDir || '(not set)',
    },
    'Chrome profile configuration'
  );

  if (!config.chromeUserDataDir) {
    logger.warn('⚠️  CHROME_USER_DATA_DIR not set - Instagram login will be required each time');
  }

  // Start the auto-import watcher if IG_IMPORT_DIR is configured.
  startImporter(config);

  logger.info('📖 API Endpoints:');
  logger.info('   GET  /health - Health check');
  logger.info('   GET  /api/unfollow/status - Get current status');
  logger.info('   GET  /api/config - Get configuration');
  logger.info('   POST /api/unfollow/start - Start unfollow job');
  logger.info('   POST /api/unfollow/stop - Stop running job');
  logger.info('   POST /api/follow/start - Start follow job (scrapes source profile)');
  logger.info('   POST /api/job/stop - Generic stop (works for any job type)');
  logger.info('   POST /api/scan/start - Scan logged-in account (followers + following)');
  logger.info('   POST /api/scan/upload - Import Instagram data download JSON');
  logger.info('   GET  /api/import/status - Auto-import watcher status');
  logger.info('   GET  /api/scan/latest - Latest cached snapshot + comparison');
  logger.info(`   GET  /                 - UI (served from Backend/public/)`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, closing server gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, closing server gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

module.exports = app;