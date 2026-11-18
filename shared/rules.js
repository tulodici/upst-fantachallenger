// Regole di gioco pure (RL-xx). Condivise tra backend e Mini App: nessuna dipendenza da Node o dal browser.

export const ROSTER_SIZE = 7;
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

export function isCaptainEligible(pos) {
  return Number.isInteger(pos) && pos >= CAPTAIN_MIN_POS && pos <= CAPTAIN_MAX_POS;
}

/** RL-17..RL-20: punti per round raggiunto, raddoppiati per il capitano. */
export function pointsFor(reached, isCaptain = false) {
  const base = POINTS[reached] ?? 0;
  return isCaptain ? base * 2 : base;
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
  if (current.length >= ROSTER_SIZE) {
    return { ok: false, code: 'FULL', reason: 'Rosa completa (7 giocatori)' };
  }
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
 * Validazione completa di una rosa (RT-15). `entries` = [{ id, pos }], pos = ranking di riferimento o null.
 * Ritorna { ok, errors: [{ code, playerId?, message }] }.
 */
export function validateRoster(entries, { captainId = null, allowCaptainInRoster = false } = {}) {
  const errors = [];
  if (entries.length > ROSTER_SIZE) {
    errors.push({ code: 'TOO_MANY', message: `Massimo ${ROSTER_SIZE} giocatori` });
  }
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) errors.push({ code: 'DUPLICATE', playerId: e.id, message: 'Giocatore ripetuto' });
    seen.add(e.id);
    if (!inPool(e.pos)) {
      errors.push({ code: 'NOT_IN_POOL', playerId: e.id, message: 'Giocatore fuori dal pool (top 900)' });
    }
    if (!allowCaptainInRoster && captainId != null && e.id === captainId) {
      errors.push({ code: 'IS_CAPTAIN', playerId: e.id, message: 'Il capitano non puo\' stare anche in rosa' });
    }
  }
  const c = counts(entries.map((e) => e.pos));
  if (c.top125 > MAX_TOP125) errors.push({ code: 'TOP125_LIMIT', message: 'Massimo 1 giocatore top-125' });
  if (c.top200 > MAX_TOP200) errors.push({ code: 'TOP200_LIMIT', message: 'Massimo 3 giocatori top-200 in totale' });
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
