import test from 'node:test';
import assert from 'node:assert/strict';
import { canAdd, validatePicks, pointsFor, withPositions, tierOf, isCaptainEligible } from '../shared/rules.js';
import { mondayOf, romeToUtc, windowOf, windowState, dayOfWeekOf } from '../src/time.js';
import { validateInitData, signInitData, teamNameFor } from '../src/telegramAuth.js';

test('RL-11: vincoli top-125 / top-200', () => {
  assert.equal(tierOf(125), 'top125');
  assert.equal(tierOf(126), 'top200');
  assert.equal(tierOf(200), 'top200');
  assert.equal(tierOf(201), 'other');
  assert.equal(tierOf(901), 'none');
  assert.equal(canAdd([], 50).ok, true);
  assert.equal(canAdd([50], 100).code, 'TOP125_LIMIT');
  assert.equal(canAdd([50, 150], 180).ok, true); // 1 top-125 + 2 top-200
  assert.equal(canAdd([50, 150, 180], 190).code, 'TOP200_LIMIT');
  assert.equal(canAdd([150, 160, 170], 50).code, 'TOP200_LIMIT'); // il top-125 conta nei top-200
  assert.equal(canAdd([150, 160, 170], 500).ok, true);
  assert.equal(canAdd([], 901).code, 'NOT_IN_POOL');
});

test('validazione della rosa per torneo', () => {
  const tournaments = [{ id: 't1', playerIds: ['a', 'b', 'c'] }, { id: 't2', playerIds: ['d', 'e'] }];
  assert.equal(validatePicks(['a', 'd'], { tournaments }).ok, true);
  assert.equal(validatePicks([], { tournaments }).ok, true); // anche rosa vuota
  assert.equal(validatePicks(['a'], { tournaments }).ok, true); // meno giocatori dei tornei
  assert.equal(validatePicks(['a', 'b'], { tournaments }).errors[0].code, 'ONE_PER_TOURNAMENT');
  assert.equal(validatePicks(['a', 'a'], { tournaments }).errors[0].code, 'DUPLICATE');
  assert.equal(validatePicks(['z'], { tournaments }).errors[0].code, 'NOT_A_PARTICIPANT');
  assert.equal(validatePicks(['a'], { tournaments, captainId: 'a' }).errors[0].code, 'IS_CAPTAIN');
  // nessun vincolo di classifica: la validazione non conosce le posizioni
  assert.equal(validatePicks(['a', 'd'], { tournaments }).ok, true);
});

test('RL-04: capitano tra 201 e 900', () => {
  assert.equal(isCaptainEligible(200), false);
  assert.equal(isCaptainEligible(201), true);
  assert.equal(isCaptainEligible(900), true);
  assert.equal(isCaptainEligible(901), false);
});

test('RL-17/RL-20: punteggio e raddoppio capitano', () => {
  assert.deepEqual(['winner', 'finalist', 'semifinalist', 'quarter'].map((r) => pointsFor(r)), [10, 5, 2, 0]);
  assert.deepEqual(['winner', 'finalist', 'semifinalist'].map((r) => pointsFor(r, true)), [20, 10, 4]);
});

test('RL-23: pari merito con stessa posizione (1,1,3)', () => {
  const rows = withPositions([{ points: 10 }, { points: 10 }, { points: 4 }, { points: 0 }]);
  assert.deepEqual(rows.map((r) => r.position), [1, 1, 3, 4]);
});

test('finestra di selezione Europe/Rome, anche con ora legale (RL-13, RT-05)', () => {
  assert.equal(dayOfWeekOf('2026-11-23'), 1); // lunedi'
  const w = windowOf('2026-11-23'); // inverno: UTC+1
  assert.equal(w.opens.toISOString(), '2026-11-22T23:01:00.000Z');
  assert.equal(w.closes.toISOString(), '2026-11-24T14:00:00.000Z');
  const s = windowOf('2026-06-22'); // estate: UTC+2
  assert.equal(s.closes.toISOString(), '2026-06-23T13:00:00.000Z');
  assert.equal(windowState(new Date('2026-11-24T13:59:00Z')).open, true);
  assert.equal(windowState(new Date('2026-11-24T14:00:00Z')).open, false);
  assert.equal(windowState(new Date('2026-11-22T23:00:30Z')).open, false); // 00:00:30 di lunedi'
  assert.equal(windowState(new Date('2026-11-22T23:01:00Z')).open, true);
});

test('settimana ATP = lunedi\' in ora di Roma', () => {
  assert.equal(mondayOf(new Date('2026-11-22T22:30:00Z')), '2026-11-16'); // domenica 23:30 a Roma
  assert.equal(mondayOf(new Date('2026-11-22T23:30:00Z')), '2026-11-23'); // lunedi' 00:30 a Roma
  assert.equal(romeToUtc('2026-03-29', 12, 0).toISOString(), '2026-03-29T10:00:00.000Z'); // dopo il cambio ora
});

test('RT-20: initData Telegram firmato', () => {
  const token = '123:ABC';
  const good = signInitData({ id: 42, username: 'luca', first_name: 'Luca' }, token);
  assert.equal(validateInitData(good, token).id, '42');
  assert.throws(() => validateInitData(good, '999:XYZ'), /firma/);
  assert.throws(() => validateInitData(good.replace('luca', 'mallory'), token), /firma/);
  const old = signInitData({ id: 42 }, token, Math.floor(Date.now() / 1000) - 3 * 86400);
  assert.throws(() => validateInitData(old, token), /scaduto/);
  assert.throws(() => validateInitData('', token));
});

test('RL-24: nome team', () => {
  assert.equal(teamNameFor({ id: '1', username: 'luca', firstName: 'L', lastName: '' }), 'luca');
  assert.equal(teamNameFor({ id: '1', username: null, firstName: 'Luca', lastName: 'Rossi' }), 'Luca Rossi');
});
