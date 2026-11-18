import crypto from 'node:crypto';

/**
 * Validazione dell'initData del Mini App (RT-20).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Ritorna { id, username, firstName, lastName } oppure lancia un Error.
 */
export function validateInitData(initData, botToken, { maxAgeSeconds = 86400, now = Date.now() } = {}) {
  if (!initData || !botToken) throw new Error('initData mancante');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('hash mancante');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('firma non valida');
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > maxAgeSeconds) throw new Error('initData scaduto');
  const user = JSON.parse(params.get('user') || 'null');
  if (!user?.id) throw new Error('utente mancante');
  return { id: String(user.id), username: user.username || null, firstName: user.first_name || '', lastName: user.last_name || '' };
}

/** RL-24: username Telegram, altrimenti nome pubblico. */
export function teamNameFor(u) {
  if (u.username) return u.username;
  const full = `${u.firstName} ${u.lastName}`.trim();
  return full || `Utente ${u.id.slice(-4)}`;
}

/** Utility per test: costruisce un initData firmato. */
export function signInitData(user, botToken, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}
