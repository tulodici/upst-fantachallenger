# 🎾 FantaChallenger di Un Podcast Sul Tennis

Fantasy game gratuito sui tornei ATP Challenger, come **Telegram Mini App**. Ogni settimana si pronostica un giocatore per ogni torneo in corso; i punti dipendono da quanto arriva lontano.

Stack: Node 22 senza framework (backend HTTP + job schedulati), PostgreSQL, frontend vanilla in italiano, deploy su Railway, dati da SportsAPI365.

## Regolamento

1. **Scegli il Capitano.** Un giocatore fuori dalla top-200 ATP, fisso per tutta la stagione, con punti ×3.
2. **Ogni settimana scegli un giocatore per torneo** tra i partecipanti di ciascun Challenger in programma.
3. **Bonus Underdog.** Un giocatore non testa di serie vale punti ×2 (non cumulabile con il Capitano).
4. **Finestra di scelta.** Da lunedì 00:01 a martedì 15:00 (ora italiana); poi la rosa è congelata.
5. **Punti.** Vincitore 10 · Finalista 5 · Semifinalista 2.

Il testo ufficiale è in `public/app.js` (`regolamento()`) ed è lo stesso mostrato dal comando `/help` del bot.

## Avvio locale

```
npm run dev   # API finta + SQLite in memoria + dati demo, orologio fissato a lunedì 23/11/2026
              # apri http://localhost:3000/?dev=42 (utente di test, solo fuori produzione)
npm test      # test su regole, fuso orario, HMAC, flusso settimanale, quota API, provider, HTTP
```

## Deploy su Railway

1. Nuovo progetto da questo repo, con il plugin **PostgreSQL** (imposta `DATABASE_URL`).
2. Imposta le variabili di `.env.example`: `BOT_TOKEN`, `PUBLIC_URL`, `ADMIN_TELEGRAM_IDS`, `SPORTSAPI365_*`.
3. All'avvio il bot registra webhook e pulsante Mini App; le tabelle si creano da sole.
4. Primo avvio: `/import ranking` importa la classifica ATP.
5. Il deploy parte quando cambia una variabile (es. `DEPLOY_REV`); non c'è auto-deploy dal push.
6. `TEST_WINDOW_OPEN=1` forza la finestra sempre aperta: **va rimossa prima del lancio**.

## Comandi del bot

| Comando | Chi | Cosa fa |
|---|---|---|
| `/start` | tutti | Messaggio di benvenuto e pulsante per aprire l'app |
| `/help` | tutti | Mostra il regolamento |
| `/quota` | admin | Chiamate API usate nel mese |
| `/stato` | admin | Provider, utenti, ultimi job |
| `/import <job> [lunedì]` | admin | Esegue `ranking`, `draws`, `results`… (costa chiamate API) |
| `/ricalcola` | admin | Ricalcola tutti i punti |
| `/scelte` | admin | Invia l'Excel con le scelte e i punti di tutte le squadre |
| `/demo` · `/demo off` | admin | Crea o rimuove 20 squadre fittizie |
| `/reset` | admin | Elimina la propria squadra (collaudo) |

## Job e budget API

Budget: **150 chiamate al mese**, allarme all'80%, blocco a quota esaurita. Consumo tipico: circa 15–20 chiamate a settimana.

| Quando (Europe/Rome) | Job | Chiamate |
|---|---|---|
| Domenica 08:00 | `draws` (settimana dopo) | 1 calendario + 1 per torneo |
| Lunedì 12:00 | `results` (settimana prima) | 1 per torneo |
| Lunedì 12:00 | `ranking` | 2 |
| Martedì 08:00 | `recheck` (solo tornei aperti) | 0 – N |
| Lunedì dalle 18:00 | `reminder` | 0 |
| Martedì 15:00 | `close` (snapshot e punti) | 0 |

## Struttura del codice

| Area | Dove |
|---|---|
| Regole (punti, bonus, validazione), condivise con il frontend | `shared/rules.js` |
| Finestra lun 00:01 – mar 15:00, Europe/Rome | `src/time.js` |
| Rose, partecipanti, punti, classifica, import, scheduler, report Excel | `src/core.js` |
| Writer XLSX senza dipendenze | `src/xlsx.js` |
| Budget API | `src/apiClient.js` |
| Provider dati (reale e finto) | `src/providers/` |
| Autenticazione initData Telegram (HMAC) | `src/telegramAuth.js` |
| Bot e comandi | `src/bot.js` |
| API REST, file statici, admin con audit log | `src/server.js` |
| Mini App (Team, Tornei, Classifica) | `public/` |

## Da completare prima del lancio

- Rimuovere `TEST_WINDOW_OPEN` e le squadre demo.
- Revisionare `public/privacy.html` (è una bozza) e verificare la licenza SportsAPI365 per app pubblica.
- Definire stagione, premi e archivio.
- Verificare un ciclo completo su PostgreSQL in staging (i test girano su SQLite).
