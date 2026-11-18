import { monthKey } from './time.js';

export class QuotaExhaustedError extends Error {
  constructor(used, limit) {
    super(`Quota API mensile esaurita (${used}/${limit})`);
    this.name = 'QuotaExhaustedError';
  }
}

/**
 * Wrapper unico per ogni chiamata a SportsAPI365 (RT-04, RT-08..RT-12, RT-27):
 * contatore mensile su DB, allarme all'80%, blocco a quota esaurita, retry limitati con backoff.
 */
export function createApiClient({ db, clock, notifyAdmins, limit = 150, alarmRatio = 0.8, maxRetries = 2, backoffMs = [1000, 3000] }) {
  async function used() {
    const row = await db.get('SELECT COUNT(*) AS n FROM api_calls WHERE ym = ?', [monthKey(clock())]);
    return row?.n ?? 0;
  }

  async function status() {
    const n = await used();
    return { used: n, limit, remaining: Math.max(0, limit - n), ratio: n / limit, month: monthKey(clock()) };
  }

  async function record(endpoint, ok, note) {
    const now = clock();
    await db.run('INSERT INTO api_calls (created_at, ym, endpoint, ok, note) VALUES (?, ?, ?, ?, ?)', [
      now.toISOString(), monthKey(now), endpoint, ok ? 1 : 0, note ?? null,
    ]);
    const st = await status();
    if (st.ratio >= alarmRatio) {
      const key = `quota_alarm_${st.month}`;
      const seen = await db.get('SELECT v FROM meta WHERE k = ?', [key]);
      if (!seen) {
        await db.run('INSERT INTO meta (k, v) VALUES (?, ?)', [key, now.toISOString()]);
        await notifyAdmins?.(`⚠️ Quota SportsAPI365 all'${Math.round(st.ratio * 100)}%: ${st.used}/${st.limit} chiamate questo mese.`);
      }
    }
  }

  /** `fn` esegue la richiesta HTTP. Ogni tentativo conta come una chiamata (il provider lo conteggia comunque). */
  async function request(endpoint, fn) {
    let attempt = 0;
    for (;;) {
      const n = await used();
      if (n >= limit) throw new QuotaExhaustedError(n, limit);
      try {
        const out = await fn();
        await record(endpoint, true);
        return out;
      } catch (e) {
        await record(endpoint, false, String(e.message ?? e).slice(0, 200));
        const retriable = !(e.status >= 400 && e.status < 500 && e.status !== 429);
        if (!retriable || attempt >= maxRetries) throw e;
        const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0;
        attempt++;
        if (wait) await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  return { request, status };
}
