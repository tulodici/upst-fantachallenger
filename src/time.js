// Gestione date nel fuso Europe/Rome (RT-05). Tutte le funzioni ricevono `now` esplicito: niente orologio nascosto.

export const TZ = 'Europe/Rome';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function romeParts(date) {
  const o = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  const dow = new Date(Date.UTC(o.year, o.month - 1, o.day)).getUTCDay(); // 0 = domenica
  return { y: o.year, m: o.month, d: o.day, hh: o.hour, mm: o.minute, ss: o.second, dow: dow === 0 ? 7 : dow };
}

const pad = (n) => String(n).padStart(2, '0');

export function romeDateStr(date) {
  const p = romeParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Lunedi' (YYYY-MM-DD) della settimana, in ora di Roma, che contiene `date`. */
export function mondayOf(date) {
  const p = romeParts(date);
  return addDays(`${p.y}-${pad(p.m)}-${pad(p.d)}`, -(p.dow - 1));
}

export function dayOfWeekOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

function offsetMinutes(utcMs) {
  const p = romeParts(new Date(utcMs));
  return (Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - utcMs) / 60000;
}

/** Istante UTC corrispondente all'ora locale di Roma `dateStr hh:mm`. Gestisce l'ora legale. */
export function romeToUtc(dateStr, hh, mm = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMinutes(guess) * 60000;
  const off2 = offsetMinutes(t);
  t = guess - off2 * 60000;
  return new Date(t);
}

/** Finestra di selezione della settimana `weekStart`: lunedi' 00:01 – martedi' 15:00 (RL-13). */
export function windowOf(weekStart) {
  return { opens: romeToUtc(weekStart, 0, 1), closes: romeToUtc(addDays(weekStart, 1), 15, 0) };
}

export function windowState(now) {
  const weekStart = mondayOf(now);
  const { opens, closes } = windowOf(weekStart);
  return { weekStart, opens, closes, open: now >= opens && now < closes };
}

export function monthKey(now) {
  const p = romeParts(now);
  return `${p.y}-${pad(p.m)}`;
}
