import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createCore, AppError } from './core.js';
import { createApiClient } from './apiClient.js';
import { createBot } from './bot.js';
import { createMockProvider } from './providers/mock.js';
import { sportsApi365Provider } from './providers/sportsapi365.js';
import { validateInitData, teamNameFor } from './telegramAuth.js';
import { seedDemo } from './demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  return {
    port: Number(env.PORT || 3000),
    prod,
    botToken: env.BOT_TOKEN || '',
    adminIds: (env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL || '',
    sqlitePath: env.SQLITE_PATH || ':memory:',
    mockApi: env.MOCK_API === '1' || !env.SPORTSAPI365_KEY,
    // Solo sviluppo: accetta l'header X-Dev-User al posto dell'initData firmato.
    devAuth: env.DEV_AUTH === '1' && !prod,
    fakeNow: env.FAKE_NOW || '',
    testWindowOpen: env.TEST_WINDOW_OPEN === '1',
    apiLimit: Number(env.API_MONTHLY_LIMIT || 150),
    webhookSecret: env.WEBHOOK_SECRET || (env.BOT_TOKEN ? crypto.createHash('sha256').update(env.BOT_TOKEN).digest('hex').slice(0, 32) : 'dev'),
    allowCaptainInRoster: env.ALLOW_CAPTAIN_IN_ROSTER === '1',
  };
}

