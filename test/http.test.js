import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, loadConfig } from '../src/server.js';
import { seedDemo } from '../src/demo.js';
import { signInitData } from '../src/telegramAuth.js';
import { romeToUtc } from '../src/time.js';

async function boot(extra = {}) {
  const config = { ...loadConfig({ BOT_TOKEN: '1:TEST', PORT: '0', MOCK_API: '1', ADMIN_TELEGRAM_IDS: '777' }), port: 0, ...extra };
  const now = romeToUtc('2026-11-23', 10, 0);
  const app = await createApp(config, { clock: () => now, noScheduler: true, bot: { sendMessage: async () => true, notifyAdmins: async () => {}, handleUpdate: async () => {}, setup: async () => {} } });
  await seedDemo(app.core, app.db, now);
  const port = await app.start();
  const call = (path, { user, method = 'GET', body, initData } = {}) => {
    const headers = { 'content-type': 'application/json' };
    headers['x-telegram-init-data'] = initData ?? signInitData({ id: user, username: `u${user}` }, '1:TEST', Math.floor(now.getTime() / 1000));
    return fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  };
  return { app, call, port };
}

test('API HTTP: auth, iscrizione, rosa, classifica, admin', async () => {
  const { app, call, port } = await boot();
  try {
    assert.equal((await call('/api/state', { initData: 'x=1' })).status, 401); // firma assente/non valida
    assert.equal((await call('/api/state', { initData: signInitData({ id: 1 }, 'altro:token', Math.floor(Date.now() / 1000)) })).status, 401);

    let r = await call('/api/state', { user: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.user, null);
    assert.equal(r.body.window.open, true);
    assert.equal((await call('/api/roster', { user: 1, method: 'PUT', body: { playerIds: [] } })).status, 403); // non iscritto

    r = await call('/api/players?mode=captain', { user: 1 });
    assert.equal(r.body.players[0].pos, 201);
    assert.equal(r.body.players.at(-1).pos, 900);

    assert.equal((await call('/api/register', { user: 1, method: 'POST', body: { captainId: 'p10' } })).status, 422);
    r = await call('/api/register', { user: 1, method: 'POST', body: { captainId: 'p450' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.teamName, 'u1'); // RL-24
    assert.equal(r.body.captain.id, 'p450');

    r = await call('/api/players?mode=roster', { user: 1 });
    assert.equal(r.status, 200);
    const [t1, t2] = r.body.tournaments;
    const pick = (t, i) => t.participants.filter((p) => !['p450', 'p451'].includes(p.playerId))[i].playerId;
    r = await call('/api/roster', { user: 1, method: 'PUT', body: { playerIds: [pick(t1, 0), pick(t2, 0)] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.roster.players.length, 2);
    // RT-21: ogni utente scrive solo la propria rosa (nessun parametro userId accettato)
    await call('/api/register', { user: 2, method: 'POST', body: { captainId: 'p451' } });
    await call('/api/roster', { user: 2, method: 'PUT', body: { playerIds: [pick(t1, 1)], userId: 1 } });
    assert.deepEqual((await call('/api/state', { user: 1 })).body.roster.playerIds, [pick(t1, 0), pick(t2, 0)]);
    assert.equal((await call('/api/roster', { user: 1, method: 'PUT', body: { playerIds: [pick(t1, 0), pick(t1, 1)] } })).status, 422); // due dello stesso torneo

    r = await call('/api/league', { user: 1 });
    assert.ok(r.body.rows.length >= 10);
    assert.equal(r.body.rows[0].position, 1);
    r = await call('/api/tournaments/completed', { user: 1 });
    assert.ok(r.body.weeks.length >= 1);
    r = await call('/api/tournaments/in-progress', { user: 1 });
    assert.equal(r.body.tournaments.length, 2);

    assert.equal((await call('/api/admin/status', { user: 1 })).status, 403); // non admin
    r = await call('/api/admin/status', { user: 777 });
    assert.equal(r.status, 200);
    assert.ok(r.body.quota.used > 0);
    assert.equal((await call('/api/admin/recompute', { user: 777, method: 'POST' })).status, 200);

    const stat = await fetch(`http://127.0.0.1:${port}/shared/rules.js`);
    assert.equal(stat.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/shared/../package.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  } finally {
    await app.stop();
  }
});
