import { tierOf } from '/shared/rules.js';
import { flag } from '/flags.js';

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
async function getPlayers(mode) { // solo capitano: lista 201–900
  const key = `${mode}:${S.state.weekStart}`;
  if (!S.players[key]) S.players[key] = (await api(`/api/players?mode=${mode}`)).players;
  return S.players[key];
}
const getTournamentOptions = async () => (await api('/api/players?mode=roster')).tournaments; // sempre aggiornato

// ------------------------------------------------------------------ regole (RG-12)
function rulesContent() {
  return h('ul', { class: 'rules' },
    h('li', {}, h('b', {}, 'Capitano: '), 'lo scegli all\'iscrizione tra i giocatori dal 201° al 900° posto. Resta lo stesso per tutta la stagione e i suoi punti valgono il triplo (x3). Segna anche se non compili la rosa.'),
    h('li', {}, h('b', {}, 'Bonus Underdog: '), 'se un giocatore che hai scelto per un torneo non è testa di serie (compresi qualificati e wild card) e arriva a podio, i suoi punti valgono il doppio (x2). Non si cumula con il bonus Capitano.'),
    h('li', {}, h('b', {}, 'Rosa: '), 'ogni settimana scegli un giocatore per ciascun torneo Challenger, tra i partecipanti del torneo. Puoi saltare un torneo: il numero di giocatori in rosa cambia di settimana in settimana.'),
    h('li', {}, h('b', {}, 'Orari: '), 'la rosa si modifica quante volte vuoi da lunedì 00:01 a martedì 15:00 (ora di Roma). Se non la compili resta vuota: non viene riportata quella della settimana prima.'),
    h('li', {}, h('b', {}, 'Punti: '), 'vincitore 10, finalista 5, semifinalista 2; il capitano 20 / 10 / 4. Contano solo i tornei ATP Challenger, anche per ritiro o walkover.'),
    h('li', {}, 'Se un giocatore scelto non gioca (ritiro, forfait), non ci sono rimedi.'),
    h('li', {}, 'A pari punti si occupa la stessa posizione in classifica.'),
    h('li', {}, 'Le informazioni sui tabelloni sono aggiornate solo agli orari di importazione e possono essere incomplete per qualificati e lucky loser.'),
  );
}
// Regolamento breve della schermata di benvenuto.
function regolamentoBreve() {
  const li = (title, text) => h('li', {}, h('b', {}, `${title} `), text);
  return h('ol', { class: 'rules' },
    li('Scegli il capitano.', 'All’iscrizione scegli un giocatore fuori dalla top-200 ATP. Resterà nella tua squadra per tutta la stagione e i suoi punti valgono ×3.'),
    li('Ogni settimana scegli un giocatore per torneo.', 'Per ogni torneo Challenger in programma scegli un partecipante su cui puntare.'),
    li('Bonus Underdog.', 'Se scegli un giocatore che non è testa di serie (riquadro x2) i punti che ottiene valgono x2.'),
    li('Finestra di scelta.', 'Le scelte possono essere fatte da lunedì alle 00:01 a martedì alle 15:00 (ora italiana). Poi la rosa sarà congelata fino alla settimana successiva.'),
    li('Distribuzione punti.', 'Vincitore 10, Finalista 5, Semifinalista 2.'),
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

// ------------------------------------------------------------------ selettore capitano (201–900)
async function openPicker({ title, mode, onPick }) {
  const players = await getPlayers(mode);
  const back = h('div', { class: 'sheet-back', onClick: (e) => e.target === back && back.remove() });
  const list = h('div', { class: 'list' });
  const search = h('input', { type: 'search', placeholder: 'Cerca per nome o posizione…', autocomplete: 'off' });
  const STEP = 120;
  let limit = STEP;

  function paint() {
    const q = search.value.trim().toLowerCase();
    const rows = players.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.pos) === q || (p.country ?? '').toLowerCase() === q);
    list.replaceChildren(...[
      ...rows.slice(0, limit).map((p) => h('button', { class: 'item', onClick: () => { back.remove(); onPick(p); } },
        h('span', { class: `pos ${posClass(p.pos)}` }, `#${p.pos}`),
        h('span', { class: 'grow' }, h('div', { class: 'ellipsis', style: 'font-weight:600' }, p.country ? `${flag(p.country)} ` : null, p.name)))),
      rows.length > limit && h('button', { class: 'item', onClick: () => { limit += STEP; paint(); } }, h('span', { class: 'muted grow center', style: 'padding:6px' }, `Mostra altri ${Math.min(STEP, rows.length - limit)} (${rows.length - limit} rimanenti)`)),
      rows.length === 0 && h('div', { class: 'muted center' }, 'Nessun giocatore trovato'),
    ].filter(Boolean));
  }
  search.addEventListener('input', () => { limit = STEP; paint(); });
  back.append(h('div', { class: 'sheet' },
    h('header', {}, h('div', { class: 'row spread' }, h('h2', {}, title), h('button', { class: 'link', onClick: () => back.remove() }, 'Annulla')), search),
    list));
  document.body.append(back);
  paint();
}

