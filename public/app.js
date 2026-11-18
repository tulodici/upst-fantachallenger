import { canAdd, tierOf, ROSTER_SIZE } from '/shared/rules.js';

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

// ------------------------------------------------------------------ utilità
const $app = document.getElementById('app');
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};

const devUser = new URLSearchParams(location.search).get('dev');
async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (tg?.initData) headers['x-telegram-init-data'] = tg.initData;
  else if (devUser) headers['x-dev-user'] = devUser;
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || 'Errore di rete'), { code: data.error, status: res.status, data });
  return data;
}

const fmtDateTime = (iso) => new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const posClass = (pos) => ({ top125: 't125', top200: 't200' }[tierOf(pos)] ?? '');

function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2800);
}
const confirmDialog = (msg) => new Promise((resolve) => (tg?.showConfirm ? tg.showConfirm(msg, resolve) : resolve(window.confirm(msg))));

// ------------------------------------------------------------------ stato
const S = { state: null, tab: 'team', sub: 'in-progress', players: {}, loading: true };

async function loadState() {
  S.state = await api('/api/state');
  S.loading = false;
}
async function getPlayers(mode) {
  const key = `${mode}:${S.state.weekStart}`;
  if (!S.players[key]) S.players[key] = (await api(`/api/players?mode=${mode}`)).players;
  return S.players[key];
}

// ------------------------------------------------------------------ regole (RG-12)
function rulesContent() {
  return h('ul', { class: 'rules' },
    h('li', {}, h('b', {}, 'Capitano: '), 'lo scegli all\'iscrizione tra i giocatori dal 201° al 900° posto. Resta lo stesso per tutta la stagione e i suoi punti valgono il doppio. Segna anche se non compili la rosa.'),
    h('li', {}, h('b', {}, 'Rosa: '), '7 giocatori ogni settimana, scelti tra i primi 900 del ranking ATP della settimana precedente. Al massimo 1 top-125 e 3 top-200 in totale (il top-125 conta tra i top-200).'),
    h('li', {}, h('b', {}, 'Orari: '), 'la rosa si modifica quante volte vuoi da lunedì 00:01 a martedì 15:00 (ora di Roma). Se non la compili resta vuota: non viene riportata quella della settimana prima.'),
    h('li', {}, h('b', {}, 'Punti: '), 'vincitore 10, finalista 5, semifinalista 2; il capitano 20 / 10 / 4. Contano solo i tornei ATP Challenger, anche per ritiro o walkover.'),
    h('li', {}, 'Un giocatore è selezionabile anche se non è in tabellone: se non gioca, non ci sono rimedi.'),
    h('li', {}, 'A pari punti si occupa la stessa posizione in classifica.'),
    h('li', {}, 'Le informazioni sui tabelloni sono aggiornate solo agli orari di importazione e possono essere incomplete per qualificati e lucky loser.'),
  );
}
function openRules() {
  const back = h('div', { class: 'sheet-back', onClick: (e) => e.target === back && back.remove() },
    h('div', { class: 'sheet' },
      h('header', {}, h('div', { class: 'row spread' }, h('h2', {}, 'Come si gioca'), h('button', { class: 'link', onClick: () => back.remove() }, 'Chiudi'))),
      h('div', { class: 'list', style: 'padding:0 16px 16px' }, rulesContent(),
        h('p', { class: 'muted' }, h('a', { href: '/privacy', target: '_blank', class: 'link' }, 'Informativa sulla privacy')))));
  document.body.append(back);
}

