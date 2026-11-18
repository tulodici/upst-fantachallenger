import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBracket, sportsApi365Provider, extractResults, drawParticipants, filterChallengers, weekOfStart } from '../src/providers/sportsapi365.js';
import { makeCore } from './helpers.js';
import { createMockProvider } from '../src/providers/mock.js';
import { romeToUtc } from '../src/time.js';

process.env.SPORTSAPI365_MIN_INTERVAL_MS = '0';
process.env.SPORTSAPI365_KEY = 'test-key';

const P = (id, name = `P${id}`) => ({ id, name, countryAcr: 'ITA' });
const M = (roundId, a, b, winnerId, result = '6-3 6-4') => ({ roundId, player1: P(a), player2: P(b), result, winnerId, tbd: false });
// tabellone da 8 (round 9 = quarti, 10 = semifinali, 12 = finale); vincitore 1, finalista 5, semifinalisti 3 e 7
const fullDraw = () => ({
  singles: [M(9, 1, 2, 1), M(9, 3, 4, 3), M(9, 5, 6, 5), M(9, 7, 8, 7), M(10, 1, 3, 1), M(10, 5, 7, 5), M(12, 1, 5, 1)],
  qualifying: [M(1, 20, 21, 20), M(1, 1, 99, 1)],
});

function fakeApi() {
  const calls = [];
  return { calls, request: async (label, fn) => { calls.push(label); return fn(); } };
}
const withFetch = async (handler, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => handler(new URL(url), opts);
  try { await fn(); } finally { globalThis.fetch = real; }
};
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('esito dal tabellone: vincitore, finalista, semifinalisti', () => {
  const o = extractResults(fullDraw());
  assert.equal(o.status, 'concluded');
  assert.deepEqual(Object.fromEntries(o.results.map((x) => [x.playerId, x.reached])), { 1: 'winner', 5: 'finalist', 3: 'semifinalist', 7: 'semifinalist' });
});

test('esito dal tabellone: finale non giocata o senza vincitore -> non concluso', () => {
  const d = fullDraw();
  d.singles[6] = { ...d.singles[6], result: null, winnerId: null };
  assert.equal(extractResults(d).status, 'in_progress');
  const e = fullDraw();
  e.singles = e.singles.slice(0, 6); // nessuna finale
  assert.equal(extractResults(e).status, 'in_progress');
  const t = fullDraw();
  t.singles[6] = { ...t.singles[6], player2: P('TBA'), tbd: true }; // segnaposto "TBA"
  t.singles[6].player2.name = 'TBA';
  assert.equal(extractResults(t).status, 'in_progress');
});

test('esito dal tabellone: semifinalisti incoerenti -> anomalia, nessun punto', () => {
  const d = fullDraw();
  d.singles = d.singles.filter((m) => !(m.roundId === 10 && m.player1.id === 5)); // semifinale mancante
  const o = extractResults(d);
  assert.equal(o.status, 'in_progress');
  assert.ok(o.anomaly);
});

test('walkover/ritiro in semifinale conta come risultato (RL-17)', () => {
  const d = fullDraw();
  d.singles[4] = { ...d.singles[4], result: 'W/O' };
  assert.equal(extractResults(d).status, 'concluded');
});

test('giocatori del tabellone: main draw e qualificandi', () => {
  const p = drawParticipants(fullDraw());
  assert.equal(p.find((x) => x.id === '1').kind, 'main');
  assert.equal(p.find((x) => x.id === '20').kind, 'qualifier');
  assert.equal(p.find((x) => x.id === '99').kind, 'qualifier');
});

test('filtro Challenger: rankId 1 e "challenger" nel nome (esclude ITF)', () => {
  const r = filterChallengers([
    { id: 1, name: 'Drummondville Challenger', rankId: 1 }, { id: 2, name: 'M15 Antalya', rankId: 1 },
    { id: 3, name: 'Paris Masters', rankId: 5 }, { id: 4, name: 'Next Challenger', rank: { id: 1 } },
  ]);
  assert.deepEqual(r.map((t) => t.id), [1, 4]);
});

