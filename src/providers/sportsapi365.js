// Provider reale SportsAPI365 (licenza tennis).
//
// ⚠️ DA ADATTARE: la documentazione di SportsAPI365 non era consultabile durante lo sviluppo, quindi
// endpoint, autenticazione e nomi dei campi qui sotto sono ipotesi configurabili via variabili d'ambiente.
// Tutto il resto dell'app parla solo con l'interfaccia normalizzata di questo file:
//
//   fetchRankingPage(page, api)  -> { players: [{ id, name, country, rank }], hasMore }
//   fetchWeekDraws(weekStart, api) -> [{ id, name, location, weekStart, status, draw: [{ id, name, country, kind }] }]
//   fetchWeekResults(weekStart, tournaments, api) -> [{ tournamentId, status, results: [{ playerId, reached }] }]
//
// Verificare (RT-08..RT-10): quanti giocatori per pagina restituisce il ranking e se esistono endpoint
// "tutti i tornei della settimana" / "risultati per data", per rispettare il budget di 150 chiamate/mese.

const cfg = () => ({
  base: process.env.SPORTSAPI365_BASE_URL,
  key: process.env.SPORTSAPI365_KEY,
  authHeader: process.env.SPORTSAPI365_AUTH_HEADER || 'x-api-key',
  rankingPath: process.env.SPORTSAPI365_RANKING_PATH || '/tennis/rankings/atp',
  tournamentsPath: process.env.SPORTSAPI365_TOURNAMENTS_PATH || '/tennis/tournaments',
  resultsPath: process.env.SPORTSAPI365_RESULTS_PATH || '/tennis/tournaments/{id}/results',
});

async function getJson(path, params = {}) {
  const c = cfg();
  if (!c.base || !c.key) throw new Error('SPORTSAPI365_BASE_URL / SPORTSAPI365_KEY non configurati');
  const url = new URL(c.base.replace(/\/$/, '') + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { [c.authHeader]: c.key, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    const err = new Error(`SportsAPI365 ${res.status} su ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const first = (o, keys) => keys.map((k) => o?.[k]).find((v) => v !== undefined && v !== null);
const asList = (d) => (Array.isArray(d) ? d : first(d, ['data', 'results', 'items', 'rankings', 'players']) ?? []);

const normPlayer = (p) => ({
  id: String(first(p, ['id', 'player_id', 'playerId'])),
  name: String(first(p, ['name', 'player_name', 'full_name']) ?? 'Sconosciuto'),
  country: first(p, ['country', 'country_code', 'nationality']) ?? null,
});

export const sportsApi365Provider = {
  name: 'sportsapi365',

  async fetchRankingPage(page, api) {
    const c = cfg();
    return api.request(`${c.rankingPath}?page=${page}`, async () => {
      const data = await getJson(c.rankingPath, { page });
      const rows = asList(data);
      const players = rows.map((r) => ({ ...normPlayer(r.player ?? r), rank: Number(first(r, ['rank', 'position', 'ranking'])) }));
      const hasMore = Boolean(first(data, ['next_page', 'has_more', 'hasMore'])) || (rows.length > 0 && players.at(-1).rank < 900 && rows.length >= 50);
      return { players, hasMore };
    });
  },

  async fetchWeekDraws(weekStart, api) {
    const c = cfg();
    return api.request(`${c.tournamentsPath}?week=${weekStart}`, async () => {
      // ADATTARE: filtro "solo ATP Challenger" e struttura del draw dipendono dall'API reale (RL-19).
      const data = await getJson(c.tournamentsPath, { start_date: weekStart, category: 'challenger', tour: 'atp' });
      return asList(data).map((t) => ({
        id: String(first(t, ['id', 'tournament_id'])),
        name: String(first(t, ['name', 'tournament_name'])),
        location: first(t, ['location', 'city', 'country']) ?? null,
        weekStart,
        status: 'scheduled',
        draw: asList(first(t, ['draw', 'participants', 'players']) ?? []).map((p) => ({
          ...normPlayer(p.player ?? p),
          kind: /qual/i.test(String(first(p, ['type', 'kind', 'draw_type']) ?? '')) ? 'qualifier' : 'main',
        })),
      }));
    });
  },

  async fetchWeekResults(weekStart, tournaments, api) {
    const c = cfg();
    const out = [];
    for (const t of tournaments) {
      const path = c.resultsPath.replace('{id}', encodeURIComponent(t.id));
      out.push(await api.request(path, async () => {
        const data = await getJson(path);
        const rawStatus = String(first(data, ['status']) ?? '').toLowerCase();
        const status = /cancel|aband/.test(rawStatus) ? 'cancelled' : /final|conclu|finished|complete/.test(rawStatus) ? 'concluded' : 'in_progress';
        // ADATTARE: estrarre vincitore, finalista e semifinalisti dalla risposta reale.
        const results = asList(first(data, ['results', 'standings', 'podium']) ?? []).map((r) => ({
          playerId: String(first(r.player ?? r, ['id', 'player_id'])),
          reached: String(first(r, ['reached', 'round', 'result'])).toLowerCase().replace('semi', 'semifinalist').replace(/^final$/, 'finalist'),
        })).filter((r) => ['winner', 'finalist', 'semifinalist'].includes(r.reached));
        return { tournamentId: t.id, status, results };
      }));
    }
    return out;
  },
};
