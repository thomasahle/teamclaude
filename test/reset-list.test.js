import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { bankedResets } from '../src/oauth.js';
import { parseResetStatus, ClaudeResetRedeemer } from '../src/claude-resets.js';
import { ResetCreditRedeemer } from '../src/codex-reset-credits.js';
import { describeClaudeResets, describeCodexCredits, formatResetList, heldSummary, nextReset, resetRef } from '../src/reset-list.js';

// `teamclaude redeem`: the banked resets an account holds, listed before one is
// spent, and a confirmation that can only spend the reset that was shown.
// Nothing here reaches the network.

const H = 3600_000, DAY = 24 * H;
const NOW = Date.UTC(2026, 10, 11, 10, 40);
const iso = (/** @type {number} */ t) => new Date(t).toISOString();

const FULL = { id: 'nov-full-2026', label: 'One full limit reset (November 2026)', resets_total: 1, resets_left: 1,
  starts_at: iso(NOW - 13 * H), ends_at: iso(NOW + 29 * DAY), clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
  paused: false, usable_now: true, use_requires_limit: false, percent_used: { five_hour: 0, seven_day: 97, seven_day_overage_included: 0 },
  type: 'full', unavailable_reason: null, gives_back_weekly: false };
const fable = (/** @type {string} */ id, extra = {}) => ({ id, label: "New model launch: one Fable reset", resets_total: 1, resets_left: 1,
  starts_at: iso(NOW - 2 * DAY), ends_at: iso(NOW + 118 * DAY), clears: ['five_hour', 'seven_day_overage_included'],
  paused: false, usable_now: true, use_requires_limit: false, percent_used: { five_hour: 0, seven_day_overage_included: 0 },
  type: 'full', unavailable_reason: null, gives_back_weekly: true, ...extra });

/** A Team-seat usage payload: a full reset next, three Fable resets behind it. */
const teamSeat = (extra = {}) => ({
  seven_day: { utilization: 97, resets_at: iso(NOW + 46 * H) },
  five_hour: { utilization: 0, resets_at: null },
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 0, allowance_percent_of_weekly: 50 }],
  cedar_ember: { eligible: true, ineligible_reason: null, at_limit: false, exhausted: [], cooldown_until: null,
    next_grant_id: 'nov-full-2026', grants: [{ ...FULL }, fable('launch-fable'), fable('fable-12mo'), fable('fable-6mo')], ...extra },
});

/** A Max account whose full reset is spent and whose next is a Fable reset. */
const maxAccount = () => ({
  seven_day: { utilization: 49, resets_at: iso(NOW + 5 * DAY) },
  weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 40, allowance_percent_of_weekly: 50 }],
  cedar_ember: { eligible: true, at_limit: false, exhausted: [], cooldown_until: null, next_grant_id: 'fable-6mo',
    grants: [{ ...FULL, resets_left: 0, clears: ['seven_day', 'seven_day_overage_included'] },
      fable('fable-6mo', { clears: ['seven_day_overage_included'], percent_used: { seven_day_overage_included: 80, seven_day: 49 } })] },
});

test('every grant is listed with its kind and expiry, the next one is marked, and no grant id leaves', () => {
  const d = describeClaudeResets(teamSeat(), NOW);
  assert.deepEqual(d.grants.map(g => [g.kind, g.next, g.left]), [['full', true, 1], ['fable', false, 1], ['fable', false, 1], ['fable', false, 1]]);
  assert.equal(d.grants[0].ref, resetRef('nov-full-2026'));
  const wire = JSON.stringify(d);
  for (const id of ['nov-full-2026', 'launch-fable', 'fable-12mo', 'fable-6mo']) assert.ok(!wire.includes(`"${id}"`), id);
  const text = formatResetList([{ account: 'seat', provider: 'anthropic', claude: d }], { now: NOW });
  assert.match(text, /► Full reset\s+1 left\s+expires .*\(in 29d\)/);
  assert.match(text, /clears 5-hour, weekly, Fable/);
  assert.match(text, /spent next · 5-hour 0% → 0%, weekly 97% → 0%, Fable 0% → 0%/);
  assert.equal((text.match(/waits behind the one marked ►/g) || []).length, 3, 'the Fable resets wait their turn');
  assert.match(text, /weekly 97%, resets .*\(in 1d22h\)/);
  assert.ok(!/nov-full-2026|fable-6mo/.test(text));
});