// ------------------------------------------------------------------ selettore giocatori
async function openPicker({ title, mode, current = [], captainId = null, replacing = null, onPick, onRemove }) {
  const players = await getPlayers(mode);
  const others = current.filter((p) => p.id !== replacing?.id).map((p) => p.pos);
  const back = h('div', { class: 'sheet-back', onClick: (e) => e.target === back && back.remove() });
  const list = h('div', { class: 'list' });
  const search = h('input', { type: 'search', placeholder: 'Cerca per nome o posizione…', autocomplete: 'off' });
  const STEP = 120;
  let limit = STEP;
  let tier = 'all';
  const TIERS = [['all', 'Tutti'], ['top125', 'Top-125'], ['top200', '126–200'], ['other', 'Oltre 200']];
  const chips = h('div', { class: 'chips' });
  const paintChips = () => chips.replaceChildren(...TIERS.map(([k, label]) =>
    h('button', { class: `chip ${tier === k ? 'on' : ''}`, onClick: () => { tier = k; limit = STEP; paintChips(); paint(); list.scrollTop = 0; } }, label)));

  function paint() {
    const q = search.value.trim().toLowerCase();
    const rows = players.filter((p) => (tier === 'all' || tierOf(p.pos) === tier)
      && (!q || p.name.toLowerCase().includes(q) || String(p.pos) === q || (p.country ?? '').toLowerCase() === q));
    const LIMIT = limit;
    list.replaceChildren(...[
      replacing && h('button', { class: 'item', onClick: () => { back.remove(); onRemove?.(replacing); } }, h('span', { class: 'tag-out' }, '✕  Rimuovi dalla rosa')),
      ...rows.slice(0, LIMIT).map((p) => {
        let verdict = { ok: true };
        if (mode === 'roster') {
          verdict = p.id === captainId ? { ok: false, reason: 'È il tuo capitano' }
            : current.some((c) => c.id === p.id && c.id !== replacing?.id) ? { ok: false, reason: 'Già in rosa' }
            : canAdd(others, p.pos);
        }
        const sub = mode === 'roster'
          ? (verdict.ok ? (p.tournament ? `🎾 ${p.tournament}${p.drawKind === 'qualifier' ? ' (qualificazioni)' : ''}` : 'non in tabellone') : verdict.reason)
          : (p.country ?? '');
        return h('button', { class: 'item', disabled: !verdict.ok, onClick: () => { back.remove(); onPick(p); } },
          h('span', { class: `pos ${posClass(p.pos)}` }, `#${p.pos}`),
          h('span', { class: 'grow' },
            h('div', { class: 'ellipsis', style: 'font-weight:600' }, p.name, p.country ? h('span', { class: 'small' }, `  ${p.country}`) : null),
            h('div', { class: `small ellipsis ${verdict.ok ? '' : 'tag-out'}` }, sub)));
      }),
      rows.length > LIMIT && h('button', { class: 'item', onClick: () => { limit += STEP; paint(); } }, h('span', { class: 'muted grow center', style: 'padding:6px' }, `Mostra altri ${Math.min(STEP, rows.length - LIMIT)} (${rows.length - LIMIT} rimanenti)`)),
      rows.length === 0 && h('div', { class: 'muted center' }, 'Nessun giocatore trovato'),
    ].filter(Boolean));
  }
  search.addEventListener('input', () => { limit = STEP; paint(); });
  list.addEventListener('scroll', () => { // caricamento progressivo
    if (list.scrollTop + list.clientHeight > list.scrollHeight - 240) {
      const q = search.value;
      if (list.querySelector('.item:last-child .muted')) { limit += STEP; paint(); }
    }
  });
  paintChips();
  back.append(h('div', { class: 'sheet' },
    h('header', {}, h('div', { class: 'row spread' }, h('h2', {}, title), h('button', { class: 'link', onClick: () => back.remove() }, 'Annulla')), search, mode === 'roster' ? chips : null),
    list));
  document.body.append(back);
  paint();
}

