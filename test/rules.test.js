import test from 'node:test';
import assert from 'node:assert/strict';
import { canAdd, validateRoster, pointsFor, withPositions, tierOf, isCaptainEligible } from '../shared/rules.js';
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
  assert.equal(canAdd([300, 301, 302, 303, 304, 305, 306], 400).code, 'FULL');
});

test('validazione server della rosa', () => {
  const ok = validateRoster([{ id: 'a', pos: 100 }, { id: 'b', pos: 190 }, { id: 'c', pos: 199 }, { id: 'd', pos: 500 }]);
  assert.equal(ok.ok, true);
  assert.equal(validateRoster([{ id: 'a', pos: 100 }, { id: 'a', pos: 100 }]).ok, false);
  assert.equal(validateRoster([{ id: 'a', pos: null }]).errors[0].code, 'NOT_IN_POOL');
  assert.equal(validateRoster([{ id: 'a', pos: 300 }], { captainId: 'a' }).errors[0].code, 'IS_CAPTAIN');
  assert.equal(validateRoster(Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, pos: 300 + i }))).errors[0].code, 'TOO_MANY');
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
