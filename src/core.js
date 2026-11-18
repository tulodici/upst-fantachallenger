import {
  POOL_SIZE, isCaptainEligible, validatePicks, pointsFor, withPositions,
} from '../shared/rules.js';
import { addDays, dayOfWeekOf, mondayOf, romeParts, romeToUtc, windowOf, windowState } from './time.js';
import { QuotaExhaustedError } from './apiClient.js';
import { buildXlsx, colName, STYLE } from './xlsx.js';

export class AppError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const MAX_JOB_ATTEMPTS = 3;

export function createCore({ db, provider, api, bot, clock, config = {} }) {
  const allowCaptainInRoster = Boolean(config.allowCaptainInRoster);
  const iso = () => clock().toISOString();

  const audit = (actor, action, details) =>
    db.run('INSERT INTO audit_log (created_at, actor, action, details) VALUES (?, ?, ?, ?)', [
      iso(), String(actor), action, details === undefined ? null : JSON.stringify(details),
    ]);

  // ---------------------------------------------------------------- contesto temporale / ranking

  async function context(now = clock()) {
    const w = { ...windowState(now) };
    // Solo per collaudo (TEST_WINDOW_OPEN=1): finestra sempre aperta sulla settimana corrente. Da togliere prima del lancio.
    if (config.testWindowOpen) { w.open = true; w.closes = new Date(now.getTime() + 3600e3); }
    const ref = await db.get('SELECT MAX(week_start) AS w FROM rankings WHERE week_start < ?', [w.weekStart]);
    const refWeek = ref?.w ?? null;
    const nextOpens = now < w.opens ? w.opens : w.open ? null : windowOf(addDays(w.weekStart, 7)).opens;
    return { now, weekStart: w.weekStart, open: w.open, opens: w.opens, closes: w.closes, refWeek, nextOpens };
  }

  const windowPayload = (ctx) => ({
    open: ctx.open,
    opens: ctx.opens.toISOString(),
    closes: ctx.closes.toISOString(),
    nextOpens: ctx.nextOpens?.toISOString() ?? null,
  });

  /** RL-12: posizione di riferimento = ranking della settimana precedente. */
  async function refPositions(ctx, ids) {
    const map = new Map();
    if (!ctx.refWeek || ids.length === 0) return map;
    const rows = await db.all(
      `SELECT player_id, pos FROM rankings WHERE week_start = ? AND player_id IN (${ids.map(() => '?').join(',')})`,
      [ctx.refWeek, ...ids],
    );
    for (const r of rows) map.set(r.player_id, r.pos);
    return map;
  }

  // ---------------------------------------------------------------- lista giocatori (My Team)

  /** Lista del solo capitano (201-900). La rosa settimanale si sceglie dai partecipanti ai tornei: vedi pickOptions. */
  async function listPlayers(ctx) {
    if (!ctx.refWeek) return [];
    return db.all(
      `SELECT p.id, p.name, p.country, r.pos
         FROM rankings r JOIN players p ON p.id = r.player_id
        WHERE r.week_start = ? AND r.pos BETWEEN ? AND ?
        ORDER BY r.pos`,
      [ctx.refWeek, 201, POOL_SIZE],
    );
  }

  /** Tornei della settimana di gioco con i partecipanti selezionabili (1 scelta per torneo). */
  async function pickOptions(ctx) {
    const ts = await tournamentsWithPeople(`week_start = ? AND status <> 'cancelled'`, [ctx.weekStart]);
    await attachParticipants(ts);
    return ts.map((t) => ({ id: t.id, name: t.name, location: t.location, participants: t.participants }));
  }

  // ---------------------------------------------------------------- utenti

  async function findUser(telegramId) {
    return db.get('SELECT * FROM users WHERE telegram_id = ?', [String(telegramId)]);
  }

  async function touchTeamName(user, teamName) {
    if (user && user.team_name !== teamName) {
      await db.run('UPDATE users SET team_name = ? WHERE id = ?', [teamName, user.id]);
      user.team_name = teamName;
    }
  }

  async function register({ telegramId, teamName, captainId }) {
    if (await findUser(telegramId)) throw new AppError('ALREADY_REGISTERED', 'Sei già iscritto', 409);
    const ctx = await context();
    const pos = (await refPositions(ctx, [captainId])).get(captainId);
    if (!isCaptainEligible(pos)) {
      throw new AppError('CAPTAIN_NOT_ELIGIBLE', 'Il capitano deve essere tra la 201ª e la 900ª posizione del ranking', 422);
    }
    const now = clock();
    try {
      await db.run(
        'INSERT INTO users (telegram_id, team_name, captain_id, reg_week, registered_at) VALUES (?, ?, ?, ?, ?)',
        [String(telegramId), teamName, captainId, mondayOf(now), now.toISOString()],
      );
    } catch (e) {
      if (await findUser(telegramId)) throw new AppError('ALREADY_REGISTERED', 'Sei già iscritto', 409);
      throw e;
    }
    return findUser(telegramId);
  }

  // ---------------------------------------------------------------- rosa

  async function currentRoster(user, ctx) {
    const row = await db.get('SELECT * FROM rosters WHERE user_id = ? AND week_start = ?', [user.id, ctx.weekStart]);
    const ids = row ? JSON.parse(row.player_ids) : [];
    if (ids.length === 0) return { ids, players: [], status: row?.status ?? null };
    const options = await pickOptions(ctx);
    const where = new Map(); // playerId -> { tournament, participant }
    for (const t of options) for (const p of t.participants) if (!where.has(p.playerId)) where.set(p.playerId, { t, p });
    const pos = await refPositions(ctx, ids);
    const known = await db.all(`SELECT id, name, country FROM players WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    const byId = new Map(known.map((x) => [x.id, x]));
    const players = ids.map((id) => {
      const w = where.get(id);
      const base = byId.get(id) ?? { id, name: w?.p.name ?? `Giocatore ${id}`, country: w?.p.country ?? null };
      return { ...base, pos: pos.get(id) ?? null, tournamentId: w?.t.id ?? null, tournament: w?.t.name ?? null, seed: w?.p.seed ?? null, entry: w?.p.entry ?? null };
    });
    return { ids, players, status: row.status };
  }

  async function saveRoster(user, playerIds) {
    await ensureSnapshots(); // chiude eventuali finestre scadute prima di ogni scrittura
    const ctx = await context();
    if (!Array.isArray(playerIds) || playerIds.some((x) => typeof x !== 'string')) {
      throw new AppError('BAD_REQUEST', 'Elenco giocatori non valido');
    }
    if (!ctx.open) throw new AppError('WINDOW_CLOSED', 'La finestra di selezione è chiusa', 423, { window: windowPayload(ctx) });
    // Un solo giocatore per torneo, scelto tra i partecipanti (nessun vincolo di classifica sui giocatori della rosa).
    const options = await pickOptions(ctx);
    const v = validatePicks(playerIds, {
      tournaments: options.map((t) => ({ id: t.id, playerIds: t.participants.map((p) => p.playerId) })),
      captainId: user.captain_id, allowCaptainInRoster,
    });
    if (!v.ok) throw new AppError('INVALID_ROSTER', v.errors[0].message, 422, { errors: v.errors });
    // RT-16: controllo del timestamp lato server immediatamente prima della scrittura.
    if (clock() >= ctx.closes) throw new AppError('WINDOW_CLOSED', 'La finestra di selezione è chiusa', 423);
    await db.run(
      `INSERT INTO rosters (user_id, week_start, player_ids, status, updated_at) VALUES (?, ?, ?, 'draft', ?)
       ON CONFLICT (user_id, week_start) DO UPDATE SET player_ids = excluded.player_ids, updated_at = excluded.updated_at
       WHERE rosters.status = 'draft'`,
      [user.id, ctx.weekStart, JSON.stringify(playerIds), iso()],
    );
    return currentRoster(user, ctx);
  }

  /** RT-14: snapshot immutabile alla chiusura. Idempotente. */
  async function snapshotWeek(weekStart, { force = false } = {}) {
    const { closes } = windowOf(weekStart);
    if (!force && clock() < closes) return { created: false, reason: 'finestra ancora aperta' };
    const exists = await db.get('SELECT week_start FROM snapshot_weeks WHERE week_start = ?', [weekStart]);
    if (exists) return { created: false, reason: 'già presente' };
    const refRow = await db.get('SELECT MAX(week_start) AS w FROM rankings WHERE week_start < ?', [weekStart]);
    let count = 0;
    await db.tx(async (t) => {
      const rosters = await t.all(`SELECT * FROM rosters WHERE week_start = ?`, [weekStart]);
      for (const r of rosters) {
        const ids = JSON.parse(r.player_ids);
        const pos = new Map();
        if (refRow?.w && ids.length) {
          const rows = await t.all(
            `SELECT player_id, pos FROM rankings WHERE week_start = ? AND player_id IN (${ids.map(() => '?').join(',')})`,
            [refRow.w, ...ids],
          );
          rows.forEach((x) => pos.set(x.player_id, x.pos));
        }
        for (const id of ids) {
          await t.run('INSERT INTO roster_snapshots (user_id, week_start, player_id, ref_pos) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
            [r.user_id, weekStart, id, pos.get(id) ?? null]);
          count++;
        }
        await t.run(`UPDATE rosters SET status = 'locked' WHERE user_id = ? AND week_start = ?`, [r.user_id, weekStart]);
      }
      await t.run('INSERT INTO snapshot_weeks (week_start, created_at) VALUES (?, ?)', [weekStart, iso()]);
    });
    return { created: true, entries: count };
  }

  /** Chiude (con snapshot) la settimana corrente e quelle passate rimaste aperte, se la finestra e' scaduta. */
  async function ensureSnapshots() {
    const now = clock();
    const w = windowState(now);
    const weeks = new Set((await db.all(`SELECT DISTINCT week_start FROM rosters WHERE status = 'draft' AND week_start < ?`, [w.weekStart])).map((r) => r.week_start));
    if (now >= w.closes) weeks.add(w.weekStart);
    for (const wk of weeks) {
      const r = await snapshotWeek(wk);
      if (r.created) await recomputePoints();
    }
  }

  // ---------------------------------------------------------------- punti (RT-13: ricalcolo completo, idempotente)

  async function recomputePoints() {
    const results = await db.all(
      `SELECT tr.tournament_id, tr.player_id, tr.reached, t.week_start
         FROM tournament_results tr JOIN tournaments t ON t.id = tr.tournament_id
        WHERE t.status = 'concluded'`,
    );
    const users = await db.all('SELECT id, captain_id, reg_week FROM users');
    const snaps = await db.all('SELECT user_id, week_start, player_id FROM roster_snapshots');
    const captainUsers = new Map();
    for (const u of users) {
      if (!captainUsers.has(u.captain_id)) captainUsers.set(u.captain_id, []);
      captainUsers.get(u.captain_id).push(u);
    }
    const userById = new Map(users.map((u) => [u.id, u]));
    const snapUsers = new Map();
    for (const s of snaps) {
      const k = `${s.week_start}|${s.player_id}`;
      if (!snapUsers.has(k)) snapUsers.set(k, []);
      snapUsers.get(k).push(s.user_id);
    }
    const rows = [];
    for (const r of results) {
      const captainSet = new Set();
      // RL-07/RL-20: il capitano segna sempre (anche con rosa vuota), doppio; vale dalla settimana di iscrizione (RL-08).
      for (const u of captainUsers.get(r.player_id) ?? []) {
        if (u.reg_week <= r.week_start) {
          captainSet.add(u.id);
          rows.push([u.id, r.week_start, r.tournament_id, r.player_id, pointsFor(r.reached, true), 1]);
        }
      }
      for (const uid of snapUsers.get(`${r.week_start}|${r.player_id}`) ?? []) {
        if (captainSet.has(uid) || !userById.has(uid)) continue;
        rows.push([uid, r.week_start, r.tournament_id, r.player_id, pointsFor(r.reached, false), 0]);
      }
    }
    await db.tx(async (t) => {
      await t.run('DELETE FROM points');
      for (const row of rows) {
        if (row[4] > 0) {
          await t.run('INSERT INTO points (user_id, week_start, tournament_id, player_id, points, is_captain) VALUES (?, ?, ?, ?, ?, ?)', row);
        }
      }
    });
    return { rows: rows.length };
  }

  // ---------------------------------------------------------------- classifica e viste

  async function standings() {
    const rows = await db.all(
      `SELECT u.id, u.team_name AS "teamName", c.name AS "captainName", COALESCE(SUM(p.points), 0) AS points
         FROM users u LEFT JOIN points p ON p.user_id = u.id LEFT JOIN players c ON c.id = u.captain_id
        GROUP BY u.id, u.team_name, c.name
        ORDER BY points DESC, u.team_name ASC, u.id ASC`,
    );
    return withPositions(rows);
  }

  /**
   * Report admin (comando /scelte): cartella XLSX con la stessa struttura del foglio di gioco UPST.
   *  MAIN            una colonna per torneo (raggruppati per settimana), sotto l'esito (SF, SF, F, W) e una riga per squadra
   *                  con totale, capitano e giocatore scelto in ogni torneo.
   *  RANKING         classifica con pari merito.
   *  Detailed_Scores punti di ogni squadra in ogni torneo (scelta + capitano x2), totale e posizione.
   */
  async function adminPicksReport() {
    const users = await db.all('SELECT id, telegram_id, team_name, captain_id, reg_week FROM users');
    users.sort((x, y) => x.team_name.localeCompare(y.team_name, 'it', { sensitivity: 'base' }) || x.id - y.id);
    const rosters = await db.all('SELECT user_id, week_start, player_ids FROM rosters');
    const tournaments = (await db.all(`SELECT id, name, week_start, status FROM tournaments WHERE status <> 'cancelled'`))
      .sort((x, y) => x.week_start.localeCompare(y.week_start) || x.name.localeCompare(y.name));
    const draws = await db.all('SELECT tournament_id, player_id FROM draw_entries');
    const results = await db.all('SELECT tournament_id, player_id, reached FROM tournament_results');
    const players = new Map((await db.all('SELECT id, name FROM players')).map((q) => [q.id, q.name]));
    const nameOf = (id) => players.get(id) ?? `Giocatore ${id}`;
    const inDraw = new Set(draws.map((d) => `${d.tournament_id}|${d.player_id}`));
    const resultOf = new Map(results.map((r) => [`${r.tournament_id}|${r.player_id}`, r.reached]));
    const byTournament = (id, reached) => results.filter((r) => r.tournament_id === id && r.reached === reached).map((r) => nameOf(r.player_id));

    const isoWeek = (d) => {
      const t = new Date(`${d}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
      const y1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
      return 1 + Math.round(((t - y1) / 86400000 - 3 + ((y1.getUTCDay() + 6) % 7)) / 7);
    };
    const short = (n) => n.replace(/\s*\bchallenger\b\s*/i, ' ').replace(/\s+/g, ' ').trim() || n;
    // torneo della settimana in cui il giocatore ha un risultato o partecipa
    const locate = (week, playerId) => {
      const ts = tournaments.filter((t) => t.week_start === week);
      return ts.find((t) => resultOf.has(`${t.id}|${playerId}`)) ?? ts.find((t) => inDraw.has(`${t.id}|${playerId}`)) ?? null;
    };

    const FIRST = 3; // colonne A, B, C; i tornei partono da D
    const colOf = new Map(tournaments.map((t, i) => [t.id, FIRST + i]));
    const lastCol = FIRST + Math.max(tournaments.length, 1) - 1;
    const lastLetter = colName(lastCol);
    const START = 8; // prima riga squadre (1-based), come nel foglio di riferimento

    // Punti e scelte per squadra
    const table = users.map((u) => {
      const picks = new Map(); // tournamentId -> playerId
      const pts = new Map(); // tournamentId -> punti
      for (const r of rosters.filter((x) => x.user_id === u.id)) {
        for (const id of JSON.parse(r.player_ids)) {
          const t = locate(r.week_start, id);
          if (!t) continue;
          picks.set(t.id, id);
          const reached = resultOf.get(`${t.id}|${id}`);
          pts.set(t.id, (pts.get(t.id) ?? 0) + (reached ? pointsFor(reached, false) : 0));
        }
      }
      for (const t of tournaments) { // capitano: dal suo settimana d'iscrizione, anche senza rosa
        const reached = resultOf.get(`${t.id}|${u.captain_id}`);
        if (reached && u.reg_week <= t.week_start) pts.set(t.id, (pts.get(t.id) ?? 0) + pointsFor(reached, true));
      }
      const total = [...pts.values()].reduce((n, x) => n + x, 0);
      return { u, picks, pts, total };
    });
    const ranked = [...table].sort((x, y) => y.total - x.total);
    const posOf = new Map();
    ranked.forEach((x, i) => posOf.set(x.u.id, i > 0 && ranked[i - 1].total === x.total ? posOf.get(ranked[i - 1].u.id) : i + 1));

    const head = (ref) => [
      ['UPST', null, null, ...tournaments.map((t) => ({ v: `WEEK ${isoWeek(t.week_start)}`, s: STYLE.header }))],
      ['FantaChallenger', null, ref, ...tournaments.map((t) => ({ v: short(t.name), s: STYLE.tournament }))],
    ];
    const rowOfUser = (i) => START + i;

    // MAIN
    const main = head({ v: 'Capitano', s: STYLE.header });
    main[0][0] = { v: 'UPST', s: STYLE.bold };
    main[1][0] = { v: 'FantaChallenger', s: STYLE.bold };
    const legend = [['SF', 2, '- Un giocatore per torneo'], ['SF', 2, '- Non sostituibile: il capitano'], ['F', 5, '- Capitano dal 201° al 900° del ranking'], ['W', 10, '- Moltiplicatore punti x2']];
    const reachedRows = [['semifinalist', 0], ['semifinalist', 1], ['finalist', 0], ['winner', 0]];
    legend.forEach(([code, points, note], i) => {
      main.push([{ v: code, s: STYLE.center }, { v: points, s: STYLE.center }, note,
        ...tournaments.map((t) => { const who = byTournament(t.id, reachedRows[i][0])[reachedRows[i][1]]; return who ? { v: who, s: STYLE.result } : { v: '', s: STYLE.result }; })]);
    });
    main.push([]);
    table.forEach(({ u, picks }, i) => {
      const r = rowOfUser(i);
      main.push([
        { v: u.team_name, s: STYLE.bold },
        { v: table[i].total, f: `Detailed_Scores!B${r}`, s: STYLE.center },
        { v: nameOf(u.captain_id), s: STYLE.captain },
        ...tournaments.map((t) => ({ v: picks.has(t.id) ? nameOf(picks.get(t.id)) : '', s: STYLE.pick })),
      ]);
    });

    // Detailed_Scores
    const detailed = head({ v: 'Rank', s: STYLE.header });
    detailed.forEach((row, ri) => row.forEach((c, ci) => { if (ci >= FIRST) row[ci] = { v: c.v, f: `MAIN!${colName(ci)}${ri + 1}`, s: c.s }; }));
    for (let i = 0; i < 6; i++) detailed.push([]);
    detailed.length = START - 1; // righe 3-7 vuote
    table.forEach(({ u, pts, total }, i) => {
      const r = rowOfUser(i);
      detailed.push([
        { v: u.team_name, f: `MAIN!A${r}`, s: STYLE.bold },
        { v: total, f: `SUM(D${r}:${lastLetter}${r})`, s: STYLE.center },
        { v: posOf.get(u.id), f: `RANK(B${r},$B$${START}:$B$${START + users.length - 1},FALSE)`, s: STYLE.center },
        ...tournaments.map((t) => ({ v: pts.has(t.id) ? pts.get(t.id) : '', s: STYLE.center })),
      ]);
    });

    // RANKING
    const ranking = [[{ v: 'RANKING', s: STYLE.bold }], [{ v: 'Pos.', s: STYLE.header }, { v: 'Squadra', s: STYLE.header }, { v: 'Capitano', s: STYLE.header }, { v: 'Punti', s: STYLE.header }]];
    for (const x of ranked) ranking.push([{ v: posOf.get(x.u.id), s: STYLE.center }, { v: x.u.team_name, s: STYLE.bold }, { v: nameOf(x.u.captain_id), s: STYLE.captain }, { v: x.total, s: STYLE.center }]);

    const widths = { 0: 24, 1: 8, 2: 30 };
    for (let i = FIRST; i <= lastCol; i++) widths[i] = 18;
    const xlsx = buildXlsx([
      { name: 'MAIN', rows: main, widths, freeze: { col: FIRST, row: START - 1 } },
      { name: 'RANKING', rows: ranking, widths: { 0: 7, 1: 26, 2: 28, 3: 9 }, freeze: { col: 0, row: 2 } },
      { name: 'Detailed_Scores', rows: detailed, widths: { ...widths, 2: 8 }, freeze: { col: FIRST, row: START - 1 } },
    ]);
    return { rows: users.length, tournaments: tournaments.length, xlsx };
  }

  async function myPoints(user) {
    const total = await db.get('SELECT COALESCE(SUM(points), 0) AS n FROM points WHERE user_id = ?', [user.id]);
    const history = await db.all(
      `SELECT week_start AS "weekStart", SUM(points) AS points FROM points WHERE user_id = ? GROUP BY week_start ORDER BY week_start DESC LIMIT 12`,
      [user.id],
    );
    return { total: total.n, history };
  }

  async function getState(user) {
    await ensureSnapshots();
    const ctx = await context();
    const base = { now: ctx.now.toISOString(), weekStart: ctx.weekStart, window: windowPayload(ctx), hasRanking: Boolean(ctx.refWeek) };
    if (!user) return { ...base, user: null };
    const cap = (await listPlayersByIds(ctx, [user.captain_id]))[0] ?? null;
    const roster = await currentRoster(user, ctx);
    const registeredAfterClose = new Date(user.registered_at) >= ctx.closes;
    return {
      ...base,
      user: { teamName: user.team_name, registeredAt: user.registered_at },
      captain: cap,
      roster: { playerIds: roster.ids, players: roster.players, editable: ctx.open },
      tournaments: (await db.all(`SELECT id, name, location FROM tournaments WHERE week_start = ? AND status <> 'cancelled' ORDER BY name`, [ctx.weekStart])),
      points: await myPoints(user),
      captainOnlyNotice: !ctx.open && registeredAfterClose, // RG-11
    };
  }

  async function listPlayersByIds(ctx, ids) {
    // Il capitano puo' non essere piu' nel ranking di riferimento: lo mostriamo comunque.
    const rows = await db.all(`SELECT id, name, country FROM players WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    const pos = await refPositions(ctx, ids);
    return rows.map((r) => ({ ...r, pos: pos.get(r.id) ?? null }));
  }

  async function tournamentsWithPeople(where, params) {
    const ts = await db.all(`SELECT * FROM tournaments WHERE ${where} ORDER BY week_start DESC, name`, params);
    if (!ts.length) return [];
    const ids = ts.map((t) => t.id);
    const ph = ids.map(() => '?').join(',');
    const results = await db.all(
      `SELECT tr.tournament_id, tr.player_id, tr.reached, p.name, p.country
         FROM tournament_results tr JOIN players p ON p.id = tr.player_id WHERE tr.tournament_id IN (${ph})`, ids);
    const draws = await db.all(
      `SELECT d.tournament_id, d.player_id, d.kind, p.name, p.country
         FROM draw_entries d JOIN players p ON p.id = d.player_id WHERE d.tournament_id IN (${ph})`, ids);
    return ts.map((t) => ({
      id: t.id, name: t.name, location: t.location, weekStart: t.week_start, status: t.status, updatedAt: t.updated_at,
      results: results.filter((r) => r.tournament_id === t.id).map((r) => ({ playerId: r.player_id, name: r.name, country: r.country, reached: r.reached })),
      draw: draws.filter((d) => d.tournament_id === t.id).map((d) => ({ playerId: d.player_id, name: d.name, country: d.country, kind: d.kind })),
    }));
  }

  /** RG-13: tornei conclusi per settimana, con ⭐ sui giocatori dello snapshot dell'utente (e sul capitano). */
  async function completedTournaments(user) {
    const ts = await tournamentsWithPeople(`status = 'concluded'`, []);
    let starred = new Set();
    const snapByWeek = new Map();
    const names = new Map();
    if (user) {
      const snaps = await db.all('SELECT week_start, player_id FROM roster_snapshots WHERE user_id = ?', [user.id]);
      starred = new Set(snaps.map((s) => `${s.week_start}|${s.player_id}`));
      for (const sn of snaps) { if (!snapByWeek.has(sn.week_start)) snapByWeek.set(sn.week_start, []); snapByWeek.get(sn.week_start).push(sn.player_id); }
      const ids = [...new Set([...snaps.map((x) => x.player_id), user.captain_id])];
      for (const r of await db.all(`SELECT id, name, country FROM players WHERE id IN (${ids.map(() => '?').join(',')})`, ids)) names.set(r.id, r);
    }
    const weeks = new Map();
    for (const t of ts) {
      const mark = (p) => ({ ...p, starred: starred.has(`${t.weekStart}|${p.playerId}`) || (user && p.playerId === user.captain_id && user.reg_week <= t.weekStart) });
      if (!weeks.has(t.weekStart)) weeks.set(t.weekStart, []);
      const card = { id: t.id, name: t.name, location: t.location, results: t.results.map(mark) };
      if (user) {
        const reachedOf = new Map(t.results.map((r) => [r.playerId, r.reached]));
        const entryOf = (id) => t.draw.find((d) => d.playerId === id) ?? t.results.find((r) => r.playerId === id);
        // La scelta dell'utente in questo torneo: giocatore dello snapshot di quella settimana che partecipava al torneo.
        const pickId = [...(snapByWeek.get(t.weekStart) ?? [])].find((id) => entryOf(id));
        const line = (id, isCaptain) => {
          const e = entryOf(id) ?? names.get(id) ?? { name: `Giocatore ${id}`, country: null };
          const reached = reachedOf.get(id) ?? null;
          return { playerId: id, name: e.name, country: e.country ?? null, reached, points: reached ? pointsFor(reached, isCaptain) : 0 };
        };
        const capPlays = user.reg_week <= t.weekStart && entryOf(user.captain_id);
        card.mine = {
          pick: pickId ? line(pickId, false) : null,
          captain: capPlays ? line(user.captain_id, true) : null,
        };
      }
      weeks.get(t.weekStart).push(card);
    }
    return [...weeks.entries()].map(([weekStart, tournaments]) => ({ weekStart, tournaments }));
  }

  /**
   * Partecipanti di ogni torneo (senza risultati): teste di serie in ordine, poi gli altri per ranking, poi WC, poi Q/LL.
   * Teste di serie e tipo di ingresso vengono dal tabellone salvato; senza tabellone si ripiega sull'elenco dei draw.
   */
  async function attachParticipants(list) {
    if (!list.length) return;
    const ph = list.map(() => '?').join(',');
    const rows = await db.all(`SELECT tournament_id, data FROM tournament_brackets WHERE tournament_id IN (${ph})`, list.map((t) => t.id));
    const brackets = new Map(rows.map((r) => [r.tournament_id, JSON.parse(r.data)]));
    const posRows = await db.all('SELECT player_id, pos FROM rankings WHERE week_start = (SELECT MAX(week_start) FROM rankings)');
    const pos = new Map(posRows.map((r) => [r.player_id, r.pos]));
    for (const t of list) {
      const map = new Map();
      const bracket = brackets.get(t.id);
      if (bracket) {
        for (const round of bracket) for (const m of round.matches) for (const p of [m.p1, m.p2]) {
          if (!p.id || !p.name) continue;
          const prev = map.get(p.id) ?? { playerId: p.id, name: p.name, country: p.country ?? null, seed: null, entry: null };
          map.set(p.id, { ...prev, seed: prev.seed ?? p.seed ?? null, entry: prev.entry ?? p.entry ?? null });
        }
      }
      if (!map.size) {
        for (const d of t.draw) map.set(d.playerId, { playerId: d.playerId, name: d.name, country: d.country, seed: null, entry: d.kind === 'qualifier' ? 'Q' : null });
      }
      const group = (p) => (p.seed != null ? 0 : !p.entry ? 1 : p.entry === 'WC' ? 2 : 3);
      const ranked = (p) => pos.get(p.playerId) ?? 99999;
      t.participants = [...map.values()].map((p) => ({ ...p, pos: pos.get(p.playerId) ?? null })).sort((a, b) =>
        group(a) - group(b) || (group(a) === 0 ? a.seed - b.seed : 0) || ranked(a) - ranked(b) || a.name.localeCompare(b.name));
      delete t.draw; delete t.results;
    }
  }

  async function inProgressTournaments() {
    const wk = mondayOf(clock());
    const ts = await tournamentsWithPeople(`week_start = ? AND status <> 'concluded'`, [wk]);
    const done = await tournamentsWithPeople(`week_start = ? AND status = 'concluded'`, [wk]);
    const all = [...ts, ...done];
    await attachParticipants(all);
    const last = all.map((t) => t.updatedAt).sort().at(-1) ?? null;
    return { weekStart: wk, updatedAt: last, tournaments: all };
  }

  async function nextWeekTournaments() {
    const now = clock();
    const p = romeParts(now);
    // Domenica: la "prossima settimana" e' quella che inizia domani (i draw sono appena stati importati).
    const wk = addDays(mondayOf(now), 7);
    const ts = await tournamentsWithPeople(`week_start = ?`, [wk]);
    await attachParticipants(ts);
    return { weekStart: wk, tournaments: ts, isSunday: p.dow === 7 };
  }

  // ---------------------------------------------------------------- import

  async function importRanking({ asWeek } = {}) {
    const week = asWeek ?? mondayOf(clock());
    const all = [];
    for (let page = 1; page <= 30; page++) {
      const r = await provider.fetchRankingPage(page, api);
      all.push(...r.players);
      if (!r.hasMore || all.filter((p) => p.rank <= POOL_SIZE).length >= POOL_SIZE) break;
    }
    const top = all.filter((p) => p.rank >= 1 && p.rank <= POOL_SIZE).sort((a, b) => a.rank - b.rank);
    if (top.length === 0) throw new Error('Ranking vuoto: import annullato');
    await db.tx(async (t) => {
      for (const p of top) await upsertPlayer(t, p);
      await t.run('DELETE FROM rankings WHERE week_start = ?', [week]);
      for (const p of top) await t.run('INSERT INTO rankings (week_start, player_id, pos) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [week, p.id, p.rank]);
    });
    return { week, players: top.length };
  }

  // RT-18: i giocatori sconosciuti vengono creati dai dati API con l'ID stabile del provider.
  async function upsertPlayer(t, p) {
    await t.run(
      `INSERT INTO players (id, name, country) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, country = COALESCE(excluded.country, players.country)`,
      [p.id, p.name, p.country ?? null],
    );
  }

  /** Struttura del tabellone (turni e partite) come da provider; non sovrascrive con un tabellone vuoto. */
  async function saveBracket(t, tournamentId, bracket) {
    if (!Array.isArray(bracket) || bracket.every((r) => !r.matches?.length)) return;
    await t.run(
      `INSERT INTO tournament_brackets (tournament_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (tournament_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      [tournamentId, JSON.stringify(bracket), iso()],
    );
  }

  async function importDraws(weekStart) {
    const tournaments = await provider.fetchWeekDraws(weekStart, api);
    await db.tx(async (t) => {
      for (const tr of tournaments) {
        await t.run(
          `INSERT INTO tournaments (id, name, week_start, status, location, updated_at) VALUES (?, ?, ?, 'scheduled', ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, location = excluded.location, updated_at = excluded.updated_at`,
          [tr.id, tr.name, weekStart, tr.location ?? null, iso()],
        );
        await saveBracket(t, tr.id, tr.bracket);
        await t.run('DELETE FROM draw_entries WHERE tournament_id = ?', [tr.id]);
        for (const p of tr.draw) {
          await upsertPlayer(t, p);
          await t.run('INSERT INTO draw_entries (tournament_id, player_id, kind) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [tr.id, p.id, p.kind]);
        }
      }
    });
    return { week: weekStart, tournaments: tournaments.length };
  }

  /** RL-26/RL-27: `onlyIncomplete` per il ricalcolo del martedi' (solo tornei non ancora conclusi). */
  async function importResults(weekStart, { onlyIncomplete = false } = {}) {
    const rows = await db.all('SELECT id, name, status FROM tournaments WHERE week_start = ?', [weekStart]);
    const status = new Map(rows.map((r) => [r.id, r.status]));
    const done = (id) => ['concluded', 'cancelled'].includes(status.get(id));
    // Martedi' (RL-26): se tutti i tornei noti sono gia' chiusi non serve spendere quota.
    if (onlyIncomplete && rows.length > 0 && rows.every((r) => done(r.id))) return { week: weekStart, tournaments: 0, concluded: 0, skipped: 'tutti chiusi' };
    let fetched = await provider.fetchWeekResults(weekStart, rows.filter((r) => !onlyIncomplete || !done(r.id)), api);
    if (onlyIncomplete) fetched = fetched.filter((r) => !done(r.tournamentId));
    const nameOf = new Map(rows.map((r) => [r.id, r.name]));
    const anomalies = [];
    await db.tx(async (t) => {
      for (const r of fetched) {
        // Mai declassare un torneo gia' chiuso (anche da correzione admin) con un risultato incerto.
        if (r.status !== 'concluded' && r.status !== 'cancelled' && done(r.tournamentId)) continue;
        if (r.anomaly) anomalies.push(`${r.name ?? nameOf.get(r.tournamentId) ?? r.tournamentId}: ${r.anomaly}`);
        await t.run(
          `INSERT INTO tournaments (id, name, week_start, status, location, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
          [r.tournamentId, r.name ?? nameOf.get(r.tournamentId) ?? `Torneo ${r.tournamentId}`, weekStart, r.status, r.location ?? null, iso()],
        );
        await saveBracket(t, r.tournamentId, r.bracket);
        if (r.status === 'concluded') {
          await t.run('DELETE FROM tournament_results WHERE tournament_id = ?', [r.tournamentId]);
          for (const x of r.results) {
            const known = await t.get('SELECT id FROM players WHERE id = ?', [x.playerId]);
            if (!known) await upsertPlayer(t, { id: x.playerId, name: x.name ?? `Giocatore ${x.playerId}`, country: null });
            await t.run('INSERT INTO tournament_results (tournament_id, player_id, reached) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [r.tournamentId, x.playerId, x.reached]);
          }
        } else if (r.status === 'cancelled') {
          await t.run('DELETE FROM tournament_results WHERE tournament_id = ?', [r.tournamentId]);
        }
      }
    });
    await recomputePoints();
    if (anomalies.length) {
      await bot.notifyAdmins(`⚠️ Risultati da verificare (settimana ${weekStart}):\n${anomalies.join('\n')}\nCorreggi con /api/admin/results o attendi la settimana successiva.`);
    }
    return { week: weekStart, tournaments: fetched.length, concluded: fetched.filter((x) => x.status === 'concluded').length, anomalies: anomalies.length };
  }

  // ---------------------------------------------------------------- passaggio dai dati demo ai dati reali

  /**
   * Se il DB contiene dati del provider fittizio e ora si usa quello reale, elimina i dati di gioco finti
   * (giocatori, ranking, tornei, utenti con capitani finti). La quota API e il log di audit restano.
   * Il passaggio inverso (reale -> mock) non cancella mai nulla.
   */
  async function reconcileProvider() {
    const meta = await db.get(`SELECT v FROM meta WHERE k = 'data_provider'`);
    const mockish = (await db.get(`SELECT COUNT(*) AS n FROM players WHERE id LIKE 'p%'`)).n > 0; // id fittizi: p1, p2...
    const stored = meta?.v ?? (mockish ? 'mock' : null);
    const current = provider.name;
    let purged = false;
    // Controlla i dati e non solo il marcatore: un vecchio container (provider mock) ancora attivo durante un deploy
    // puo' rigenerare dati finti dopo una pulizia.
    if (current !== 'mock' && (stored === 'mock' || mockish)) {
      await db.tx(async (t) => {
        for (const table of ['points', 'roster_snapshots', 'snapshot_weeks', 'rosters', 'tournament_results', 'draw_entries', 'tournaments', 'rankings', 'players', 'users', 'job_runs']) {
          await t.run(`DELETE FROM ${table}`);
        }
      });
      await audit('system', 'purge-mock-data', { from: 'mock', to: current });
      await bot.notifyAdmins('🧹 Passaggio ai dati reali: eliminati giocatori, tornei e iscritti di prova. Import del ranking in corso.');
      console.log('[reconcile] dati fittizi eliminati, provider:', current);
      purged = true;
    } else if (stored && stored !== 'mock' && current === 'mock') {
      console.warn('ATTENZIONE: il DB contiene dati reali ma il provider attivo e\' MOCK (MOCK_API=1). Nessun dato modificato.');
      return { purged: false, warning: true };
    }
    await db.run(`INSERT INTO meta (k, v) VALUES ('data_provider', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, [current]);
    return { purged };
  }

  // ---------------------------------------------------------------- reminder (RG-18)

  async function sendReminders() {
    const ctx = await context();
    if (!ctx.open) return { sent: 0 };
    const total = (await db.get(`SELECT COUNT(*) AS n FROM tournaments WHERE week_start = ? AND status <> 'cancelled'`, [ctx.weekStart])).n;
    if (!total) return { sent: 0 };
    const users = await db.all(
      `SELECT u.id, u.telegram_id, r.player_ids FROM users u
         LEFT JOIN rosters r ON r.user_id = u.id AND r.week_start = ?`,
      [ctx.weekStart],
    );
    const filledOf = (u) => (u.player_ids ? JSON.parse(u.player_ids).length : 0);
    const todo = users.filter((u) => filledOf(u) < total);
    let sent = 0;
    for (const u of todo) {
      const ok = await bot.sendMessage(
        u.telegram_id,
        `🎾 Hai scelto ${filledOf(u)} giocatori su ${total} tornei. La finestra chiude martedì alle 15:00: apri l'app e completa la rosa!`,
        { openApp: true },
      );
      if (ok) sent++;
      await new Promise((r) => setTimeout(r, 40)); // < 30 msg/s
    }
    return { sent, total: todo.length };
  }

  // ---------------------------------------------------------------- scheduler (RT-05, calendario 5.3)

  const JOBS = {
    draws: async (key) => importDraws(key),
    results: async (key) => importResults(key),
    ranking: async (key) => {
      const out = await importRanking({ asWeek: key });
      // Primo avvio: nessun ranking "della settimana precedente" -> usa lo stesso come riferimento (0 chiamate API).
      const earlier = await db.get('SELECT MAX(week_start) AS w FROM rankings WHERE week_start < ?', [key]);
      if (!earlier?.w) {
        const prev = addDays(key, -7);
        await db.run('INSERT INTO rankings (week_start, player_id, pos) SELECT ?, player_id, pos FROM rankings WHERE week_start = ?', [prev, key]);
        out.bootstrappedReference = prev;
      }
      return out;
    },
    recheck: async (key) => importResults(key, { onlyIncomplete: true }),
    reminder: async () => sendReminders(),
    close: async (key) => {
      const s = await snapshotWeek(key);
      await recomputePoints();
      return s;
    },
    recompute: async () => recomputePoints(),
  };

  /** Job dovuti in questo istante (Europe/Rome). Il catch-up dopo un riavvio e' coperto da job_runs. */
  function dueJobs(now = clock()) {
    const W = mondayOf(now);
    const prev = addDays(W, -7);
    const dow = romeParts(now).dow;
    const at = (day, hh, mm = 0) => now >= romeToUtc(addDays(W, day), hh, mm);
    const due = [];
    if (dow === 7 && at(6, 8)) due.push(['draws', addDays(W, 7)]); // domenica: draw della settimana dopo
    if (at(0, 0, 1)) due.push(['draws', W]); // catch-up se la domenica e' fallita
    if (at(0, 12)) {
      due.push(['results', prev]);
      due.push(['ranking', W]); // vale dalla settimana successiva (RT-06)
    }
    if (now >= romeToUtc(addDays(W, 0), 18) && now < windowOf(W).closes) due.push(['reminder', W]);
    if (at(1, 8)) due.push(['recheck', prev]);
    if (at(1, 15)) due.push(['close', W]);
    return due;
  }

  async function runJob(job, key, { force = false, actor = 'scheduler' } = {}) {
    const fn = JOBS[job];
    if (!fn) throw new AppError('UNKNOWN_JOB', `Job sconosciuto: ${job}`, 404);
    const row = await db.get('SELECT * FROM job_runs WHERE job = ? AND run_key = ?', [job, key]);
    if (!force && row) {
      if (row.status === 'done') return { skipped: 'done' };
      if (row.attempts >= MAX_JOB_ATTEMPTS) return { skipped: 'max-attempts' };
      const waitMs = 15 * 60 * 1000 * row.attempts; // backoff (RT-27)
      if (row.last_attempt_at && clock() - new Date(row.last_attempt_at) < waitMs) return { skipped: 'backoff' };
    }
    const attempts = force ? 1 : (row?.attempts ?? 0) + 1;
    try {
      const out = await fn(key);
      await upsertJob(job, key, 'done', attempts, JSON.stringify(out ?? null));
      console.log(`[job] ${job} ${key} ok`, JSON.stringify(out ?? null).slice(0, 300));
      await audit(actor, `job:${job}`, { key, out, force });
      return { ok: true, out };
    } catch (e) {
      const blocked = e instanceof QuotaExhaustedError;
      await upsertJob(job, key, blocked ? 'blocked' : 'failed', blocked ? MAX_JOB_ATTEMPTS : attempts, e.message);
      console.error(`[job] ${job} ${key} FALLITO (tentativo ${attempts}): ${e.message}`);
      await audit(actor, `job-failed:${job}`, { key, error: e.message });
      if (blocked || attempts >= MAX_JOB_ATTEMPTS) {
        await bot.notifyAdmins(`❌ Job "${job}" (${key}) fallito: ${e.message}${blocked ? ' — usa il fallback manuale.' : ''}`);
      }
      return { ok: false, error: e.message };
    }
  }

  async function upsertJob(job, key, status, attempts, message) {
    await db.run(
      `INSERT INTO job_runs (job, run_key, status, attempts, last_attempt_at, message) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (job, run_key) DO UPDATE SET status = excluded.status, attempts = excluded.attempts,
         last_attempt_at = excluded.last_attempt_at, message = excluded.message`,
      [job, key, status, attempts, iso(), String(message ?? '').slice(0, 500)],
    );
  }

  function defaultKey(job, now = clock()) {
    const W = mondayOf(now);
    if (job === 'draws') return romeParts(now).dow === 7 ? addDays(W, 7) : W;
    if (job === 'results' || job === 'recheck') return addDays(W, -7);
    return W;
  }

  async function tick() {
    for (const [job, key] of dueJobs()) {
      const row = await db.get('SELECT status, attempts FROM job_runs WHERE job = ? AND run_key = ?', [job, key]);
      if (row?.status === 'done') continue;
      await runJob(job, key);
    }
  }

  // ---------------------------------------------------------------- amministrazione (RT-24..RT-26)

  async function adminSetResults(actor, { tournamentId, status = 'concluded', results = [] }) {
    const t = await db.get('SELECT id FROM tournaments WHERE id = ?', [tournamentId]);
    if (!t) throw new AppError('NOT_FOUND', 'Torneo inesistente', 404);
    if (!['scheduled', 'in_progress', 'concluded', 'cancelled'].includes(status)) throw new AppError('BAD_REQUEST', 'Stato non valido');
    const valid = results.every((r) => ['winner', 'finalist', 'semifinalist'].includes(r.reached) && typeof r.playerId === 'string');
    if (!valid) throw new AppError('BAD_REQUEST', 'Risultati non validi');
    await db.tx(async (tx) => {
      await tx.run('DELETE FROM tournament_results WHERE tournament_id = ?', [tournamentId]);
      if (status === 'concluded') {
        for (const r of results) {
          const known = await tx.get('SELECT id FROM players WHERE id = ?', [r.playerId]);
          if (!known) throw new AppError('BAD_REQUEST', `Giocatore sconosciuto: ${r.playerId}`);
          await tx.run('INSERT INTO tournament_results (tournament_id, player_id, reached) VALUES (?, ?, ?)', [tournamentId, r.playerId, r.reached]);
        }
      }
      await tx.run('UPDATE tournaments SET status = ?, updated_at = ? WHERE id = ?', [status, iso(), tournamentId]);
    });
    await audit(actor, 'admin:set-results', { tournamentId, status, results });
    await recomputePoints(); // RT-25
    return { ok: true };
  }

  async function adminStatus() {
    return {
      quota: await api.status(),
      jobs: await db.all('SELECT * FROM job_runs ORDER BY last_attempt_at DESC LIMIT 20'),
      users: (await db.get('SELECT COUNT(*) AS n FROM users')).n,
      lastRankingWeek: (await db.get('SELECT MAX(week_start) AS w FROM rankings')).w,
      provider: provider.name,
      players: (await db.get('SELECT COUNT(*) AS n FROM players')).n,
      tournaments: (await db.get('SELECT COUNT(*) AS n FROM tournaments')).n,
    };
  }

  return {
    context, listPlayers, pickOptions, register, findUser, touchTeamName, saveRoster, getState, snapshotWeek, ensureSnapshots,
    recomputePoints, standings, completedTournaments, inProgressTournaments, nextWeekTournaments,
    importRanking, importDraws, importResults, sendReminders, dueJobs, runJob, defaultKey, tick,
    adminSetResults, adminStatus, adminPicksReport, audit, windowPayload, dayOfWeekOf, reconcileProvider,
  };
}