// ------------------------------------------------------------------ benvenuto / iscrizione (RG-10, RG-11)
function viewWelcome() {
  const st = S.state;
  const closed = !st.window.open;
  let chosen = null;
  const chosenBox = h('div', { class: 'slot empty', style: 'min-height:64px' }, '+ Scegli il tuo capitano');
  const go = h('button', { class: 'btn', disabled: true }, 'Conferma e inizia');

  chosenBox.addEventListener('click', () => openPicker({
    title: 'Scegli il capitano (201°–900°)', mode: 'captain',
    onPick: (p) => {
      chosen = p;
      chosenBox.className = 'slot captain';
      chosenBox.replaceChildren(h('span', { class: 'badge', style: 'align-self:flex-start' }, 'Capitano ×2'), h('span', { class: 'name' }, p.name), h('span', { class: 'small' }, `#${p.pos} · ${p.country ?? ''}`));
      go.disabled = false;
    },
  }));
  go.addEventListener('click', async () => {
    if (!chosen) return;
    if (!(await confirmDialog(`${chosen.name} sarà il tuo capitano per tutta la stagione e non potrà essere cambiato. Confermi?`))) return;
    go.disabled = true;
    try {
      S.state = await api('/api/register', { method: 'POST', body: { captainId: chosen.id } });
      render();
    } catch (e) { toast(e.message); go.disabled = false; }
  });

  return h('div', { class: 'page' },
    h('div', { class: 'hero' }, h('div', {}, h('div', { class: 'muted' }, 'Benvenuto in'), h('h1', {}, '🎾 upst-fantachallenger'))),
    h('div', { class: 'card' }, h('p', { style: 'margin:0' }, 'Ogni settimana scegli 7 giocatori e pronostichi i vincitori dei tornei ATP Challenger. Gioco gratuito, senza premi in denaro.')),
    closed && h('div', { class: 'notice' }, h('b', {}, 'Iscrizione a finestra chiusa. '),
      `La selezione della rosa è chiusa: finché non riapre${st.window.nextOpens ? ` (${fmtDateTime(st.window.nextOpens)})` : ''} segnerai solo con il capitano. Poi potrai comporre la rosa come tutti.`),
    !st.hasRanking && h('div', { class: 'notice' }, 'Il ranking non è ancora disponibile: riprova tra poco.'),
    h('div', { class: 'card' }, h('h3', { style: 'margin-bottom:8px' }, '1. Scegli il capitano'), chosenBox,
      h('p', { class: 'muted', style: 'margin-bottom:0' }, 'Fisso per tutta la stagione, punti doppi, anche se la rosa è vuota.')),
    go,
    h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'Le regole in breve'), rulesContent()),
  );
}

// ------------------------------------------------------------------ My Team (RG-04..RG-12)
function viewTeam() {
  const st = S.state;
  const open = st.window.open;
  const roster = st.roster.players;
  const cap = st.captain;

  async function save(ids) {
    try {
      const r = await api('/api/roster', { method: 'PUT', body: { playerIds: ids } });
      st.roster.playerIds = r.roster.playerIds;
      st.roster.players = r.roster.players;
      render();
    } catch (e) {
      toast(e.code === 'WINDOW_CLOSED' ? 'La finestra è appena stata chiusa' : e.message);
      await loadState(); render();
    }
  }
  const slots = Array.from({ length: ROSTER_SIZE }, (_, i) => {
    const p = roster[i];
    if (!p) {
      return h('button', { class: 'slot empty', disabled: !open, onClick: () => openPicker({
        title: 'Aggiungi un giocatore', mode: 'roster', current: roster, captainId: cap?.id,
        onPick: (np) => save([...roster.map((x) => x.id), np.id]),
      }) }, open ? '+ Scegli' : '—');
    }
    return h('button', { class: 'slot', disabled: !open, onClick: () => openPicker({
      title: 'Cambia giocatore', mode: 'roster', current: roster, captainId: cap?.id, replacing: p,
      onPick: (np) => save(roster.map((x) => (x.id === p.id ? np.id : x.id))),
      onRemove: () => save(roster.filter((x) => x.id !== p.id).map((x) => x.id)),
    }) },
      h('span', { class: 'name ellipsis' }, p.name),
      h('span', { class: 'row' }, h('span', { class: `pos ${posClass(p.pos)}` }, `#${p.pos}`),
        h('span', { class: `small ellipsis ${p.tournament ? '' : 'tag-out'}` }, p.tournament ? `🎾 ${p.tournament}` : 'non in tabellone')));
  });

  return h('div', { class: 'page' },
    h('div', { class: 'hero' },
      h('div', { class: 'grow' }, h('div', { class: 'muted' }, 'La tua squadra'), h('h1', { class: 'ellipsis' }, st.user.teamName)),
      h('div', { class: 'points' }, h('b', {}, st.points.total), h('span', { class: 'muted' }, 'punti')),
    ),
    h('div', { class: `status ${open ? 'open' : 'closed'}` }, h('span', { class: 'dot' }),
      h('div', { class: 'grow' },
        open ? h('div', {}, h('b', {}, 'Selezione aperta'), ` · chiude ${fmtDateTime(st.window.closes)}`)
          : h('div', {}, h('b', {}, 'Selezione chiusa'), ` · chiusa ${fmtDateTime(st.window.closes)}`, st.window.nextOpens ? h('div', { class: 'small' }, `Riapre ${fmtDateTime(st.window.nextOpens)}`) : null)),
      h('button', { class: 'link', onClick: openRules }, 'Regole')),
    st.captainOnlyNotice && h('div', { class: 'notice' }, h('b', {}, 'Stai segnando solo con il capitano. '),
      `Ti sei iscritto a finestra chiusa: la rosa si potrà comporre dalla prossima apertura${st.window.nextOpens ? ` (${fmtDateTime(st.window.nextOpens)})` : ''}.`), // RG-11
    !st.hasRanking && h('div', { class: 'notice' }, 'Ranking non ancora disponibile: i giocatori compariranno dopo il primo import.'),
    cap && h('div', { class: 'card captain' },
      h('div', { class: 'row spread' }, h('span', { class: 'badge' }, 'Capitano ×2'), h('span', { class: 'small' }, 'fisso per la stagione')),
      h('div', { style: 'font-weight:700;font-size:18px;margin-top:6px' }, cap.name),
      h('div', { class: 'small' }, [cap.pos ? `#${cap.pos}` : 'fuori dal ranking', cap.country].filter(Boolean).join(' · '))),
    h('div', { class: 'row spread', style: 'margin:4px 2px 8px' }, h('h3', {}, 'Rosa'), h('span', { class: 'muted' }, `${roster.length}/${ROSTER_SIZE}`)),
    h('div', { class: 'grid' }, slots),
    !open && roster.length === 0 && h('p', { class: 'muted center' }, 'Nessuna rosa per questa settimana.'),
    st.points.history.length > 0 && h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', { style: 'margin-bottom:6px' }, 'Punti per settimana'),
      ...st.points.history.map((x) => h('div', { class: 'row spread', style: 'padding:4px 0' }, h('span', {}, `Settimana del ${fmtDay(x.weekStart)}`), h('b', {}, `+${x.points}`)))),
  );
}