// ------------------------------------------------------------------ selettore per torneo (1 giocatore per torneo)
const entryTag = (p) => (p.seed != null ? `[${p.seed}]` : p.entry ?? '');
async function openTournamentPicker({ tournament, selectedId, captainId, onPick, onRemove }) {
  const back = h('div', { class: 'sheet-back', onClick: (e) => e.target === back && back.remove() });
  const list = h('div', { class: 'list' });
  const search = h('input', { type: 'search', placeholder: 'Cerca un giocatore…', autocomplete: 'off' });
  const hint = tournament.seedsKnown ? h('div', { class: 'small', style: 'margin-top:6px' }, 'Il riquadro x2 indica un giocatore non testa di serie: se arriva a podio i suoi punti valgono il doppio (Bonus Underdog).') : null;
  function paint() {
    const q = search.value.trim().toLowerCase();
    const rows = tournament.participants.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.country ?? '').toLowerCase() === q);
    list.replaceChildren(...[
      selectedId && h('button', { class: 'item', onClick: () => { back.remove(); onRemove(); } }, h('span', { class: 'tag-out' }, '✕  Rimuovi dalla rosa')),
      ...rows.map((p) => {
        const isCap = p.playerId === captainId;
        return h('button', { class: `item ${p.playerId === selectedId ? 'sel' : ''}`, disabled: isCap, onClick: () => { back.remove(); onPick(p); } },
          h('span', { style: 'display:inline-block;min-width:38px;font-weight:600' }, entryTag(p)),
          h('span', { class: 'grow' }, h('div', { class: 'ellipsis', style: 'font-weight:600' }, p.country ? `${flag(p.country)} ` : null, p.name),
            isCap ? h('div', { class: 'small tag-out' }, 'È il tuo capitano') : null),
          tournament.seedsKnown && p.seed == null ? h('span', { class: 'pill' }, 'x2') : null,
          p.playerId === selectedId ? h('span', {}, '✓') : null);
      }),
      rows.length === 0 && h('div', { class: 'muted center' }, tournament.participants.length ? 'Nessun giocatore trovato' : 'Partecipanti non ancora disponibili'),
    ].filter(Boolean));
  }
  search.addEventListener('input', paint);
  back.append(h('div', { class: 'sheet' },
    h('header', {}, h('div', { class: 'row spread' }, h('h2', { class: 'ellipsis' }, tournament.name), h('button', { class: 'link', onClick: () => back.remove() }, 'Annulla')), search, hint),
    list));
  document.body.append(back);
  paint();
}

