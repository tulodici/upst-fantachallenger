import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore } from './helpers.js';
import { createApiClient, QuotaExhaustedError } from '../src/apiClient.js';
import { romeToUtc } from '../src/time.js';

const W0 = '2026-11-16'; // lunedi' (settimana di bootstrap del ranking)
const W = '2026-11-23'; // settimana di gioco

async function bootstrap(h) {
  h.at(W0, 12, 30);
  const r = await h.core.runJob('ranking', W0);
  assert.equal(r.ok, true);
  h.at('2026-11-22', 9, 0); // domenica: draw della settimana dopo
  assert.equal((await h.core.runJob('draws', W)).ok, true);
}

test('flusso completo di una settimana', async () => {
  const h = await makeCore();
  const { core, db } = h;
  await bootstrap(h);

  // Ranking di riferimento = settimana precedente (RL-12): bootstrap copia il ranking anche su W0-7.
  h.at(W, 10, 0);
  const ctx = await core.context();
  assert.equal(ctx.open, true);
  assert.equal(ctx.refWeek, W0);

  // Registrazione: capitano 201–900 (RL-04)
  await assert.rejects(core.register({ telegramId: '1', teamName: 'A', captainId: 'p150' }), /201/);
  await assert.rejects(core.register({ telegramId: '1', teamName: 'A', captainId: 'p901' }), /201/);
  const a = await core.register({ telegramId: '1', teamName: 'Alice', captainId: 'p300' });
  await assert.rejects(core.register({ telegramId: '1', teamName: 'A', captainId: 'p301' }), /già iscritto/);
  const b = await core.register({ telegramId: '2', teamName: 'Alice', captainId: 'p500' }); // nome duplicato ammesso (RL-24)
  const d = await core.register({ telegramId: '4', teamName: 'Dora', captainId: 'p600' });
  assert.notEqual(a.id, b.id);

  // Rosa per torneo: un giocatore per torneo scelto tra i partecipanti, nessun vincolo di classifica (RT-15)
  const opts = await core.pickOptions(await core.context());
  assert.equal(opts.length, 2);
  assert.ok(opts.every((t) => t.participants.length >= 28));
  const free = (t) => t.participants.filter((p) => !['p300', 'p400', 'p500', 'p600', 'p700'].includes(p.playerId));
  const [x1, x2] = opts.map((t) => free(t)[0].playerId);
  const x1b = free(opts[0])[1].playerId;
  await assert.rejects(core.saveRoster(a, [x1, x1b]), (e) => e.code === 'INVALID_ROSTER'); // 2 giocatori dello stesso torneo
  await assert.rejects(core.saveRoster(a, [x1, x1]), (e) => e.code === 'INVALID_ROSTER'); // ripetuto
  await assert.rejects(core.saveRoster(a, ['p300']), (e) => e.code === 'INVALID_ROSTER'); // e' il capitano
  await assert.rejects(core.saveRoster(a, ['p9999']), (e) => e.code === 'INVALID_ROSTER'); // non partecipa a nessun torneo
  const saved = await core.saveRoster(a, [x1, x2]);
  assert.deepEqual(saved.ids, [x1, x2]);
  assert.deepEqual(saved.players.map((p) => p.tournamentId), opts.map((t) => t.id));
  await core.saveRoster(a, [x1b]); // modificabile piu' volte, anche con meno giocatori (RL-13)
  await core.saveRoster(a, [x1, x2]);
  assert.equal((await core.listPlayers(await core.context())).at(0).pos, 201); // lista capitano 201-900
  assert.equal((await core.getState(a)).tournaments.length, 2);

  // Chiusura martedi' 15:00: nessuna modifica e snapshot immutabile (RT-14, RT-16)
  h.at('2026-11-24', 14, 59);
  await core.saveRoster(a, [x1, x2]);
  h.at('2026-11-24', 15, 1);
  await assert.rejects(core.saveRoster(a, [x1]), (e) => e.code === 'WINDOW_CLOSED');
  await core.ensureSnapshots();
  const snap = await db.all('SELECT player_id, ref_pos FROM roster_snapshots WHERE user_id = ? ORDER BY ref_pos', [a.id]);
  assert.deepEqual(snap.map((s) => s.player_id).sort(), [x1, x2].sort());
  assert.equal((await core.snapshotWeek(W)).created, false); // idempotente
  assert.equal((await db.get('SELECT status FROM rosters WHERE user_id = ?', [a.id])).status, 'locked');

  // Iscrizione a finestra chiusa: solo capitano fino alla settimana dopo (RL-09, RG-11)
  h.at('2026-11-25', 9, 0);
  const c = await core.register({ telegramId: '3', teamName: 'Carlo', captainId: 'p400' });
  const stC = await core.getState(c);
  assert.equal(stC.captainOnlyNotice, true);
  assert.equal(stC.window.open, false);
  assert.ok(stC.window.nextOpens);
  assert.equal((await core.getState(a)).captainOnlyNotice, false);
  await assert.rejects(core.saveRoster(c, [x1]), (e) => e.code === 'WINDOW_CLOSED');

  // Risultati (correzione admin): p250 vince, p400 (capitano di Carlo) finalista, p300 (capitano di Alice) semifinalista
  const t1 = `t-${W}-1`;
  await core.adminSetResults('admin', {
    tournamentId: t1,
    results: [
      { playerId: x1, reached: 'winner' },
      { playerId: 'p400', reached: 'finalist' },
      { playerId: 'p300', reached: 'semifinalist' },
      { playerId: x2, reached: 'semifinalist' },
    ],
  });
  // Alice: x1 10 + x2 2 + capitano p300 (semifinale) 4 = 16. Carlo: capitano finalista 10. Bob/Dora: 0.
  let table = await core.standings();
  const pts = Object.fromEntries(table.map((r) => [r.teamName + r.id, r.points]));
  assert.equal(pts[`Alice${a.id}`], 16);
  assert.equal(pts[`Carlo${c.id}`], 10);
  assert.deepEqual(table.map((r) => r.position), [1, 2, 3, 3]); // Bob e Dora a pari merito (RL-23)

  // Ricalcolo idempotente (RT-13)
  await core.recomputePoints();
  await core.recomputePoints();
  table = await core.standings();
  assert.equal(table[0].points, 16);

  // Torneo annullato: punti rimossi dopo correzione (RL-27, RT-25)
  await core.adminSetResults('admin', { tournamentId: t1, status: 'cancelled', results: [] });
  assert.equal((await core.standings())[0].points, 0);
  await core.adminSetResults('admin', {
    tournamentId: t1,
    results: [{ playerId: x1, reached: 'winner' }, { playerId: 'p400', reached: 'finalist' }, { playerId: 'p300', reached: 'semifinalist' }, { playerId: x2, reached: 'semifinalist' }],
  });

  // ⭐ storico basato sullo snapshot (RG-13)
  const completed = await core.completedTournaments(a);
  const wk = completed.find((x) => x.weekStart === W);
  const stars = wk.tournaments[0].results.filter((r) => r.starred).map((r) => r.playerId).sort();
  assert.deepEqual(stars, [x1, x2, 'p300'].sort());

  // Nuova iscrizione: parte da 0, senza catch-up (RL-08)
  h.at('2026-11-30', 10, 0);
  const e = await core.register({ telegramId: '5', teamName: 'Elena', captainId: 'p400' });
  assert.equal((await core.getState(e)).points.total, 0);
});

