import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, FABLE_FOCUS_MIN_LEFT_MS } from '../src/account-manager.js';
import { parseResetStatus, ClaudeResetRedeemer } from '../src/claude-resets.js';

// Fable focus (setFableFocus): Fable goes to one account at a time, other models
// keep off it while they can go elsewhere, and its Fable resets are spent only
// once its Fable weekly is full.

const H = 3600_000, DAY = 24 * H;
const FABLE = 'claude-fable-5-2';
const OPUS = 'claude-opus-5-5';
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, orgUuid: 'org-' + name, ...extra });

/** A quota reading: shared weekly `weekly`, Fable weekly `fable`, `resets` Fable resets held, the week ending in `left`. */
function reading(account, { weekly = 0.1, fable = 0.1, resets = 0, left = 4 * DAY } = {}) {
  Object.assign(account.quota, {
    unified5h: 0.1, unified5hReset: Date.now() + 2 * H,
    unified7d: weekly, unified7dReset: Date.now() + left,
    unified7dFable: fable, unified7dFableReset: Date.now() + left,
    resetCredits: { available: resets, applicable: resets, fable: resets, expiresAt: Date.now() + 100 * DAY, seenAt: Date.now() },
  });
}

function fleet(readings, { focus = true } = {}) {
  const am = new AccountManager(readings.map((_, i) => oauth(`acct${i}`)), 0.98, { fableFocus: focus });
  readings.forEach((r, i) => reading(am.accounts[i], r));
  return am;
}

const pick = (am, model) => am.getActiveAccount(null, model)?.name ?? null;

test('off by default: Fable follows the current account as before', () => {
  const am = fleet([{ resets: 0 }, { resets: 2 }], { focus: false });
  assert.equal(pick(am, FABLE), 'acct0');
  assert.equal(pick(am, OPUS), 'acct0');
});

test('Fable goes to the account holding the most Fable resets; other models keep off it', () => {
  const am = fleet([{ resets: 0 }, { resets: 2, weekly: 0.2 }, { resets: 1, weekly: 0.05 }]);
  assert.equal(pick(am, FABLE), 'acct1');
  assert.equal(pick(am, OPUS), 'acct0', 'Opus stays off the focus while another account can serve it');
  assert.equal(am.previewRouteIndex(FABLE), 1, 'the TUI marks the focus as where Fable routes');
});

test('other models move off the focus even when it is the account traffic rests on', () => {
  const am = fleet([{ resets: 2 }, { resets: 0, weekly: 0.3 }]);
  assert.equal(am.currentIndex, 0);
  assert.equal(pick(am, FABLE), 'acct0', 'the current account is the focus');
  assert.equal(pick(am, OPUS), 'acct1');
  assert.equal(pick(am, FABLE), 'acct0', 'and Fable stays on the focus');
});

test('the emptiest shared weekly breaks a tie on resets', () => {
  const am = fleet([{ resets: 1, weekly: 0.3 }, { resets: 1, weekly: 0.1 }]);
  assert.equal(pick(am, FABLE), 'acct1');
});

test('an account whose weekly cannot hold the rest of its Fable allowance ranks last', () => {
  // 90% of the week gone: Fable would stop at the weekly long before its own
  // half was used, and a reset there would give back only what it reached.
  const am = fleet([{ resets: 3, weekly: 0.9, fable: 0 }, { resets: 1, weekly: 0.2, fable: 0.2 }]);
  assert.equal(pick(am, FABLE), 'acct1');
});

test('a reset with too little of the week left to use counts for nothing', () => {
  const am = fleet([{ resets: 3, left: FABLE_FOCUS_MIN_LEFT_MS - H }, { resets: 1 }]);
  assert.equal(pick(am, FABLE), 'acct1');
});

test('other models fall back to the focus once nothing else can serve them', () => {
  const am = fleet([{ resets: 0, weekly: 0.99 }, { resets: 2, weekly: 0.2 }]);
  assert.equal(pick(am, OPUS), 'acct1');
});

test('the focus is sticky: a better account appearing later does not take Fable', () => {
  const am = fleet([{ resets: 1 }, { resets: 0 }]);
  assert.equal(pick(am, FABLE), 'acct0');
  reading(am.accounts[1], { resets: 5 });
  assert.equal(pick(am, FABLE), 'acct0');
});

test('a manual route pin still wins over the focus', () => {
  const am = fleet([{ resets: 2 }, { resets: 0 }]);
  am.routePins.set('fable', 1);
  assert.equal(pick(am, FABLE), 'acct1');
});

