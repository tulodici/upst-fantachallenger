// Provider reale SportsAPI365 (Direct API, tennis). Endpoint e forme di risposta ricavati dal progetto precedente
// (funzionante) e da risposte reali:
//   ranking   GET /v1/tennis/atp/ranking/singles?pageNo&pageSize   -> { data: [{ position, player: { id, name, countryAcr } }], hasNextPage }
//   calendario GET /v1/tennis/calendar/active?tour=atp&startDate&endDate -> { data: [{ id, name, rankId, startDate|date, countryAcr, court }] }
//   tabellone GET /v1/tennis/tournament/atp/{nome}/{anno}/draws?includeAll=true&fullBracket=true
//                                                                 -> { singles: [...], qualifying: [...] } (match: roundId, result, tbd, winnerId, player1, player2)
// Budget (150 chiamate/mese): ranking 2 + calendario 1 + 1 tabellone per Challenger. Gli stessi tabelloni servono sia per
// i draw della settimana dopo (domenica) sia per i risultati (lunedi'/martedi'), senza altri endpoint.
import { addDays, dayOfWeekOf } from '../time.js';

const ROUND_SEMI = Number(process.env.SPORTSAPI365_ROUND_SEMI || 10);
const ROUND_FINAL = Number(process.env.SPORTSAPI365_ROUND_FINAL || 12);

const cfg = () => ({
  base: (process.env.SPORTSAPI365_BASE_URL || 'https://api.sportsapi365.com').replace(/\/+$/, '').replace(/\/v1\/tennis$/, ''),
  key: process.env.SPORTSAPI365_KEY,
  authHeader: process.env.SPORTSAPI365_AUTH_HEADER || 'X-Gravitee-Api-Key',
  pageSize: Number(process.env.SPORTSAPI365_PAGE_SIZE || 500),
  minIntervalMs: Number(process.env.SPORTSAPI365_MIN_INTERVAL_MS ?? 1000), // al massimo 1 richiesta al secondo
});

