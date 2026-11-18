// Provider fittizio deterministico per sviluppo, demo e test. Non usa quota reale ma rispetta il contatore.
import { addDays } from '../time.js';

const FIRST = ['Luca', 'Marco', 'Andrea', 'Matteo', 'Jan', 'Pablo', 'Hugo', 'Yuki', 'Tomas', 'Felix', 'Nico', 'Dmitri', 'Rafa', 'Kei', 'Ivan', 'Omar', 'Leo', 'Sasha', 'Diego', 'Thiago'];
const LAST = ['Rossi', 'Bianchi', 'Garcia', 'Novak', 'Kuznetsov', 'Tanaka', 'Dubois', 'Schmidt', 'Silva', 'Costa', 'Moretti', 'Ferrari', 'Lopez', 'Petrov', 'Haas', 'Weber', 'Olsen', 'Kim', 'Park', 'Santos'];
const COUNTRIES = ['ITA', 'ESP', 'FRA', 'GER', 'ARG', 'JPN', 'USA', 'BRA', 'SRB', 'CZE'];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let s = hash(String(seed)) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export const mockPlayer = (rank) => ({
  id: `p${rank}`,
  name: `${FIRST[rank % FIRST.length]} ${LAST[(rank * 7) % LAST.length]} ${rank}`,
  country: COUNTRIES[rank % COUNTRIES.length],
  rank,
});

export function createMockProvider({ totalPlayers = 950, pageSize = 100, tournamentsPerWeek = 2 } = {}) {
  const tournamentsOf = (weekStart) =>
    Array.from({ length: tournamentsPerWeek }, (_, i) => ({
      id: `t-${weekStart}-${i + 1}`,
      name: ['Challenger Trieste', 'Challenger Lugano', 'Challenger Bordeaux', 'Challenger Lisbona'][(hash(weekStart) + i) % 4] + ` ${i + 1}`,
      location: ['Italia', 'Svizzera', 'Francia', 'Portogallo'][(hash(weekStart) + i) % 4],
    }));

  function drawOf(weekStart, t, idx) {
    const r = rng(`${weekStart}-${idx}`);
    const picked = new Set();
    while (picked.size < 32) picked.add(60 + Math.floor(r() * 600) + idx * 3);
    return [...picked].sort((a, b) => a - b).map((rank, i) => ({ ...mockPlayer(rank), kind: i < 28 ? 'main' : 'qualifier' }));
  }

  return {
    name: 'mock',
    async fetchRankingPage(page, api) {
      return api.request(`mock:ranking?page=${page}`, async () => {
        const start = (page - 1) * pageSize + 1;
        const end = Math.min(page * pageSize, totalPlayers);
        const players = [];
        for (let r = start; r <= end; r++) players.push(mockPlayer(r));
        return { players, hasMore: end < totalPlayers };
      });
    },
    async fetchWeekDraws(weekStart, api) {
      return api.request(`mock:draws?week=${weekStart}`, async () =>
        tournamentsOf(weekStart).map((t, idx) => ({ ...t, weekStart, status: 'scheduled', draw: drawOf(weekStart, t, idx) })));
    },
    async fetchWeekResults(weekStart, tournaments, api) {
      const out = [];
      for (const [idx, t] of tournaments.entries()) {
        out.push(await api.request(`mock:results?t=${t.id}`, async () => {
          const draw = drawOf(weekStart, t, idx);
          const r = rng(`res-${t.id}`);
          const order = draw.filter((p) => p.kind === 'main').sort(() => r() - 0.5).slice(0, 4);
          return {
            tournamentId: t.id,
            status: 'concluded',
            results: [
              { playerId: order[0].id, reached: 'winner' },
              { playerId: order[1].id, reached: 'finalist' },
              { playerId: order[2].id, reached: 'semifinalist' },
              { playerId: order[3].id, reached: 'semifinalist' },
            ],
          };
        }));
      }
      return out;
    },
  };
}

export { addDays };