test('a spent focus holding a Fable reset asks for it once, and Fable spills until it lands', async () => {
  const am = fleet([{ resets: 0 }, { resets: 2, weekly: 0.5 }]);
  assert.equal(pick(am, FABLE), 'acct1');
  reading(am.accounts[1], { resets: 2, weekly: 0.5, fable: 0.99 });
  /** @type {string[]} */
  const asked = [];
  /** @type {(v: { redeemed: boolean }) => void} */
  let answer = () => {};
  am.onFableFocusSpent(account => { asked.push(account.name); return new Promise(r => { answer = r; }); });
  assert.equal(pick(am, FABLE), 'acct0', 'spills to the ordinary walk while the reset is asked for');
  assert.equal(pick(am, FABLE), 'acct0');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(asked, ['acct1'], 'asked once, not per request');
  // The reset lands: the Fable weekly reads empty again and Fable goes back.
  reading(am.accounts[1], { resets: 1, weekly: 0.02, fable: 0 });
  answer({ redeemed: true });
  await new Promise(r => setImmediate(r));
  assert.equal(pick(am, FABLE), 'acct1');
});

test('a declined reset moves the focus on instead of waiting', async () => {
  const am = fleet([{ resets: 1 }, { resets: 2, fable: 0.99 }]);
  am.onFableFocusSpent(async () => ({ redeemed: false }));
  am._fableFocusName = 'acct1';
  pick(am, FABLE);
  await new Promise(r => setImmediate(r));
  assert.equal(pick(am, FABLE), 'acct0');
});

test('a spent focus with no Fable reset, or too little week left, moves on without asking', async () => {
  for (const spent of [{ resets: 0, fable: 0.99 }, { resets: 2, fable: 0.99, left: FABLE_FOCUS_MIN_LEFT_MS - H }]) {
    const am = fleet([{ resets: 1 }, spent]);
    let asked = 0;
    am.onFableFocusSpent(async () => { asked++; return { redeemed: true }; });
    am._fableFocusName = 'acct1';
    assert.equal(pick(am, FABLE), 'acct0', JSON.stringify(spent));
    await new Promise(r => setImmediate(r));
    assert.equal(asked, 0, JSON.stringify(spent));
  }
});

// ── spending ────────────────────────────────────────────────────────────────

/** The cedar_ember block of an account at its Fable limit whose next grant clears `clears`. */
const block = clears => ({
  eligible: true, ineligible_reason: null, at_limit: true, exhausted: ['seven_day_overage_included'],
  next_grant_id: 'g1', cooldown_until: null,
  grants: [{ id: 'g1', label: 'x', resets_total: 1, resets_left: 1, clears, usable_now: true, paused: false,
    use_requires_limit: false, ends_at: new Date(Date.now() + 100 * DAY).toISOString() }],
});

function redeemer(clears, config = { fableFocus: true }) {
  const am = new AccountManager([oauth('a')], 0.98);
  am.ensureTokenFresh = async () => {};
  /** @type {string[]} */
  const claims = [];
  const r = new ClaudeResetRedeemer(am, {
    config, log: () => {},
    statusFn: async () => ({ reset: parseResetStatus(block(clears)), usage: { sevenDayFable: { utilization: 0 } } }),
    claimFn: async (account) => { claims.push(account.name); return { result: 'reset', resetsLeft: 0, cleared: clears, cooldownUntil: null }; },
  });
  return { am, r, claims };
}

test('the focus spends a Fable reset, on Max and on a Team seat alike', async () => {
  for (const clears of [['seven_day_overage_included'], ['five_hour', 'seven_day_overage_included']]) {
    const { am, r, claims } = redeemer(clears);
    const res = await r.redeemFableForFocus(am.accounts[0]);
    assert.equal(res.redeemed, true, JSON.stringify(clears));
    assert.deepEqual(claims, ['a']);
  }
});

test('the focus never spends a reset that also clears the shared weekly', async () => {
  const { am, r, claims } = redeemer(['five_hour', 'seven_day', 'seven_day_overage_included']);
  const res = await r.redeemFableForFocus(am.accounts[0]);
  assert.equal(res.redeemed, false);
  assert.match(res.reason, /not a Fable reset/);
  assert.deepEqual(claims, []);
});

test('the focus spends nothing with the switch off or on an exempt account', async () => {
  const off = redeemer(['seven_day_overage_included'], {});
  assert.equal((await off.r.redeemFableForFocus(off.am.accounts[0])).redeemed, false);
  const exempt = redeemer(['seven_day_overage_included']);
  exempt.am.accounts[0].autoRedeemReset = false;
  assert.equal((await exempt.r.redeemFableForFocus(exempt.am.accounts[0])).redeemed, false);
  assert.deepEqual([...off.claims, ...exempt.claims], []);
});