let lastCallAt = 0;
async function getJson(path, params = {}) {
  const c = cfg();
  if (!c.key) throw new Error('SPORTSAPI365_KEY non configurata');
  const wait = lastCallAt + c.minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
  const url = new URL(`${c.base}/v1/tennis${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { [c.authHeader]: c.key, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const err = new Error(`SportsAPI365 ${res.status} su ${path.split('?')[0]}`);
    err.status = res.status;
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      err.retryAfterMs = Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 20000, 120000);
    }
    throw err;
  }
  return res.json();
}

const list = (d) => (Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []);

// ---------------------------------------------------------------- calendario

const startOf = (t) => String(t.startDate ?? t.date ?? '').slice(0, 10);

/** Data ufficiale di inizio -> lunedi' della settimana ATP (una partenza di domenica conta per il lunedi' dopo). */
export function weekOfStart(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const dow = dayOfWeekOf(dateStr);
  return addDays(dateStr, dow === 7 ? 1 : -(dow - 1));
}

/** RL-19: rank 1 include anche tornei ITF, quindi si richiede "challenger" nel nome. */
export function filterChallengers(tournaments) {
  return tournaments.filter((t) => {
    const rankId = t.rankId ?? (typeof t.rank === 'object' ? t.rank?.id : null);
    return rankId === 1 && /challenger/i.test(String(t.name ?? ''));
  });
}

async function fetchCalendar(weekStart, api) {
  const startDate = weekStart;
  const endDate = addDays(weekStart, 6);
  const data = await api.request(`calendar/active?${startDate}..${endDate}`, () =>
    getJson('/calendar/active', { tour: 'atp', startDate, endDate }));
  return filterChallengers(list(data))
    .filter((t) => weekOfStart(startOf(t)) === weekStart) // solo i tornei che INIZIANO questa settimana
    .map((t) => ({ id: String(t.id), name: String(t.name), location: t.countryAcr ?? null }));
}

// ---------------------------------------------------------------- tabellone

async function fetchDraw(t, year, api) {
  const path = `/tournament/atp/${encodeURIComponent(t.name)}/${year}/draws`;
  return api.request(`draws:${t.name}`, () => getJson(path, { includeAll: 'true', fullBracket: 'true' }));
}

const person = (p) => {
  if (!p || typeof p !== 'object' || !p.name || ['TBA', 'BYE'].includes(String(p.name).toUpperCase())) return null;
  return p.id == null ? null : { id: String(p.id), name: String(p.name), country: p.countryAcr ?? null };
};
const bothPlayers = (m) => { const a = person(m.player1); const b = person(m.player2); return a && b ? [a, b] : null; };
const completed = (m) => Boolean(m.result && bothPlayers(m) && !m.tbd);

/** Giocatori del tabellone: main draw dai match di `singles`, qualificandi da `qualifying` (se non gia' in main). */
export function drawParticipants(draw) {
  const out = new Map();
  for (const m of draw?.singles ?? []) for (const p of [person(m.player1), person(m.player2)]) if (p) out.set(p.id, { ...p, kind: 'main' });
  for (const m of draw?.qualifying ?? []) for (const p of [person(m.player1), person(m.player2)]) if (p && !out.has(p.id)) out.set(p.id, { ...p, kind: 'qualifier' });
  return [...out.values()];
}

const ROUND_LABELS = { 9: 'Quarti di finale', 10: 'Semifinali', 12: 'Finale' };
const COUNT_LABELS = { 1: 'Finale', 2: 'Semifinali', 4: 'Quarti di finale', 8: 'Ottavi di finale', 16: 'Sedicesimi di finale' };
const slot = (p) => {
  if (!p || typeof p !== 'object' || !p.name) return { id: null, name: null };
  const up = String(p.name).toUpperCase();
  if (up === 'BYE') return { id: null, name: 'BYE' };
  if (up === 'TBA') return { id: null, name: null };
  return { id: p.id == null ? null : String(p.id), name: String(p.name), country: p.countryAcr ?? null, seed: p.seed ?? null };
};

/**
 * Struttura reale del tabellone principale: turni (dal piu' lontano alla finale) con le partite nell'ordine dell'API.
 * Etichetta: id turno noto (9/10/12) oppure dal numero di partite del turno; altrimenti "Turno n".
 */
export function buildBracket(draw) {
  const byRound = new Map();
  for (const m of draw?.singles ?? []) {
    if (m.roundId == null) continue;
    if (!byRound.has(m.roundId)) byRound.set(m.roundId, []);
    byRound.get(m.roundId).push(m);
  }
  const ids = [...byRound.keys()].sort((a, b) => a - b);
  return ids.map((roundId, i) => {
    const ms = byRound.get(roundId);
    return {
      roundId,
      label: ROUND_LABELS[roundId] ?? COUNT_LABELS[ms.length] ?? `Turno ${i + 1}`,
      matches: ms.map((m) => {
        const winnerId = m.winnerId ?? m.winner_id ?? null;
        const done = Boolean(m.result && !m.tbd);
        return { p1: slot(m.player1), p2: slot(m.player2), winnerId: done && winnerId != null ? String(winnerId) : null, score: done ? String(m.result) : null };
      }),
    };
  });
}

/**
 * Esito dal tabellone: vincitore e finalista dalla finale (con winnerId), semifinalisti = perdenti delle semifinali.
 * Se qualcosa non torna (finale non giocata, semifinalisti != 2) il torneo resta "in_progress" con un'anomalia.
 */
export function extractResults(draw) {
  const singles = draw?.singles ?? [];
  const semis = singles.filter((m) => m.roundId === ROUND_SEMI && completed(m));
  const final = singles.find((m) => m.roundId === ROUND_FINAL);
  const finalPlayers = final ? bothPlayers(final) : null;
  const winnerId = final?.winnerId ?? final?.winner_id;
  if (!final || !finalPlayers || !completed(final) || winnerId == null) {
    return { status: 'in_progress', results: [] };
  }
  const winner = finalPlayers.find((p) => p.id === String(winnerId));
  const runnerUp = finalPlayers.find((p) => p.id !== String(winnerId));
  if (!winner || !runnerUp) return { status: 'in_progress', results: [], anomaly: 'vincitore della finale non riconosciuto' };
  const exits = new Map();
  for (const m of semis) for (const p of bothPlayers(m)) if (p.id !== winner.id && p.id !== runnerUp.id) exits.set(p.id, p);
  if (exits.size !== 2) return { status: 'in_progress', results: [], anomaly: `semifinalisti trovati: ${exits.size} (attesi 2)` };
  return {
    status: 'concluded',
    results: [
      { playerId: winner.id, name: winner.name, reached: 'winner' },
      { playerId: runnerUp.id, name: runnerUp.name, reached: 'finalist' },
      ...[...exits.values()].map((p) => ({ playerId: p.id, name: p.name, reached: 'semifinalist' })),
    ],
  };
}

// ---------------------------------------------------------------- interfaccia del provider

export const sportsApi365Provider = {
  name: 'sportsapi365',

  async fetchRankingPage(page, api) {
    const c = cfg();
    return api.request(`ranking/singles?pageNo=${page}&pageSize=${c.pageSize}`, async () => {
      const data = await getJson('/atp/ranking/singles', { pageNo: page, pageSize: c.pageSize });
      const players = list(data)
        .filter((r) => r.player?.id != null && Number.isInteger(Number(r.position)))
        .map((r) => ({ id: String(r.player.id), name: String(r.player.name ?? 'Sconosciuto'), country: r.player.countryAcr ?? r.player.country?.acronym ?? null, rank: Number(r.position) }));
      return { players, hasMore: data?.hasNextPage === true };
    });
  },

  /** Domenica: tornei Challenger della settimana dopo con i giocatori dei tabelloni (1 calendario + 1 chiamata per torneo). */
  async fetchWeekDraws(weekStart, api) {
    const year = Number(weekStart.slice(0, 4));
    const out = [];
    for (const t of await fetchCalendar(weekStart, api)) {
      try {
        const draw = await fetchDraw(t, year, api);
        out.push({ ...t, weekStart, status: 'scheduled', draw: drawParticipants(draw), bracket: buildBracket(draw) });
      } catch (e) {
        if (e.name === 'QuotaExhaustedError') throw e;
        out.push({ ...t, weekStart, status: 'scheduled', draw: [] }); // il torneo compare comunque, senza tabellone
      }
    }
    return out;
  },

  /** Risultati: un tabellone per torneo (quelli gia' noti dal DB, altrimenti scoperti dal calendario). */
  async fetchWeekResults(weekStart, tournaments, api) {
    const year = Number(weekStart.slice(0, 4));
    const targets = tournaments.length ? tournaments : await fetchCalendar(weekStart, api);
    const out = [];
    for (const t of targets) {
      const draw = await fetchDraw(t, year, api);
      out.push({ tournamentId: String(t.id), name: t.name, location: t.location ?? null, ...extractResults(draw), bracket: buildBracket(draw) });
    }
    return out;
  },
};
