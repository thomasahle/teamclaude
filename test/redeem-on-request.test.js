import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { ResetCreditRedeemer } from '../src/codex-reset-credits.js';

// `teamclaude redeem <account>`: spending one banked Codex reset credit because
// an operator named the account, with none of the automatic path's policy but
// all of the safety around the one call that cannot be undone. Nothing here
// reaches the network: both endpoints are injected.

const DAY = 24 * 60 * 60 * 1000;
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra });
const codex = (name, extra = {}) => oauth(name, { provider: 'codex', accountId: 'acct-' + name, ...extra });
const credit = (extra = {}) => ({ id: 'RateLimitResetCredit_1', status: 'available', supportedByPlan: true, expiresAt: Date.now() + 30 * DAY, title: 'Full reset', ...extra });

function harness({ accounts = [codex('a'), codex('b')], credits = [credit()], consume = () => ({ code: 'reset', windowsReset: 2, credit: null }), config = {} } = {}) {
  const am = new AccountManager(accounts, 0.98);
  const calls = { details: 0, consume: 0, keys: [], creditIds: [] };
  const redeemer = new ResetCreditRedeemer(am, {
    config,
    log: () => {},
    detailsFn: async () => { calls.details++; return { credits, availableCount: credits.length }; },
    consumeFn: async (_account, attempt) => {
      calls.consume++; calls.keys.push(attempt.redeemRequestId); calls.creditIds.push(attempt.creditId);
      return consume(calls.consume);
    },
    usageFn: async () => ({ sevenDay: { utilization: 0, resetAt: Date.now() + 7 * DAY } }),
  });
  return { am, redeemer, calls };
}

test('an operator request spends exactly one credit with no policy gate: fleet switch off, weekly window healthy', async () => {
  const { am, redeemer, calls } = harness({ config: { autoRedeemResets: false } });
  am.accounts[0].quota.unified7d = 0.3;
  const result = await redeemer.redeemOnRequest(am.accounts[0]);
  assert.equal(result.redeemed, true);
  assert.equal(result.code, 'reset');
  assert.equal(result.windowsReset, 2);
  assert.equal(result.creditsLeft, 0);
  assert.equal(calls.consume, 1);
  assert.deepEqual(calls.creditIds, ['RateLimitResetCredit_1']);
});

test('creditsLeft counts the credits still held after a redemption', async () => {
  const { am, redeemer } = harness({ credits: [credit({ id: 'c1' }), credit({ id: 'c2', expiresAt: Date.now() + 90 * DAY })] });
  const result = await redeemer.redeemOnRequest(am.accounts[0]);
  assert.equal(result.redeemed, true);
  assert.equal(result.creditsLeft, 1);
});

test('the credit that expires soonest is the one spent', async () => {
  const { am, redeemer, calls } = harness({ credits: [credit({ id: 'late', expiresAt: Date.now() + 90 * DAY }), credit({ id: 'soon', expiresAt: Date.now() + 2 * DAY })] });
  await redeemer.redeemOnRequest(am.accounts[0]);
  assert.deepEqual(calls.creditIds, ['soon']);
});

test('a Claude account, or a Codex row with no account id, is declined before any request', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('claude'), codex('nobody', { accountId: undefined })] });
  assert.match((await redeemer.redeemOnRequest(am.accounts[0])).reason, /not a Codex OAuth account/);
  assert.match((await redeemer.redeemOnRequest(am.accounts[1])).reason, /not a Codex OAuth account/);
  assert.equal(calls.details + calls.consume, 0);
});

test('an account holding nothing redeemable spends nothing, and a credit its plan cannot use does not count', async () => {
  for (const credits of [[], [credit({ status: 'redeemed' })], [credit({ status: 'redeeming' })], [credit({ supportedByPlan: false })]]) {
    const { am, redeemer, calls } = harness({ credits });
    const result = await redeemer.redeemOnRequest(am.accounts[0]);
    assert.equal(result.redeemed, false);
    assert.match(result.reason, /no redeemable reset credit/);
    assert.equal(calls.consume, 0, JSON.stringify(credits));
  }
});

test('upstream declining is not a spend: the code is reported', async () => {
  const { am, redeemer, calls } = harness({ consume: () => ({ code: 'nothing_to_reset', windowsReset: 0, credit: null }) });
  const result = await redeemer.redeemOnRequest(am.accounts[0]);
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /nothing_to_reset/);
  assert.equal(calls.consume, 1);
});

test('an unread answer is retried with the SAME idempotency key, and already_redeemed then counts as done', async () => {
  const { am, redeemer, calls } = harness({ consume: n => (n === 1 ? { error: 'socket hang up' } : { code: 'already_redeemed', windowsReset: 2, credit: null }) });
  const first = await redeemer.redeemOnRequest(am.accounts[0]);
  assert.equal(first.redeemed, false);
  assert.match(first.reason, /redeem failed/);
  // The hold the automatic path arms after an unread verdict must not stop the
  // operator's retry — replaying the key is what resolves it safely.
  const second = await redeemer.redeemOnRequest(am.accounts[0]);
  assert.equal(second.redeemed, true);
  assert.equal(second.code, 'already_redeemed');
  assert.equal(calls.keys.length, 2);
  assert.equal(calls.keys[0], calls.keys[1], 'the retry must replay the first attempt\'s key');
});

test('a completed redemption releases the key: the next one mints a new key', async () => {
  const { am, redeemer, calls } = harness({ credits: [credit({ id: 'c1' }), credit({ id: 'c2' })] });
  await redeemer.redeemOnRequest(am.accounts[0]);
  await redeemer.redeemOnRequest(am.accounts[0]);
  assert.equal(calls.consume, 2);
  assert.notEqual(calls.keys[0], calls.keys[1]);
});

test('an operator can redeem several accounts in turn, and the automatic path then holds off', async () => {
  const { am, redeemer, calls } = harness({ config: { autoRedeemResets: true } });
  assert.equal((await redeemer.redeemOnRequest(am.accounts[0])).redeemed, true);
  assert.equal((await redeemer.redeemOnRequest(am.accounts[1])).redeemed, true);
  assert.equal(calls.consume, 2);
  for (const account of am.accounts) { account.quota.unified7d = 1; account.quota.unified7dReset = Date.now() + 3 * DAY; account.quota.unified5h = 0.1; }
  const auto = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(auto.redeemed, false);
  assert.match(auto.reason, /cooling down/);
  assert.equal(calls.consume, 2, 'the automatic path must not add a third spend');
});

test('the rows are read fresh each time, not from the six-hour cache', async () => {
  const { am, redeemer, calls } = harness({ credits: [] });
  await redeemer.redeemOnRequest(am.accounts[0]);
  await redeemer.redeemOnRequest(am.accounts[0]);
  assert.equal(calls.details, 2);
});

test('a failed row read spends nothing and says why', async () => {
  const am = new AccountManager([codex('a')], 0.98);
  let consumed = 0;
  const redeemer = new ResetCreditRedeemer(am, { log: () => {}, detailsFn: async () => ({ error: 'HTTP 401' }), consumeFn: async () => { consumed++; return {}; } });
  const result = await redeemer.redeemOnRequest(am.accounts[0]);
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /could not read reset credits \(HTTP 401\)/);
  assert.equal(consumed, 0);
});
