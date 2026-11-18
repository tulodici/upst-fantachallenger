# upst-fantachallenger

Fantasy game di tennis ATP Challenger come Telegram Mini App (documento di requisiti v1.0).
Node 22, nessun framework: backend HTTP + job schedulati, PostgreSQL, frontend vanilla in italiano.

## Avvio locale
```
npm run dev      # mock API + SQLite in memoria + dati demo, orologio fissato a lunedì 23/11/2026
                 # apri http://localhost:3000/?dev=42 (utente di test, solo fuori produzione)
npm test         # 18 test: regole, fuso orario, HMAC, flusso settimanale, quota API, HTTP
```

## Deploy su Railway
1. Repo su GitHub → nuovo progetto Railway da repo; aggiungi il plugin **PostgreSQL** (imposta `DATABASE_URL`).
2. Imposta le variabili di `.env.example` (`BOT_TOKEN`, `PUBLIC_URL`, `ADMIN_TELEGRAM_IDS`, SportsAPI365).
3. All'avvio il bot registra webhook e pulsante Mini App. Le tabelle si creano da sole.
4. **Primo avvio:** il job `ranking` (lunedì 12:00 o `/import ranking`) copia il ranking come riferimento, così il gioco parte subito.
5. Consigliato: secondo servizio Railway "staging" con DB separato (RT-02).

## Mappa dei requisiti
| Area | Dove |
|---|---|
| Regole RL-xx (vincoli, punti, classifica) | `shared/rules.js` (usato anche dal frontend) |
| Finestra lun 00:01 – mar 15:00, Europe/Rome | `src/time.js` |
| Rosa, snapshot, punti idempotenti, classifica, import, calendario | `src/core.js` |
| Budget API (150/mese, allarme 80%, blocco, retry) | `src/apiClient.js` |
| initData HMAC | `src/telegramAuth.js` |
| Bot: /start, promemoria, comandi admin (`/quota /ricalcola /import`) | `src/bot.js` |
| Admin REST `/api/admin/*` con audit log | `src/server.js`, tabella `audit_log` |
| Mini App (My Team / Tournaments / League) | `public/` |

## ⚠️ Da completare prima del lancio
- **`src/providers/sportsapi365.js`**: endpoint, autenticazione e nomi dei campi sono ipotesi (documentazione non consultabile). Va adattato alle risposte reali; il resto dell'app usa solo l'interfaccia normalizzata. Verificare paginazione del ranking e endpoint per data (RT-08..RT-10) e la licenza per app pubblica (RT-23). Il provider reale **non è stato testato**; la logica è testata col provider mock.
- PostgreSQL: il codice usa SQL portabile ma i test girano su SQLite; fare un giro completo su Postgres in staging.
- `public/privacy.html` è una bozza da far rivedere (RT-22). Definire stagione/premi/archivio (RL-25).

## Scelte dove il documento era ambiguo
- Il capitano **non può stare anche in rosa** (evita doppio conteggio); `ALLOW_CAPTAIN_IN_ROSTER=1` lo consente.
- Un utente segna dalla settimana in cui si iscrive (captain-only se a finestra chiusa, RL-09).
- Si può salvare una rosa parziale (≤7); il promemoria scatta sotto i 7 slot.
- Ranking di riferimento della settimana W = ultimo ranking con data < W (RL-12/RT-06).
- Classifica non mostra le settimane future; "Prossima settimana" mostra i draw già importati.
