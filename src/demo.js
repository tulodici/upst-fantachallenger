// Dati dimostrativi per sviluppo locale (DEMO_SEED=1). Non usare in produzione.
import { addDays, mondayOf } from './time.js';

export async function seedDemo(core, db, now) {
  const W = mondayOf(now);
  const prev = addDays(W, -7);
  const ref = addDays(W, -7);
  await core.runJob('ranking', ref, { force: true, actor: 'demo' });
  await core.importDraws(prev);
  await core.importResults(prev);
  await core.importDraws(W);

  // Utenti dimostrativi con una rosa nello storico della settimana passata.
  const draw = await db.all(
    `SELECT d.player_id, r.pos FROM draw_entries d JOIN tournaments t ON t.id = d.tournament_id
       LEFT JOIN rankings r ON r.player_id = d.player_id AND r.week_start = ?
      WHERE t.week_start = ? AND d.kind = 'main' ORDER BY d.player_id`,
    [ref, prev],
  );
  const names = ['Sinner_fan', 'Matteo', 'cobolli', 'Giulia', 'tennisnerd', 'Paolo_88', 'RossoCampo', 'Anna'];
  let i = 0;
  for (const name of names) {
    const cap = `p${300 + i * 37}`;
    await db.run('INSERT INTO users (telegram_id, team_name, captain_id, reg_week, registered_at) VALUES (?, ?, ?, ?, ?)',
      [String(9000 + i), name, cap, addDays(W, -14), `${addDays(W, -14)}T09:00:00Z`]);
    const u = await db.get('SELECT id FROM users WHERE telegram_id = ?', [String(9000 + i)]);
    const picks = draw.filter((_, k) => (k + i) % 4 === 0).slice(0, 5);
    for (const p of picks) await db.run('INSERT INTO roster_snapshots (user_id, week_start, player_id, ref_pos) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [u.id, prev, p.player_id, p.pos]);
    i++;
  }
  await core.recomputePoints();
}
