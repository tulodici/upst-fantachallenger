import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOutcome } from '../src/providers/outcome.js';
import { sportsApi365Provider } from '../src/providers/sportsapi365.js';
import { makeCore } from './helpers.js';
import { createMockProvider } from '../src/providers/mock.js';
import { romeToUtc } from '../src/time.js';

let n = 0;
const m = (day, hh, roundId, winnerId, loserId) => ({ id: `m${++n}`, date: `2026-11-${day}T${hh}:00:00.000Z`, roundId, winnerId, loserId });

// Tabellone da 8: 4 quarti (round 3), 2 semifinali (4), finale (5); piu' una partita di qualificazione (round 1).
const bracket = () => [
  m('16', '10', 1, 'LL', 'Q9'), // il lucky loser perde in qualificazione
  m('17', '10', 3, 'A', 'B'), m('17', '12', 3, 'C', 'D'), m('17', '14', 3, 'LL', 'E'), m('17', '16', 3, 'F', 'G'),
  m('18', '10', 4, 'A', 'C'), m('18', '12', 4, 'LL', 'F'),
  m('19', '12', 5, 'LL', 'A'),
];

test('esito torneo: vincitore, finalista, semifinalisti (anche con lucky loser campione)', () => {
  const o = deriveOutcome(bracket());
  assert.equal(o.status, 'concluded');
  const r = Object.fromEntries(o.results.map((x) => [x.playerId, x.reached]));
  assert.deepEqual(r, { LL: 'winner', A: 'finalist', C: 'semifinalist', F: 'semifinalist' });
});

test('esito torneo: finale non ancora giocata -> non concluso', () => {
  const o = deriveOutcome(bracket().slice(0, -1));
  assert.equal(o.status, 'in_progress');
  assert.deepEqual(o.results, []);
});

test('esito torneo: una sola semifinale giocata -> non concluso (non scambia la semi per la finale)', () => {
  const o = deriveOutcome(bracket().slice(0, 6));
  assert.equal(o.status, 'in_progress');
});

test('esito torneo: walkover non registrato in semifinale -> anomalia, nessun punto assegnato', () => {
  const b = bracket().filter((x) => !(x.roundId === 4 && x.winnerId === 'LL')); // semifinale del vincitore mancante
  const o = deriveOutcome(b);
  assert.equal(o.status, 'in_progress');
  assert.ok(o.anomaly);
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
const env = (k) => { process.env.SPORTSAPI365_KEY = k; };

test('provider reale: ranking nella forma reale dell\'API', async () => {
  env('k');
  const row = (pos, id, name, c) => ({ id: 1000 + pos, date: '2026-11-16T00:00:00.000Z', point: 1, position: pos, player: { id, name, countryAcr: c, country: { name: 'x', acronym: c } }, rankingPoints: 1 });
  await withFetch((u, o) => {
    assert.equal(u.pathname, '/v1/tennis/atp/ranking/singles');
    assert.equal(o.headers['X-Gravitee-Api-Key'], 'k');
    return json({ data: [row(1, 24008, 'Alexander Zverev', 'GER'), row(2, 47275, 'Jannik Sinner', 'ITA')], hasNextPage: true });
  }, async () => {
    const r = await sportsApi365Provider.fetchRankingPage(1, fakeApi());
    assert.deepEqual(r.players[1], { id: '47275', name: 'Jannik Sinner', country: 'ITA', rank: 2 });
    assert.equal(r.hasMore, true);
  });
});

test('provider reale: paginazione ignorata dal server -> errore chiaro', async () => {
  env('k');
  await withFetch(() => json({ data: [{ position: 1, player: { id: 1, name: 'A', countryAcr: 'ITA' } }], hasNextPage: true }), async () => {
    await sportsApi365Provider.fetchRankingPage(1, fakeApi());
    await assert.rejects(sportsApi365Provider.fetchRankingPage(2, fakeApi()), /SPORTSAPI365_PAGE_PARAM/);
  });
});

test('provider reale: risultati filtrati sui soli Challenger della settimana', async () => {
  env('k');
  const match = (id, tour, date, r, w, l) => ({
    id: String(id), matchId: String(id), date: `2026-11-${date}T12:00:00.000Z`, roundId: r, player1Id: w, player2Id: l, match_winner: w, result: '6-3 6-4', result_type: 'completed',
    player1: { id: w, name: `P${w}`, countryAcr: 'ITA' }, player2: { id: l, name: `P${l}`, countryAcr: 'ESP' },
    tournament: { id: tour.id, name: tour.name, date: tour.date, countryAcr: 'CAN' },
  });
  const CH = { id: 22205, name: 'Drummondville Challenger', date: '2026-11-16T00:00:00.000Z' };
  const ATP = { id: 1, name: 'Paris Masters', date: '2026-11-16T00:00:00.000Z' };
  const NEXT = { id: 22300, name: 'Next Challenger', date: '2026-11-23T00:00:00.000Z' };
  const data = [
    match(1, CH, '16', 3, 1, 2), match(2, CH, '16', 3, 3, 4), match(3, CH, '17', 4, 1, 3), match(4, CH, '17', 3, 5, 6),
    match(5, CH, '18', 4, 5, 7), match(6, CH, '19', 5, 1, 5), match(7, ATP, '16', 3, 8, 9), match(8, NEXT, '23', 1, 10, 11),
  ];
  await withFetch((u) => {
    assert.equal(u.pathname, '/v1/tennis/atp/results/2026-11-16/2026-11-23');
    return json({ data, hasNextPage: false });
  }, async () => {
    const out = await sportsApi365Provider.fetchWeekResults('2026-11-16', [], fakeApi());
    assert.equal(out.length, 1); // niente ATP maggiore, niente torneo della settimana dopo
    assert.equal(out[0].tournamentId, '22205');
    assert.equal(out[0].status, 'concluded');
    const r = Object.fromEntries(out[0].results.map((x) => [x.playerId, x.reached]));
    assert.deepEqual(r, { 1: 'winner', 5: 'finalist', 3: 'semifinalist', 7: 'semifinalist' });
    assert.equal(out[0].results[0].name, 'P1'); // nome dal dato reale (per creare il giocatore se manca)
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
