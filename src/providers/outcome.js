// Ricava vincitore / finalista / semifinalisti di un torneo dalle sole partite decise, senza dipendere
// dalla mappatura dei roundId (non documentata). In caso di dubbio NON indovina: segnala un'anomalia
// e il torneo resta "in_progress" (correzione manuale da admin, RL-27).
//
// Ogni partita: { date, roundId, winnerId, loserId } (id come stringhe).

const byDate = (a, b) => new Date(a.date) - new Date(b.date) || String(a.id ?? '').localeCompare(String(b.id ?? ''));

export function deriveOutcome(matches) {
  const ms = [...matches].sort(byDate);
  if (ms.length < 3) return pending('troppe poche partite');

  // La finale e' l'ultima partita giocata (vale anche per un lucky loser, che ha una sconfitta nelle quali).
  const final = ms.at(-1);
  const W = final.winnerId;
  const F = final.loserId;

  // Nel torneo concluso l'unico giocatore la cui ultima partita e' una vittoria e' il vincitore.
  const last = new Map();
  for (const m of ms) {
    last.set(m.winnerId, 'W');
    last.set(m.loserId, 'L');
  }
  const alive = [...last].filter(([, r]) => r === 'W').map(([p]) => p);
  if (alive.length !== 1 || alive[0] !== W) {
    return pending(`torneo non concluso o dati incompleti (${alive.length} giocatori ancora in corsa)`);
  }

  const mine = (p) => ms.filter((m) => m.winnerId === p || m.loserId === p);
  const wm = mine(W);
  const fm = mine(F);
  if (wm.length < 3) return pending('il presunto vincitore ha meno di 3 partite');
  const sfW = wm.at(-2); // partita precedente alla finale del vincitore
  const sfF = fm.at(-2); // partita precedente alla finale del finalista
  if (!sfW || !sfF || sfW.winnerId !== W || sfF.winnerId !== F) return pending('semifinali non ricostruibili');
  if (sfW.roundId == null || sfW.roundId !== sfF.roundId || sfW.roundId === final.roundId) {
    return pending('semifinali incoerenti (possibile walkover non registrato)');
  }
  const semis = [sfW.loserId, sfF.loserId];
  if (new Set([W, F, ...semis]).size !== 4) return pending('giocatori duplicati nelle semifinali');

  return {
    status: 'concluded',
    results: [
      { playerId: W, reached: 'winner' },
      { playerId: F, reached: 'finalist' },
      { playerId: semis[0], reached: 'semifinalist' },
      { playerId: semis[1], reached: 'semifinalist' },
    ],
  };
}

const pending = (anomaly) => ({ status: 'in_progress', results: [], anomaly });
