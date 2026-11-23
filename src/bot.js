// Bot Telegram: promemoria (RG-18), /start con pulsante Mini App e comandi riservati admin (RT-24).

export function createBot({ token, adminIds = [], appUrl, log = console }) {
  const api = async (method, body) => {
    if (!token) { log.info?.(`[bot:dry-run] ${method}`, JSON.stringify(body)); return { ok: true, dry: true }; }
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    return res.json();
  };

  async function sendMessage(chatId, text, { openApp = false, html = false } = {}) {
    const body = { chat_id: chatId, text };
    if (html) body.parse_mode = 'HTML'; // il testo passato e' gia' HTML valido
    if (openApp && appUrl) body.reply_markup = { inline_keyboard: [[{ text: 'Apri il FantaChallenger 🎾', web_app: { url: appUrl } }]] };
    try {
      const r = await api('sendMessage', body);
      return Boolean(r.ok);
    } catch (e) {
      log.warn?.('sendMessage fallita', e.message);
      return false;
    }
  }

  async function sendDocument(chatId, filename, content, caption, mime = 'application/octet-stream') {
    if (!token) { log.info?.(`[bot:dry-run] sendDocument ${filename} (${content.length} byte)`); return true; }
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([content], { type: mime }), filename);
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
      return sendMessage(chatId, '<b>Benvenuto nel FantaChallenger di Un Podcast Sul Tennis</b>\n\nDimostra la tua conoscenza del tennis che conta!\n\nOgni settimana pronostica i vincitori dei tornei Challenger in corso.', { openApp: true, html: true });
    }
    if (cmd === '/help') {
      return sendMessage(chatId, [
        '<b>Regolamento</b>',
        '',
        '1. <b>Scegli il Capitano.</b> Il Capitano deve essere un giocatore fuori dalla top-200 ATP e resterà nella tua squadra per <b>12 settimane</b>. I suoi punti sono moltiplicati <b>×3</b>. Al termine potrai sceglierne un altro.',
        '2. <b>Ogni settimana scegli un giocatore per torneo.</b> Per ogni torneo Challenger in programma scegli un partecipante su cui puntare.',
        '3. <b>Bonus Underdog.</b> Se scegli un giocatore che non è testa di serie (riquadro x2) i punti che ottiene saranno moltiplicati <b>x2</b>.',
        '4. <b>Finestra di scelta.</b> Puoi selezionare i tuoi giocatori da lunedì alle 00:01 fino a martedì alle 15:00 (ora italiana). Poi la rosa sarà congelata fino alla settimana successiva.',
        '5. <b>Distribuzione punti.</b> Vincitore <b>10</b>, Finalista <b>5</b>, Semifinalista <b>2</b>.',
      ].join('\n'), { openApp: true, html: true });
    }
    if (!isAdmin(from)) return;
    if (cmd === '/quota' && args[0] === 'reset') {
      const r = await core.resetQuota(from);
      const q = await core.adminStatus();
      return sendMessage(chatId, `Contatore API di ${r.month} azzerato (cancellate ${r.cleared} chiamate). Quota: ${q.quota.used}/${q.quota.limit}.`);
    }
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
      const ok = await sendDocument(chatId, `UPST-FantaChallenger-${day}.xlsx`, r.xlsx, `Scelte e punti di ${r.rows} squadre su ${r.tournaments} tornei`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return ok ? undefined : sendMessage(chatId, '❌ Invio del file non riuscito, riprova.');
    }
    if (cmd === '/svuota') { // lancio: elimina TUTTE le squadre; richiede la conferma esplicita
      if (args[0] !== 'conferma') return sendMessage(chatId, '⚠️ Questo elimina definitivamente TUTTE le squadre (iscritti, capitani, rose e punti).\nPer procedere scrivi: /svuota conferma');
      const r = await core.deleteAllTeams(from);
      return sendMessage(chatId, `🧹 Eliminate ${r.removed} squadre. Ogni utente dovrà iscriversi di nuovo.`);
    }
    if (cmd === '/reset') { // elimina la TUA squadra (collaudo): alla prossima apertura rivedi l'iscrizione
      const r = await core.deleteTeam(from);
      await core.audit(from, 'bot:reset', r);
      return sendMessage(chatId, r.removed ? '🧹 La tua squadra è stata eliminata. Riapri il Mini App per rifare l\'iscrizione.' : 'Non hai ancora una squadra.', { openApp: Boolean(r.removed) });
    }
    if (cmd === '/demo') {
      if (args[0] === 'off') {
        const r = await core.removeDemoTeams();
        await core.audit(from, 'bot:demo-off', r);
        return sendMessage(chatId, `🧹 Squadre fittizie eliminate: ${r.removed}.`);
      }
      await sendMessage(chatId, '⏳ Creo le squadre fittizie…');
      const r = await core.seedDemoTeams({ count: 20 });
      await core.audit(from, 'bot:demo', r);
      return sendMessage(chatId, `✅ ${r.teams} squadre fittizie create.\nSettimana ${r.lastWeek}: ${r.lastWeekPicks} scelte (bloccate, con punti).\nSettimana ${r.thisWeek}: ${r.thisWeekPicks} scelte casuali.${r.importedDraws ? '\nImportati i partecipanti della settimana scorsa (quota API usata).' : ''}\nPer eliminarle: /demo off`);
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