// ------------------------------------------------------------------ Tornei (RG-13..RG-15)
const ROUND = { winner: ['🏆', 'Vincitore'], finalist: ['🥈', 'Finalista'], semifinalist: ['🥉', 'Semifinalista'] };
const statusLabel = { scheduled: 'Programmato', in_progress: 'In corso', concluded: 'Concluso', cancelled: 'Annullato' };

function drawBlock(t) {
  if (!t.draw?.length) return null;
  const main = t.draw.filter((d) => d.kind !== 'qualifier');
  const qual = t.draw.filter((d) => d.kind === 'qualifier');
  return h('details', {}, h('summary', {}, `Tabellone (${main.length}${qual.length ? ` + ${qual.length} qualificati` : ''})`),
    h('div', { class: 'draw' }, ...main.map((d) => h('div', {}, d.name)), ...qual.map((d) => h('div', { class: 'muted' }, `${d.name} (Q)`))));
}
function tournamentCard(t, { stars = false } = {}) {
  const order = ['winner', 'finalist', 'semifinalist'];
  const res = [...(t.results ?? [])].sort((a, b) => order.indexOf(a.reached) - order.indexOf(b.reached));
  return h('div', { class: 'card' },
    h('div', { class: 'row spread' }, h('b', {}, t.name), t.status ? h('span', { class: 'small' }, statusLabel[t.status] ?? t.status) : null),
    t.location ? h('div', { class: 'small' }, t.location) : null,
    res.length ? h('div', { class: 'podium' }, ...res.map((r) => h('div', {}, `${ROUND[r.reached][0]} ${r.name}`, r.starred ? ' ⭐' : ''))) : null,
    drawBlock(t));
}

