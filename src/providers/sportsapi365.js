// Provider reale SportsAPI365 (Direct API, tennis). Forme di risposta verificate su esempi reali:
//   ranking:  GET /v1/tennis/atp/ranking/singles            -> { data: [{ position, player: { id, name, countryAcr } }], hasNextPage? }
//   risultati: GET /v1/tennis/atp/results/{start}/{end}      -> { data: [{ matchId, date, roundId, match_winner, player1Id, player2Id,
//                                                               player1:{id,name,countryAcr}, player2:{...}, tournament:{ id, name, date, countryAcr } }] }
// Da verificare in produzione: nome del parametro di paginazione (default `page`, cambiabile con SPORTSAPI365_PAGE_PARAM).
// I tabelloni (draw) della settimana successiva non sono importati: l'endpoint che elenca i tornei Challenger non e'
// documentato nelle pagine consultabili. Senza draw, "Prossima settimana" resta vuota e i giocatori risultano "non in tabellone".
import { addDays } from '../time.js';
import { deriveOutcome } from './outcome.js';

const cfg = () => ({
  base: (process.env.SPORTSAPI365_BASE_URL || 'https://api.sportsapi365.com').replace(/\/+$/, '').replace(/\/v1\/tennis$/, ''),
  key: process.env.SPORTSAPI365_KEY,
  authHeader: process.env.SPORTSAPI365_AUTH_HEADER || 'X-Gravitee-Api-Key',
  type: process.env.SPORTSAPI365_TYPE || 'atp',
  pageParam: process.env.SPORTSAPI365_PAGE_PARAM || 'page',
  challenger: new RegExp(process.env.SPORTSAPI365_CHALLENGER_REGEX || 'challenger', 'i'),
});

async function getJson(path, params = {}) {
  const c = cfg();
  if (!c.key) throw new Error('SPORTSAPI365_KEY non configurata');
  const url = new URL(`${c.base}/v1/tennis${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { [c.authHeader]: c.key, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const err = new Error(`SportsAPI365 ${res.status} su ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const rows = (d) => (Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []);

let firstRankingId = null; // protezione: se `page` fosse ignorato la pagina 2 ripeterebbe la 1

export const sportsApi365Provider = {
  name: 'sportsapi365',

  async fetchRankingPage(page, api) {
    const c = cfg();
    const path = `/${c.type}/ranking/singles`;
    return api.request(`${path}?${c.pageParam}=${page}`, async () => {
      const data = await getJson(path, { [c.pageParam]: page });
      const list = rows(data);
      const players = list
        .filter((r) => r.player?.id != null && Number.isInteger(Number(r.position)))
        .map((r) => ({ id: String(r.player.id), name: String(r.player.name ?? 'Sconosciuto'), country: r.player.countryAcr ?? r.player.country?.acronym ?? null, rank: Number(r.position) }));
      if (page === 1) firstRankingId = players[0]?.id ?? null;
      else if (players[0] && players[0].id === firstRankingId) {
        throw Object.assign(new Error(`Paginazione ranking non funzionante col parametro "${c.pageParam}" (pagina ${page} uguale alla 1): impostare SPORTSAPI365_PAGE_PARAM`), { status: 400 });
      }
      const hasMore = typeof data?.hasNextPage === 'boolean' ? data.hasNextPage : players.length > 0;
      return { players, hasMore };
    });
  },

  // Vedi nota in testa: nessun endpoint noto per elencare i Challenger della settimana prima che inizino.
  async fetchWeekDraws() {
    return [];
  },

  /** Risultati dei Challenger che iniziano il lunedi' `weekStart` (inclusi gli slittamenti fino al lunedi' dopo). */
  async fetchWeekResults(weekStart, _tournaments, api) {
    const c = cfg();
    const path = `/${c.type}/results/${weekStart}/${addDays(weekStart, 7)}`;
    const matches = [];
    let prevFirst = null;
    for (let page = 1; page <= 30; page++) {
      const data = await api.request(`${path}?${c.pageParam}=${page}`, () => getJson(path, { [c.pageParam]: page }));
      const list = rows(data);
      if (page > 1 && list[0] && String(list[0].id ?? list[0].matchId) === prevFirst) {
        throw Object.assign(new Error(`Paginazione risultati non funzionante col parametro "${c.pageParam}": impostare SPORTSAPI365_PAGE_PARAM`), { status: 400 });
      }
      prevFirst = list[0] ? String(list[0].id ?? list[0].matchId) : null;
      matches.push(...list);
      if (!list.length || data?.hasNextPage !== true) break;
    }

    const byTournament = new Map();
    const names = new Map();
    for (const m of matches) {
      const t = m.tournament;
      if (!t || !c.challenger.test(String(t.name ?? ''))) continue; // RL-19: solo ATP Challenger
      if (String(t.date ?? '').slice(0, 10) !== weekStart) continue; // la settimana e' la data ufficiale di inizio (RT-07)
      const winner = m.match_winner != null ? String(m.match_winner) : null;
      const p1 = String(m.player1Id ?? m.player1?.id);
      const p2 = String(m.player2Id ?? m.player2?.id);
      if (!winner || (winner !== p1 && winner !== p2)) continue; // partita non decisa
      names.set(p1, m.player1?.name);
      names.set(p2, m.player2?.name);
      const key = String(t.id);
      if (!byTournament.has(key)) byTournament.set(key, { name: String(t.name), location: t.countryAcr ?? null, matches: [] });
      byTournament.get(key).matches.push({ id: m.matchId ?? m.id, date: m.date, roundId: m.roundId, winnerId: winner, loserId: winner === p1 ? p2 : p1 });
    }

    return [...byTournament].map(([tournamentId, t]) => {
      const out = deriveOutcome(t.matches);
      return {
        tournamentId, name: t.name, location: t.location, status: out.status, anomaly: out.anomaly,
        results: out.results.map((r) => ({ ...r, name: names.get(r.playerId) ?? undefined })),
      };
    });
  },
};
