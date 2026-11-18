import { openDb } from '../src/db.js';
import { createCore } from '../src/core.js';
import { createApiClient } from '../src/apiClient.js';
import { createMockProvider } from '../src/providers/mock.js';
import { romeToUtc } from '../src/time.js';

/** Core con DB SQLite in memoria, provider mock e orologio controllabile. */
export async function makeCore({ startAt = romeToUtc('2026-11-23', 10, 0), provider = createMockProvider(), apiOptions = {} } = {}) {
  let current = startAt;
  const clock = () => current;
  const db = await openDb();
  const sent = [];
  const bot = {
    sendMessage: async (id, text) => { sent.push({ id, text }); return true; },
    notifyAdmins: async (text) => { sent.push({ admin: true, text }); },
  };
  const api = createApiClient({ db, clock, notifyAdmins: bot.notifyAdmins, backoffMs: [0], ...apiOptions });
  const core = createCore({ db, provider, api, bot, clock, config: {} });
  return {
    core, db, api, sent, provider,
    setNow: (d) => { current = d; },
    at: (date, hh, mm = 0) => { current = romeToUtc(date, hh, mm); },
  };
}