test('settimana ATP dalla data di inizio', () => {
  assert.equal(weekOfStart('2026-11-16'), '2026-11-16');
  assert.equal(weekOfStart('2026-11-18'), '2026-11-16');
  assert.equal(weekOfStart('2026-11-22'), '2026-11-23'); // partenza di domenica -> lunedi' dopo
  assert.equal(weekOfStart('boh'), null);
});

test('ranking: pageNo/pageSize, header e forma reale', async () => {
  const row = (pos, id, name, c) => ({ id: 1000 + pos, date: '2026-11-16T00:00:00.000Z', position: pos, player: { id, name, countryAcr: c, country: { name: 'x', acronym: c } } });
  await withFetch((u, o) => {
    assert.equal(u.pathname, '/v1/tennis/atp/ranking/singles');
    assert.equal(u.searchParams.get('pageNo'), '2');
    assert.equal(u.searchParams.get('pageSize'), '500');
    assert.equal(o.headers['X-Gravitee-Api-Key'], 'test-key');
    return json({ data: [row(1, 24008, 'Alexander Zverev', 'GER'), row(2, 47275, 'Jannik Sinner', 'ITA')], hasNextPage: true });
  }, async () => {
    const r = await sportsApi365Provider.fetchRankingPage(2, fakeApi());
    assert.deepEqual(r.players[1], { id: '47275', name: 'Jannik Sinner', country: 'ITA', rank: 2 });
    assert.equal(r.hasMore, true);
  });
});

test('tornei e tabelloni: 1 calendario + 1 chiamata per Challenger (budget)', async () => {
  const api = fakeApi();
  await withFetch((u) => {
    if (u.pathname === '/v1/tennis/calendar/active') {
      assert.equal(u.searchParams.get('startDate'), '2026-11-23');
      assert.equal(u.searchParams.get('endDate'), '2026-11-29');
      return json({ data: [
        { id: 22205, name: 'Drummondville Challenger', rankId: 1, startDate: '2026-11-23T00:00:00.000Z', countryAcr: 'CAN' },
        { id: 22207, name: 'Montevideo Challenger', rankId: 1, date: '2026-11-23T00:00:00.000Z', countryAcr: 'URU' },
        { id: 5, name: 'M15 Antalya', rankId: 1, startDate: '2026-11-23' },
        { id: 6, name: 'Vecchio Challenger', rankId: 1, startDate: '2026-11-16' }, // inizia la settimana prima
      ] });
    }
    assert.match(u.pathname, /^\/v1\/tennis\/tournament\/atp\/(Drummondville%20Challenger|Montevideo%20Challenger)\/2026\/draws$/);
    assert.equal(u.searchParams.get('fullBracket'), 'true');
    return json(fullDraw());
  }, async () => {
    const out = await sportsApi365Provider.fetchWeekDraws('2026-11-23', api);
    assert.equal(api.calls.length, 3);
    assert.deepEqual(out.map((t) => t.id), ['22205', '22207']);
    assert.equal(out[0].location, 'CAN');
    assert.ok(out[0].draw.length >= 8);
  });
});

test('risultati: usa i tornei noti dal DB senza ricontattare il calendario', async () => {
  const api = fakeApi();
  await withFetch((u) => { assert.match(u.pathname, /draws$/); return json(fullDraw()); }, async () => {
    const out = await sportsApi365Provider.fetchWeekResults('2026-11-16', [{ id: '22205', name: 'Drummondville Challenger' }], api);
    assert.equal(api.calls.length, 1);
    assert.equal(out[0].status, 'concluded');
    assert.equal(out[0].results.length, 4);
  });
});

test('errore 429: espone Retry-After al client', async () => {
  await withFetch(() => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }), async () => {
    await assert.rejects(sportsApi365Provider.fetchRankingPage(1, fakeApi()), (e) => e.status === 429 && e.retryAfterMs === 7000);
  });
});