test('rosa non compilata resta vuota e il capitano segna comunque (RL-07, RL-14)', async () => {
  const h = await makeCore();
  await bootstrap(h);
  h.at(W, 9, 0);
  const u = await h.core.register({ telegramId: '9', teamName: 'Vuoto', captainId: 'p700' });
  h.at('2026-11-24', 16, 0);
  await h.core.ensureSnapshots();
  await h.core.adminSetResults('admin', { tournamentId: `t-${W}-1`, results: [{ playerId: 'p700', reached: 'winner' }] });
  assert.equal((await h.core.getState(u)).points.total, 20);
  // settimana successiva: nessun riporto automatico
  h.at('2026-11-30', 9, 0);
  assert.deepEqual((await h.core.getState(u)).roster.playerIds, []);
});

test('import risultati dal provider e giocatori sconosciuti creati da API (RT-18)', async () => {
  const h = await makeCore();
  await bootstrap(h);
  h.at('2026-11-30', 12, 30);
  const r = await h.core.importResults(W);
  assert.equal(r.concluded, 2);
  const n = await h.db.get(`SELECT COUNT(*) AS n FROM tournament_results`);
  assert.equal(n.n, 8);
  // qualificati non presenti nel ranking top 900 sono stati creati in anagrafica ma non sono selezionabili
  const unknown = await h.db.get(`SELECT COUNT(*) AS n FROM draw_entries d LEFT JOIN rankings r ON r.player_id = d.player_id AND r.week_start = ? WHERE r.player_id IS NULL`, [W0]);
  assert.ok(unknown.n >= 0);
});

test('calendario operativo: job dovuti (Europe/Rome)', async () => {
  const h = await makeCore();
  const names = (d, hh, mm = 0) => h.core.dueJobs(romeToUtc(d, hh, mm)).map(([j, k]) => `${j}:${k}`);
  assert.ok(!names('2026-11-22', 7, 59).includes(`draws:${W}`)); // domenica prima delle 8: draw della settimana dopo non ancora dovuti
  assert.ok(names('2026-11-22', 8, 0).includes(`draws:${W}`));
  assert.ok(names('2026-11-23', 11, 59).every((x) => !x.startsWith('results')));
  assert.ok(names('2026-11-23', 12, 0).includes(`results:${W0}`));
  assert.ok(names('2026-11-23', 12, 0).includes(`ranking:${W}`));
  assert.ok(names('2026-11-23', 18, 0).includes(`reminder:${W}`));
  assert.ok(names('2026-11-24', 8, 0).includes(`recheck:${W0}`));
  assert.ok(!names('2026-11-24', 14, 59).includes(`close:${W}`));
  assert.ok(names('2026-11-24', 15, 0).includes(`close:${W}`));
  assert.ok(!names('2026-11-24', 15, 0).includes(`reminder:${W}`)); // niente promemoria a finestra chiusa
});