// ------------------------------------------------------------------ benvenuto / iscrizione (RG-10, RG-11)
function viewWelcome() {
  const st = S.state;
  const closed = !st.window.open;
  let chosen = null;
  const chosenBox = h('div', { class: 'slot empty', style: 'min-height:64px' }, '+ Seleziona il tuo Capitano');
  const go = h('button', { class: 'btn', disabled: true }, 'Conferma e inizia');

  chosenBox.addEventListener('click', () => openPicker({
    title: 'Scegli il capitano (201°–900°)', mode: 'captain',
    onPick: (p) => {
      chosen = p;
      chosenBox.className = 'slot captain';
      chosenBox.replaceChildren(h('span', { class: 'badge', style: 'align-self:flex-start' }, 'Capitano ×3'), h('span', { class: 'name' }, p.name), h('span', { class: 'small' }, `#${p.pos}${p.country ? ` · ${flag(p.country)}` : ''}`));
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
    closed && h('div', { class: 'notice' }, h('b', {}, 'Iscrizione a finestra chiusa. '),
      `La selezione della rosa è chiusa: finché non riapre${st.window.nextOpens ? ` (${fmtDateTime(st.window.nextOpens)})` : ''} segnerai solo con il capitano. Poi potrai comporre la rosa come tutti.`),
    !st.hasRanking && h('div', { class: 'notice' }, 'Il ranking non è ancora disponibile: riprova tra poco.'),
    h('div', { class: 'card' }, h('h3', { style: 'margin-bottom:8px' }, '1. Scegli il Capitano'), chosenBox,
      h('p', { class: 'muted', style: 'margin-bottom:0' }, 'Il Capitano rimarrà nella tua squadra per tutta la stagione e riceverà punti moltiplicati x3, ma deve essere fuori dalla top-200 del ranking ATP attuale.')),
    go,
    h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'Regolamento'), regolamentoBreve()),
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
  const tournaments = st.tournaments ?? [];
  const pickOf = (t) => roster.find((p) => p.tournamentId === t.id);
  const orphans = roster.filter((p) => !tournaments.some((t) => t.id === p.tournamentId)); // giocatori non piu' in nessun torneo
  const cards = tournaments.map((t) => {
    const p = pickOf(t);
    return h('button', { class: `slot ${p ? '' : 'empty'}`, disabled: !open, onClick: async () => {
      let opts;
      try { opts = (await getTournamentOptions()).find((x) => x.id === t.id); } catch (e) { return toast(e.message); }
      if (!opts) return toast('Torneo non disponibile');
      openTournamentPicker({
        tournament: opts, selectedId: p?.id ?? null, captainId: cap?.id,
        onPick: (np) => save([...roster.filter((x) => x.id !== p?.id).map((x) => x.id), np.playerId]),
        onRemove: () => save(roster.filter((x) => x.id !== p?.id).map((x) => x.id)),
      });
    } },
      h('span', { class: 'small ellipsis' }, `🎾 ${t.name}${t.location ? ` · ${t.location}` : ''}`),
      p ? h('span', { class: 'name ellipsis' }, p.name, entryTag(p) ? h('span', { class: 'small' }, `  ${entryTag(p)}`) : null, p.underdog ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'x2') : null) : h('span', {}, open ? '+ Scegli un giocatore' : '—'));
  });
  for (const p of orphans) cards.push(h('div', { class: 'slot' }, h('span', { class: 'small tag-out' }, 'Torneo non più disponibile'), h('span', { class: 'name ellipsis' }, p.name)));

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
        cap && h('div', { class: 'card captain' },
      h('div', { class: 'row spread' }, h('span', { class: 'badge' }, 'Capitano ×3'), h('span', { class: 'small' }, 'fisso per la stagione')),
      h('div', { style: 'font-weight:700;font-size:18px;margin-top:6px' }, cap.name),
      h('div', { class: 'small' }, [cap.pos ? `#${cap.pos}` : 'fuori dal ranking', cap.country ? flag(cap.country) : null].filter(Boolean).join(' · '))),
    h('div', { class: 'row spread', style: 'margin:4px 2px 8px' }, h('h3', {}, 'Rosa'), h('span', { class: 'muted' }, `${roster.length}/${tournaments.length} tornei`)),
    tournaments.length === 0 && h('p', { class: 'muted center' }, 'I tornei di questa settimana non sono ancora disponibili.'),
    h('div', { class: 'cards' }, cards),
    !open && roster.length === 0 && h('p', { class: 'muted center' }, 'Nessuna rosa per questa settimana.'),
    st.points.history.length > 0 && h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', { style: 'margin-bottom:6px' }, 'Punti per settimana'),
      ...st.points.history.map((x) => h('div', { class: 'row spread', style: 'padding:4px 0' }, h('span', {}, `Settimana del ${fmtDay(x.weekStart)}`), h('b', {}, `+${x.points}`)))),
  );
}