test('passaggio da dati finti a dati reali: elimina i dati demo, mai il contrario', async () => {
  const h = await makeCore({ provider: createMockProvider() });
  h.at('2026-11-16', 12, 30);
  await h.core.runJob('ranking', '2026-11-16');
  await h.core.register({ telegramId: '1', teamName: 'Prova', captainId: 'p300' });
  assert.deepEqual(await h.core.reconcileProvider(), { purged: false }); // mock su mock: ok, scrive il marcatore
  // ora il provider diventa reale
  const real = { name: 'sportsapi365', fetchRankingPage: async () => ({ players: [], hasMore: false }), fetchWeekDraws: async () => [], fetchWeekResults: async () => [] };
  const { createCore } = await import('../src/core.js');
  const core2 = createCore({ db: h.db, provider: real, api: h.api, bot: { sendMessage: async () => true, notifyAdmins: async () => {} }, clock: () => romeToUtc('2026-11-18', 15), config: {} });
  assert.deepEqual(await core2.reconcileProvider(), { purged: true });
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM players')).n, 0);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM users')).n, 0);
  assert.ok((await h.db.get('SELECT COUNT(*) AS n FROM api_calls')).n > 0); // la quota non si cancella
  // ritorno a mock con dati reali in archivio: non cancella nulla
  await h.db.run(`INSERT INTO players (id, name) VALUES ('777', 'Reale')`);
  const core3 = createCore({ db: h.db, provider: createMockProvider(), api: h.api, bot: { sendMessage: async () => true, notifyAdmins: async () => {} }, clock: () => romeToUtc('2026-11-18', 15), config: {} });
  const w = console.warn; console.warn = () => {};
  const r = await core3.reconcileProvider(); console.warn = w;
  assert.equal(r.warning, true);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM players')).n, 1);
});

test('pulizia dati finti anche se il marcatore dice "reale" (vecchio container che rigenera dati demo)', async () => {
  const h = await makeCore({ provider: createMockProvider() });
  h.at('2026-11-16', 12, 30);
  await h.core.runJob('ranking', '2026-11-16');
  await h.db.run(`INSERT INTO meta (k, v) VALUES ('data_provider', 'sportsapi365')`); // marcatore gia' passato a "reale"
  const real = { name: 'sportsapi365', fetchRankingPage: async () => ({ players: [], hasMore: false }), fetchWeekDraws: async () => [], fetchWeekResults: async () => [] };
  const { createCore } = await import('../src/core.js');
  const core2 = createCore({ db: h.db, provider: real, api: h.api, bot: { sendMessage: async () => true, notifyAdmins: async () => {} }, clock: () => romeToUtc('2026-11-18', 15), config: {} });
  assert.deepEqual(await core2.reconcileProvider(), { purged: true });
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM players')).n, 0);
  assert.deepEqual(await core2.reconcileProvider(), { purged: false }); // seconda volta: niente da pulire
});

test('struttura del tabellone: turni ordinati, etichette, vincitori e giocatori da definire', () => {
  const d = fullDraw();
  d.singles[6] = { roundId: 12, player1: P(1), player2: { id: null, name: 'TBA' }, result: null, tbd: true };
  const b = buildBracket(d);
  assert.deepEqual(b.map((r) => [r.label, r.matches.length]), [['Quarti di finale', 4], ['Semifinali', 2], ['Finale', 1]]);
  assert.equal(b[0].matches[0].winnerId, '1');
  assert.equal(b[0].matches[0].score, '6-3 6-4');
  assert.equal(b[2].matches[0].p2.name, null);
  assert.equal(b[2].matches[0].winnerId, null);
});

test('import dei draw salva il tabellone e lo espone tra i tornei in corso', async () => {
  const provider = {
    ...createMockProvider(),
    fetchWeekDraws: async (weekStart) => [{ id: 't1', name: 'Challenger Test', weekStart, status: 'scheduled', location: 'ITA', draw: drawParticipants(fullDraw()), bracket: buildBracket(fullDraw()) }],
  };
  const { core, at } = await makeCore({ provider });
  at('2026-11-23', 10);
  await core.importDraws('2026-11-23');
  const r = await core.inProgressTournaments();
  const t = r.tournaments.find((x) => x.id === 't1');
  assert.equal(t.bracket.length, 3);
  assert.equal(t.bracket[2].label, 'Finale');
});