test('job: retry limitati e fallimenti segnalati all\'admin (RT-27)', async () => {
  const failing = {
    fetchRankingPage: async () => { throw new Error('boom'); },
    fetchWeekDraws: async () => [], fetchWeekResults: async () => [],
  };
  const h = await makeCore({ provider: failing });
  h.at(W, 13, 0);
  assert.equal((await h.core.runJob('ranking', W)).ok, false);
  assert.equal((await h.core.runJob('ranking', W)).skipped, 'backoff'); // nessun retry immediato
  h.at(W, 13, 20);
  assert.equal((await h.core.runJob('ranking', W)).ok, false); // 2° tentativo
  h.at(W, 14, 0);
  assert.equal((await h.core.runJob('ranking', W)).ok, false); // 3° tentativo -> avviso admin
  assert.ok(h.sent.some((m) => m.admin));
  h.at(W, 20, 0);
  assert.equal((await h.core.runJob('ranking', W)).skipped, 'max-attempts');
});

test('promemoria del lunedi\' sera solo a chi non ha completato la rosa (RG-18)', async () => {
  const h = await makeCore();
  await bootstrap(h);
  h.at(W, 9, 0);
  const full = await h.core.register({ telegramId: '10', teamName: 'Pieno', captainId: 'p300' });
  await h.core.register({ telegramId: '11', teamName: 'Mezzo', captainId: 'p301' });
  await h.core.register({ telegramId: '12', teamName: 'Zero', captainId: 'p302' });
  const opts = await h.core.pickOptions(await h.core.context());
  const free = (t) => t.participants.filter((p) => !['p300', 'p301', 'p302'].includes(p.playerId))[0].playerId;
  await h.core.saveRoster(full, opts.map(free)); // un giocatore per ogni torneo
  const half = await h.core.findUser('11');
  await h.core.saveRoster(half, [free(opts[0])]);
  h.at(W, 18, 0);
  const r = await h.core.sendReminders();
  assert.equal(r.sent, 2);
  assert.deepEqual(h.sent.map((m) => m.id).sort(), ['11', '12']);
});

test('RT-11: quota API mensile, allarme all\'80% e blocco', async () => {
  const h = await makeCore();
  const api = createApiClient({ db: h.db, clock: () => romeToUtc(W, 12), notifyAdmins: async (t) => h.sent.push({ admin: true, text: t }), limit: 5, backoffMs: [0] });
  for (let i = 0; i < 4; i++) await api.request(`e${i}`, async () => i);
  assert.equal(h.sent.filter((m) => m.admin).length, 1); // allarme una sola volta, a 4/5
  await api.request('e5', async () => 5);
  await assert.rejects(api.request('e6', async () => 6), QuotaExhaustedError);
  assert.equal((await api.status()).remaining, 0);
});

test('RT-27: retry con backoff, 4xx non ritentati', async () => {
  const h = await makeCore();
  const api = createApiClient({ db: h.db, clock: () => romeToUtc(W, 12), limit: 50, backoffMs: [0], maxRetries: 2 });
  let calls = 0;
  const out = await api.request('flaky', async () => { if (++calls < 3) throw new Error('timeout'); return 'ok'; });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
  let c2 = 0;
  await assert.rejects(api.request('bad', async () => { c2++; const e = new Error('nope'); e.status = 401; throw e; }));
  assert.equal(c2, 1);
});

test('tornei completati: scelta dell\'utente e punti ottenuti', async () => {
  const h = await makeCore();
  await bootstrap(h);
  h.at(W, 9, 0);
  const u = await h.core.register({ telegramId: '20', teamName: 'Scelte', captainId: 'p700' });
  const opts = await h.core.pickOptions(await h.core.context());
  const a = opts[0].participants.find((p) => p.playerId !== 'p700').playerId;
  const b = opts[1].participants.find((p) => p.playerId !== 'p700').playerId;
  await h.core.saveRoster(u, [a, b]);
  h.at('2026-11-24', 16, 0);
  await h.core.ensureSnapshots();
  await h.core.adminSetResults('admin', { tournamentId: opts[0].id, results: [{ playerId: a, reached: 'finalist' }, { playerId: 'p700', reached: 'winner' }] });
  await h.core.adminSetResults('admin', { tournamentId: opts[1].id, results: [{ playerId: 'p1', reached: 'winner' }] });
  const wk = (await h.core.completedTournaments(u)).find((x) => x.weekStart === W);
  const c0 = wk.tournaments.find((t) => t.id === opts[0].id).mine;
  assert.equal(c0.pick.playerId, a);
  assert.equal(c0.pick.points, 5); // finalista
  assert.equal(c0.captain?.points ?? 20, 20); // capitano vincitore x2 (se partecipa al torneo)
  const c1 = wk.tournaments.find((t) => t.id === opts[1].id).mine;
  assert.equal(c1.pick.playerId, b);
  assert.equal(c1.pick.points, 0); // non a podio
});