// ------------------------------------------------------------------ Tornei (RG-13..RG-15)
const ROUND = { winner: ['🏆', 'Vincitore'], finalist: ['🥈', 'Finalista'], semifinalist: ['🥉', 'Semifinalista'] };
const statusLabel = { scheduled: 'Programmato', in_progress: 'In corso', concluded: 'Concluso', cancelled: 'Annullato' };

function participantsBlock(t) {
  if (!t.participants?.length) return null;
  const tag = (p) => (p.seed != null ? `[${p.seed}]` : p.entry ?? '');
  return h('details', {}, h('summary', {}, `Partecipanti (${t.participants.length})`),
    h('div', { class: 'draw' }, ...t.participants.map((p) => h('div', {},
      p.seed != null || p.entry ? h('span', { style: 'display:inline-block;min-width:34px;font-weight:600' }, tag(p)) : h('span', { style: 'display:inline-block;min-width:34px' }), p.name))));
}
function mineBlock(t) {
  if (!t.mine) return null;
  const row = (icon, x, emptyText) => h('div', { class: 'row spread mine-row' },
    h('span', { class: 'ellipsis' }, `${icon} `, x ? `${x.country ? `${flag(x.country)} ` : ''}${x.name}` : emptyText,
      x ? h('span', { class: 'small' }, `  ${x.reached ? ROUND[x.reached][1] : 'fuori dal podio'}${x.underdog ? ' · Underdog x2' : ''}`) : null),
    h('b', { class: x?.points ? 'pts-on' : '' }, x ? `+${x.points}` : '0'));
  return h('div', { class: 'mine' }, row('🎯', t.mine.pick, 'Nessuna scelta'), t.mine.captain ? row('👑', t.mine.captain) : null);
}
function tournamentCard(t, { stars = false } = {}) {
  const order = ['winner', 'finalist', 'semifinalist'];
  const res = [...(t.results ?? [])].sort((a, b) => order.indexOf(a.reached) - order.indexOf(b.reached));
  return h('div', { class: 'card' },
    h('div', { class: 'row spread' }, h('b', {}, t.name), t.status ? h('span', { class: 'small' }, statusLabel[t.status] ?? t.status) : null),
    t.location ? h('div', { class: 'small' }, t.location) : null,
    res.length ? h('div', { class: 'podium' }, ...res.map((r) => h('div', {}, `${ROUND[r.reached][0]} ${r.name}`, r.starred ? ' ⭐' : ''))) : null,
    mineBlock(t),
    participantsBlock(t));
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
          h('tr', { class: r.id === d.me ? 'me' : '' }, h('td', { class: 'n' }, r.position), h('td', {}, h('div', {}, r.teamName), r.captainName ? h('div', { class: 'small' }, `👑 ${r.captainName}`) : null), h('td', { class: 'p' }, r.points)))))
        : h('p', { class: 'muted center' }, 'Nessun team iscritto.'));
      const mine = body.querySelector('tr.me');
      mine?.scrollIntoView({ block: 'center' });
    } catch (e) { body.replaceChildren(h('p', { class: 'muted center' }, e.message)); }
  })();
  return h('div', { class: 'page' }, h('div', { class: 'hero' }, h('h1', {}, 'Classifica')), body);
}

// ------------------------------------------------------------------ shell
function tabbar() {
  const tabs = [['team', '🎾', 'Team'], ['tournaments', '🏟️', 'Tornei'], ['league', '🏆', 'Classifica']];
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