test('a Fable reset next says what it gives back of the shared weekly; a spent grant reads spent', () => {
  const d = describeClaudeResets(maxAccount(), NOW);
  const text = formatResetList([{ account: 'max', provider: 'anthropic', claude: d }], { now: NOW });
  assert.match(text, /► Fable reset/);
  assert.match(text, /spent next · Fable 80% → 0%, weekly 49% → 9%/);
  assert.match(text, /already spent: 1 full reset$/m);
  assert.equal(nextReset({ claude: d }).kind, 'fable');
  assert.match(heldSummary({ claude: d }, NOW), /^1 Fable reset; the soonest expires .*\(in 118d\)$/);
  assert.equal(heldSummary({ claude: describeClaudeResets(teamSeat(), NOW) }, NOW).split(';')[0], '1 full reset, 3 Fable resets');
});

test('in a cooldown nothing is offered, and an expired grant is not listed', () => {
  const cooling = teamSeat({ cooldown_until: iso(NOW + 20 * 60_000) });
  for (const g of cooling.cedar_ember.grants) Object.assign(g, { usable_now: false, unavailable_reason: 'cooldown' });
  const d = describeClaudeResets(cooling, NOW);
  assert.equal(nextReset({ claude: d }), null);
  assert.match(formatResetList([{ account: 'seat', claude: d }], { now: NOW }), /none can be spent until .*\(in 20m\)/);
  const old = teamSeat();
  old.cedar_ember.grants[3].ends_at = iso(NOW - H);
  assert.equal(describeClaudeResets(old, NOW).grants.length, 3);
});

test('a Codex listing marks the credit the redeemer would spend', () => {
  const rows = [{ id: 'late', status: 'available', supportedByPlan: true, expiresAt: NOW + 30 * DAY, title: 'Full reset' },
    { id: 'soon', status: 'available', supportedByPlan: true, expiresAt: NOW + 2 * DAY, title: 'Full reset' }];
  const d = describeCodexCredits(rows, 'soon', NOW);
  assert.deepEqual(d.credits.map(c => c.next), [false, true]);
  assert.equal(nextReset({ codex: d }).ref, resetRef('soon'));
  assert.match(formatResetList([{ account: 'cx', codex: d }], { now: NOW }), /2 reset credits/);
});

// ── the confirmation ────────────────────────────────────────────────────────

const oauth = (/** @type {string} */ name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, orgUuid: 'org-' + name, ...extra });

function claudeHarness() {
  const am = new AccountManager([oauth('a')], 0.98);
  am.ensureTokenFresh = async () => {};
  /** @type {string[]} */
  const claims = [];
  const payload = teamSeat();
  for (const g of payload.cedar_ember.grants) g.ends_at = iso(Date.now() + 29 * DAY);
  const r = new ClaudeResetRedeemer(am, {
    config: {}, log: () => {},
    statusFn: async () => ({ reset: parseResetStatus(payload.cedar_ember), usage: { sevenDay: { utilization: 0 } } }),
    claimFn: async (_a, c) => { claims.push(c.grantId); return { result: 'reset', resetsLeft: 0, cleared: ['five_hour', 'seven_day', 'seven_day_overage_included'], cooldownUntil: null }; },
  });
  return { am, r, claims };
}

test('a Claude redemption spends only the reset the operator confirmed', async () => {
  const wrong = claudeHarness();
  const refused = await wrong.r.redeemOnRequest(wrong.am.accounts[0], { expect: resetRef('fable-6mo') });
  assert.equal(refused.redeemed, false);
  assert.match(refused.reason, /no longer the one listed/);
  assert.deepEqual(wrong.claims, []);
  const right = claudeHarness();
  const spent = await right.r.redeemOnRequest(right.am.accounts[0], { expect: resetRef('nov-full-2026') });
  assert.equal(spent.redeemed, true);
  assert.deepEqual(right.claims, ['nov-full-2026']);
  assert.deepEqual(spent.grant, { kind: 'full', label: 'One full limit reset (November 2026)' });
});