function viewTournaments() {
  const body = h('div', {}, h('div', { class: 'spin' }));
  const seg = h('div', { class: 'seg' }, ...[['completed', 'Completati'], ['in-progress', 'In corso'], ['next', 'Prossima sett.']].map(([k, label]) =>
    h('button', { class: S.sub === k ? 'on' : '', onClick: () => { S.sub = k; render(); } }, label)));

  (async () => {
    try {
      const d = await api(`/api/tournaments/${S.sub}`);
      if (S.sub === 'completed') {
        body.replaceChildren(...(d.weeks.length ? d.weeks.flatMap((w) => [h('div', { class: 'week-title' }, `Settimana del ${fmtDay(w.weekStart)}`), ...w.tournaments.map((t) => tournamentCard(t))])
          : [h('p', { class: 'muted center' }, 'Nessun torneo concluso finora.')]));
      } else if (S.sub === 'in-progress') {
        body.replaceChildren(
          h('p', { class: 'muted', style: 'margin:0 2px 10px' }, `Settimana del ${fmtDay(d.weekStart)} · `, d.updatedAt ? `ultimo aggiornamento ${fmtDateTime(d.updatedAt)}` : 'nessun aggiornamento ancora', ' · dati non live'),
          ...(d.tournaments.length ? d.tournaments.map((t) => tournamentCard(t)) : [h('p', { class: 'muted center' }, 'Nessun torneo importato per questa settimana.')]));
      } else {
        body.replaceChildren(
          h('p', { class: 'muted', style: 'margin:0 2px 10px' }, `Settimana del ${fmtDay(d.weekStart)}. Il tabellone è importato la domenica; qualificati e lucky loser potrebbero non comparire ancora.`),
          ...(d.tournaments.length ? d.tournaments.map((t) => tournamentCard(t)) : [h('p', { class: 'muted center' }, 'I tabelloni non sono ancora disponibili: arrivano la domenica.')]));
      }
    } catch (e) { body.replaceChildren(h('p', { class: 'muted center' }, e.message)); }
  })();
  return h('div', { class: 'page' }, h('div', { class: 'hero' }, h('h1', {}, 'Tornei')), seg, body);
}

// ------------------------------------------------------------------ League (RG-16, RG-17)
function viewLeague() {
  const body = h('div', {}, h('div', { class: 'spin' }));
  (async () => {
    try {
      const d = await api('/api/league');
      body.replaceChildren(d.rows.length
        ? h('div', { class: 'card', style: 'padding:4px 8px' }, h('table', { class: 'table' }, ...d.rows.map((r) =>
          h('tr', { class: r.id === d.me ? 'me' : '' }, h('td', { class: 'n' }, r.position), h('td', {}, r.teamName), h('td', { class: 'p' }, r.points)))))
        : h('p', { class: 'muted center' }, 'Nessun team iscritto.'));
      const mine = body.querySelector('tr.me');
      mine?.scrollIntoView({ block: 'center' });
    } catch (e) { body.replaceChildren(h('p', { class: 'muted center' }, e.message)); }
  })();
  return h('div', { class: 'page' }, h('div', { class: 'hero' }, h('h1', {}, 'Classifica')), body);
}

// ------------------------------------------------------------------ shell
function tabbar() {
  const tabs = [['team', '🎾', 'My Team'], ['tournaments', '🏟️', 'Tournaments'], ['league', '🏆', 'League']];
  return h('nav', { class: 'tabbar' }, ...tabs.map(([k, ico, label]) =>
    h('button', { class: S.tab === k ? 'on' : '', onClick: () => { S.tab = k; render(); window.scrollTo(0, 0); } }, h('span', { class: 'ico' }, ico), label)));
}

function render() {
  $app.replaceChildren();
  if (S.loading) { $app.append(h('div', { class: 'spin' })); return; }
  if (S.error) { $app.append(h('div', { class: 'page center' }, h('h2', {}, 'Qualcosa è andato storto'), h('p', { class: 'muted' }, S.error),
    h('button', { class: 'btn', onClick: boot }, 'Riprova'))); return; }
  if (!S.state.user) { $app.append(viewWelcome()); return; } // RG-11: schermata di benvenuto
  $app.append(S.tab === 'team' ? viewTeam() : S.tab === 'tournaments' ? viewTournaments() : viewLeague(), tabbar());
}

async function boot() {
  S.loading = true; S.error = null; render();
  try { await loadState(); } catch (e) {
    S.loading = false;
    S.error = e.status === 401 ? 'Apri l\'app da Telegram per giocare.' : e.message;
  }
  render();
}
boot();
