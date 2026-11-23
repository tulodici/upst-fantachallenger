// Regole di gioco pure (RL-xx). Condivise tra backend e Mini App: nessuna dipendenza da Node o dal browser.

// Vincoli top-125/top-200 (RL-11): non attivi sulla rosa per torneo, tenuti per un eventuale ripristino.
export const MAX_TOP125 = 1;
export const MAX_TOP200 = 3; // il top-125 e' incluso nel conteggio (RL-11)
export const POOL_SIZE = 900;
export const CAPTAIN_MIN_POS = 201;
export const CAPTAIN_MAX_POS = 900;
export const POINTS = { winner: 10, finalist: 5, semifinalist: 2 };

export function tierOf(pos) {
  if (!Number.isInteger(pos) || pos < 1 || pos > POOL_SIZE) return 'none';
  if (pos <= 125) return 'top125';
  if (pos <= 200) return 'top200';
  return 'other';
}

export function inPool(pos) {
  return Number.isInteger(pos) && pos >= 1 && pos <= POOL_SIZE;
}

export const CAPTAIN_WEEKS = 12; // durata del mandato del Capitano, dalla settimana di inizio

export function isCaptainEligible(pos) {
  return Number.isInteger(pos) && pos >= CAPTAIN_MIN_POS && pos <= CAPTAIN_MAX_POS;
}

export const CAPTAIN_MULTIPLIER = 3;
export const UNDERDOG_MULTIPLIER = 2;

/**
 * Punti per round raggiunto. Il capitano vale x3; una scelta settimanale fuori dalle teste di serie ("underdog") vale x2.
 * I due bonus non si cumulano: se e' il capitano si applica solo il x3.
 */
export function pointsFor(reached, isCaptain = false, underdog = false) {
  const base = POINTS[reached] ?? 0;
  if (isCaptain) return base * CAPTAIN_MULTIPLIER;
  return underdog ? base * UNDERDOG_MULTIPLIER : base;
}

function counts(positions) {
  let top125 = 0;
  let top200 = 0;
  for (const p of positions) {
    const t = tierOf(p);
    if (t === 'top125') { top125++; top200++; }
    else if (t === 'top200') top200++;
  }
  return { top125, top200 };
}

/**
 * Si puo' aggiungere un giocatore di posizione `pos` a una rosa con le posizioni `current`?
 * Restituisce { ok, code, reason } (reason in italiano, mostrato in app: RG-08).
 */
export function canAdd(current, pos) {
  const tier = tierOf(pos);
  if (tier === 'none') {
    return { ok: false, code: 'NOT_IN_POOL', reason: 'Fuori dai primi 900 del ranking' };
  }
  const c = counts(current);
  if (tier === 'top125' && c.top125 >= MAX_TOP125) {
    return { ok: false, code: 'TOP125_LIMIT', reason: 'Hai già un top-125 in rosa' };
  }
  if ((tier === 'top125' || tier === 'top200') && c.top200 >= MAX_TOP200) {
    return { ok: false, code: 'TOP200_LIMIT', reason: 'Limite di 3 top-200 raggiunto' };
  }
  return { ok: true };
}

/**
 * Validazione di una rosa "per torneo": un solo giocatore per torneo, scelto tra i suoi partecipanti.
 * `tournaments` = [{ id, playerIds }]. I vincoli di classifica (top-125 / top-200, canAdd) non sono attivi sui giocatori
 * della rosa; restano solo per il capitano (isCaptainEligible).
 * Ritorna { ok, errors: [{ code, playerId?, message }] }.
 */
export function validatePicks(playerIds, { tournaments = [], captainId = null, allowCaptainInRoster = false } = {}) {
  const errors = [];
  const seen = new Set();
  const used = new Set();
  for (const id of playerIds) {
    if (seen.has(id)) { errors.push({ code: 'DUPLICATE', playerId: id, message: 'Giocatore ripetuto' }); continue; }
    seen.add(id);
    if (!allowCaptainInRoster && captainId != null && id === captainId) {
      errors.push({ code: 'IS_CAPTAIN', playerId: id, message: 'Il capitano non puo\' stare anche in rosa' });
      continue;
    }
    const t = tournaments.find((x) => !used.has(x.id) && x.playerIds.includes(id));
    if (t) { used.add(t.id); continue; }
    errors.push(tournaments.some((x) => x.playerIds.includes(id))
      ? { code: 'ONE_PER_TOURNAMENT', playerId: id, message: 'Un solo giocatore per torneo' }
      : { code: 'NOT_A_PARTICIPANT', playerId: id, message: 'Il giocatore non partecipa a nessun torneo di questa settimana' });
  }
  return { ok: errors.length === 0, errors };
}

/** RL-22/RL-23: classifica con pari merito (1,1,3). Le righe devono essere gia' ordinate per punti decrescenti. */
export function withPositions(rows, key = 'points') {
  let prevPoints = null;
  let prevPos = 0;
  return rows.map((row, i) => {
    const position = row[key] === prevPoints ? prevPos : i + 1;
    prevPoints = row[key];
    prevPos = position;
    return { ...row, position };
  });
}