export async function createApp(config = loadConfig(), overrides = {}) {
  const clock = overrides.clock ?? (config.fakeNow ? () => new Date(config.fakeNow) : () => new Date());
  const db = overrides.db ?? (await openDb({ databaseUrl: config.databaseUrl, sqlitePath: config.sqlitePath }));
  const bot = overrides.bot ?? createBot({ token: config.botToken, adminIds: config.adminIds, appUrl: config.publicUrl });
  const api = createApiClient({ db, clock, notifyAdmins: bot.notifyAdmins, limit: config.apiLimit, ...(overrides.apiOptions ?? {}) });
  const provider = overrides.provider ?? (config.mockApi ? createMockProvider() : sportsApi365Provider);
  const core = createCore({ db, provider, api, bot, clock, config });

  async function authenticate(req) {
    let tg;
    if (config.devAuth && req.headers['x-dev-user']) {
      const id = String(req.headers['x-dev-user']);
      tg = { id, username: `dev${id}`, firstName: '', lastName: '' };
    } else {
      try {
        tg = validateInitData(req.headers['x-telegram-init-data'], config.botToken, { now: clock().getTime() });
      } catch (e) {
        throw new AppError('UNAUTHORIZED', 'Autenticazione Telegram non valida', 401);
      }
    }
    const user = await core.findUser(tg.id);
    if (user) await core.touchTeamName(user, teamNameFor(tg));
    return { tg, user, isAdmin: config.adminIds.includes(tg.id) };
  }

  // RT-21: tutte le scritture agiscono solo sull'utente autenticato (mai su ID passati dal client).
  async function route(req, res, url) {
    const m = req.method;
    const p = url.pathname;

    if (p === '/healthz') return send(res, 200, { ok: true });

    if (p === `/telegram/webhook/${config.webhookSecret}` && m === 'POST') {
      const got = req.headers['x-telegram-bot-api-secret-token'];
      if (config.botToken && got !== config.webhookSecret) return send(res, 403, { error: 'forbidden' });
      const update = await readJson(req);
      bot.handleUpdate(update, core).catch((e) => console.error('webhook', e));
      return send(res, 200, { ok: true });
    }

    if (p.startsWith('/api/')) {
      const auth = await authenticate(req);

      if (p === '/api/state' && m === 'GET') return send(res, 200, await core.getState(auth.user));

      if (p === '/api/players' && m === 'GET') {
        const mode = url.searchParams.get('mode') === 'captain' ? 'captain' : 'roster';
        const ctx = await core.context();
        return send(res, 200, { weekStart: ctx.weekStart, refWeek: ctx.refWeek, players: await core.listPlayers(ctx, mode) });
      }

      if (p === '/api/register' && m === 'POST') {
        const body = await readJson(req);
        const user = await core.register({ telegramId: auth.tg.id, teamName: teamNameFor(auth.tg), captainId: String(body.captainId ?? '') });
        return send(res, 201, await core.getState(user));
      }

      if (!auth.user && !p.startsWith('/api/admin')) {
        if (['/api/league', '/api/tournaments/completed', '/api/tournaments/in-progress', '/api/tournaments/next'].includes(p)) {
          // consentito anche ai non iscritti (sola lettura)
        } else {
          throw new AppError('NOT_REGISTERED', 'Completa prima l\'iscrizione', 403);
        }
      }

      if (p === '/api/roster' && m === 'PUT') {
        const body = await readJson(req);
        const roster = await core.saveRoster(auth.user, body.playerIds);
        return send(res, 200, { roster: { playerIds: roster.ids, players: roster.players } });
      }
      if (p === '/api/league' && m === 'GET') {
        const rows = await core.standings();
        return send(res, 200, { me: auth.user?.id ?? null, rows });
      }
      if (p === '/api/tournaments/completed') return send(res, 200, { weeks: await core.completedTournaments(auth.user) });
      if (p === '/api/tournaments/in-progress') return send(res, 200, await core.inProgressTournaments());
      if (p === '/api/tournaments/next') return send(res, 200, await core.nextWeekTournaments());

      if (p.startsWith('/api/admin/')) {
        if (!auth.isAdmin) throw new AppError('FORBIDDEN', 'Non autorizzato', 403);
        if (p === '/api/admin/status' && m === 'GET') return send(res, 200, await core.adminStatus());
        if (p === '/api/admin/recompute' && m === 'POST') {
          await core.audit(auth.tg.id, 'admin:recompute');
          return send(res, 200, await core.recomputePoints());
        }
        if (p === '/api/admin/results' && m === 'POST') return send(res, 200, await core.adminSetResults(auth.tg.id, await readJson(req)));
        if (p === '/api/admin/job' && m === 'POST') {
          const b = await readJson(req);
          return send(res, 200, await core.runJob(String(b.job), String(b.key ?? core.defaultKey(b.job)), { force: true, actor: auth.tg.id }));
        }
      }
      throw new AppError('NOT_FOUND', 'Endpoint inesistente', 404);
    }

    return serveStatic(res, p);
  }

  async function serveStatic(res, p) {
    let rel = decodeURIComponent(p);
    if (rel === '/') rel = '/index.html';
    if (rel === '/privacy') rel = '/privacy.html';
    const base = rel.startsWith('/shared/') ? ROOT : path.join(ROOT, 'public');
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep) && file !== base) return send(res, 403, { error: 'forbidden' });
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    } catch {
      send(res, 404, { error: 'not found' });
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org");
    try {
      await route(req, res, new URL(req.url, 'http://x'));
    } catch (e) {
      if (e instanceof AppError) return send(res, e.status, { error: e.code, message: e.message, ...e.extra });
      console.error(e);
      send(res, 500, { error: 'INTERNAL', message: 'Errore interno' });
    }
  });

  let timer = null;
  async function start() {
    await new Promise((r) => server.listen(config.port, r));
    if (config.publicUrl) {
      await bot.setup({ webhookUrl: `${config.publicUrl}/telegram/webhook/${config.webhookSecret}`, secret: config.webhookSecret }).catch((e) => console.error('bot setup', e.message));
    }
    await core.reconcileProvider().catch((e) => console.error('reconcileProvider', e));
    if (!overrides.noScheduler) {
      timer = setInterval(() => core.tick().catch((e) => console.error('tick', e)), 60_000);
      core.tick().catch((e) => console.error('tick', e));
    }
    return server.address().port;
  }
  async function stop() {
    if (timer) clearInterval(timer);
    await new Promise((r) => server.close(r));
    await db.close();
  }

  return { server, core, db, bot, api, start, stop, config };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new AppError('TOO_LARGE', 'Richiesta troppo grande', 413);
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new AppError('BAD_REQUEST', 'JSON non valido'); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  if (process.env.DEMO_SEED === '1' && !app.config.prod) await seedDemo(app.core, app.db, new Date(process.env.FAKE_NOW || Date.now()));
  const port = await app.start();
  console.log(`upst-fantachallenger in ascolto su :${port} (provider: ${app.config.mockApi ? 'MOCK' : 'SportsAPI365'}, db: ${app.config.databaseUrl ? 'postgres' : 'sqlite'})`);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.stop().then(() => process.exit(0)));
}
