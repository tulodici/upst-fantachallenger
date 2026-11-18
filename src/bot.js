// Bot Telegram: promemoria (RG-18), /start con pulsante Mini App e comandi riservati admin (RT-24).

export function createBot({ token, adminIds = [], appUrl, log = console }) {
  const api = async (method, body) => {
    if (!token) { log.info?.(`[bot:dry-run] ${method}`, JSON.stringify(body)); return { ok: true, dry: true }; }
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    return res.json();
  };

  async function sendMessage(chatId, text, { openApp = false } = {}) {
    const body = { chat_id: chatId, text };
    if (openApp && appUrl) body.reply_markup = { inline_keyboard: [[{ text: '🎾 Apri upst-fantachallenger', web_app: { url: appUrl } }]] };
    try {
      const r = await api('sendMessage', body);
      return Boolean(r.ok);
    } catch (e) {
      log.warn?.('sendMessage fallita', e.message);
      return false;
    }
  }

  async function sendDocument(chatId, filename, content, caption) {
    if (!token) { log.info?.(`[bot:dry-run] sendDocument ${filename} (${content.length} caratteri)`); return true; }
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([content], { type: 'text/csv' }), filename);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
      return Boolean((await res.json()).ok);
    } catch (e) {
      log.warn?.('sendDocument fallita', e.message);
      return false;
    }
  }

  const notifyAdmins = async (text) => { for (const id of adminIds) await sendMessage(id, text); };
  const isAdmin = (telegramId) => adminIds.includes(String(telegramId));

  async function setup({ webhookUrl, secret }) {
    if (!token) return;
    if (webhookUrl) await api('setWebhook', { url: webhookUrl, secret_token: secret, allowed_updates: ['message'] });
    if (appUrl) await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Gioca', web_app: { url: appUrl } } });
  }

  /** Gestisce un update del webhook. `core` fornisce le azioni admin. */
  async function handleUpdate(update, core) {
    const msg = update.message;
    if (!msg?.text) return;
    const chatId = msg.chat.id;
    const [cmd, ...args] = msg.text.trim().split(/\s+/);
    const from = String(msg.from?.id);
    if (cmd === '/start') {
      return sendMessage(chatId, '🎾 Benvenuto in upst-fantachallenger! Pronostica i vincitori dei tornei ATP Challenger e scala la classifica.', { openApp: true });
    }
    if (!isAdmin(from)) return;
    if (cmd === '/quota') {
      const q = await core.adminStatus();
      return sendMessage(chatId, `Quota API ${q.quota.month}: ${q.quota.used}/${q.quota.limit} (restano ${q.quota.remaining}).`);
    }
    if (cmd === '/stato') {
      const q = await core.adminStatus();
      const jobs = q.jobs.slice(0, 6).map((j) => `${j.job} ${j.run_key}: ${j.status}${j.status === 'done' ? '' : ' – ' + String(j.message).slice(0, 80)}`).join('\n');
      return sendMessage(chatId, `Provider: ${q.provider}\nGiocatori: ${q.players} · Tornei: ${q.tournaments} · Iscritti: ${q.users}\nUltimo ranking: ${q.lastRankingWeek ?? '—'}\nQuota API: ${q.quota.used}/${q.quota.limit}\n\n${jobs || 'Nessun job eseguito'}`);
    }
    if (cmd === '/scelte') {
      const r = await core.adminPicksReport();
      await core.audit(from, 'bot:scelte', { rows: r.rows });
      const day = new Date().toISOString().slice(0, 10);
      const ok = await sendDocument(chatId, `scelte-${day}.csv`, r.csv, `Scelte e punti di tutti, settimana per settimana (${r.rows} righe)`);
      return ok ? undefined : sendMessage(chatId, '❌ Invio del file non riuscito, riprova.');
    }
    if (cmd === '/ricalcola') {
      await core.recomputePoints();
      await core.audit(from, 'bot:ricalcola');
      return sendMessage(chatId, '✅ Punti ricalcolati per tutti gli utenti.');
    }
    if (cmd === '/import') {
      const [job, key] = args;
      if (!job) return sendMessage(chatId, 'Uso: /import <draws|results|ranking|recheck|close> [YYYY-MM-DD lunedì]');
      const r = await core.runJob(job, key ?? core.defaultKey(job), { force: true, actor: `bot:${from}` });
      return sendMessage(chatId, r.ok ? `✅ ${job} completato` : `❌ ${job}: ${r.error ?? 'errore'}`);
    }
  }

  return { sendMessage, sendDocument, notifyAdmins, isAdmin, setup, handleUpdate };
}