test('a Codex redemption spends only the credit the operator confirmed', async () => {
  const am = new AccountManager([oauth('cx', { provider: 'codex', accountId: 'acct-cx' })], 0.98);
  let consumed = 0;
  const r = new ResetCreditRedeemer(am, {
    config: {}, log: () => {},
    detailsFn: async () => ({ credits: [{ id: 'c1', status: 'available', supportedByPlan: true, expiresAt: Date.now() + DAY, title: 'Full reset' }], availableCount: 1 }),
    consumeFn: async () => { consumed++; return { code: 'reset', windowsReset: 2, credit: null }; },
    usageFn: async () => ({ sevenDay: { utilization: 0, resetAt: Date.now() + 7 * DAY } }),
  });
  assert.match((await r.redeemOnRequest(am.accounts[0], { expect: resetRef('c2') })).reason, /no longer the one listed/);
  assert.equal(consumed, 0);
  assert.equal((await r.redeemOnRequest(am.accounts[0], { expect: resetRef('c1') })).redeemed, true);
  assert.equal(consumed, 1);
});

// ── the next grant's kind, and the Fable focus ──────────────────────────────

test('the held-resets reading says whether the next grant is a Fable reset', () => {
  assert.equal(bankedResets(teamSeat().cedar_ember, NOW).nextFable, false);
  assert.equal(bankedResets(maxAccount().cedar_ember, NOW).nextFable, true);
  assert.equal(bankedResets(teamSeat({ next_grant_id: null }).cedar_ember, NOW).nextFable, null);
  assert.ok(!JSON.stringify(bankedResets(teamSeat().cedar_ember, NOW)).includes('nov-full-2026'), 'no grant id is kept');
});

test('the Fable focus does not count Fable resets a full reset stands ahead of', () => {
  const am = new AccountManager([oauth('blocked'), oauth('reachable')], 0.98, { fableFocus: true });
  const now = Date.now();
  am.accounts.forEach((a, i) => Object.assign(a.quota, {
    unified5h: 0.1, unified5hReset: now + 2 * H, unified7d: 0.2, unified7dReset: now + 4 * DAY, unified7dFable: 0.1, unified7dFableReset: now + 4 * DAY,
    resetCredits: i === 0
      ? { available: 4, applicable: 4, fable: 3, nextFable: false, expiresAt: now + 29 * DAY, seenAt: now }
      : { available: 1, applicable: 1, fable: 1, nextFable: true, expiresAt: now + 118 * DAY, seenAt: now },
  }));
  assert.equal(am.getActiveAccount(null, 'claude-fable-5-2')?.name, 'reachable');
});

// ── through the server ──────────────────────────────────────────────────────

test('the listing route answers with each account, and the redeem route passes the confirmed ref on', async () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  /** @type {any[]} */
  const seen = [];
  const hooks = {
    listResets: async (/** @type {number[]|null} */ indexes) => { seen.push(['list', indexes]); return (indexes ?? [0, 1]).map(i => ({ account: am.accounts[i].name })); },
    redeemReset: async (/** @type {number} */ index, /** @type {any} */ opts) => { seen.push(['redeem', index, opts]); return { ok: true }; },
  };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' }, hooks);
  const port = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(/** @type {any} */ (proxy.address()).port)));
  const post = (/** @type {string} */ path, /** @type {any} */ body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async res => ({ status: res.status, data: await res.json() }));
  try {
    assert.deepEqual((await post('/teamclaude/resets', {})).data.accounts.map((/** @type {any} */ e) => e.account), ['a', 'b']);
    assert.deepEqual((await post('/teamclaude/resets', { account: 'b' })).data.accounts.map((/** @type {any} */ e) => e.account), ['b']);
    const missing = await post('/teamclaude/resets', { account: 'nobody' });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.data.accounts, ['a', 'b']);
    await post('/teamclaude/redeem', { account: 'a', expect: resetRef('x') });
    await post('/teamclaude/redeem', { account: 'a', expect: 'not-a-ref' });
    assert.deepEqual(seen, [['list', null], ['list', [1]], ['redeem', 0, { expect: resetRef('x') }], ['redeem', 0, { expect: null }]]);
  } finally { proxy.close(); }
});
