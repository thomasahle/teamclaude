import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, needsRelogin, RELOGIN_CHECK_WINDOW_MS } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { renderStatus, renderReloginCheck } from '../src/status-renderer.js';
import { TUI } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

// The re-login check. A refresh token that a `/login` elsewhere rotated away
// used to be discovered by the first request after the access token expired,
// which that request then lost; until then the account read `active`. The
// check refreshes every token due within the hour ahead of use — at startup
// and at the start of each probe pass — so the same on-use marking happens
// first, and the dashboards say `relogin` for it.

const MIN = 60_000;
const oauth = (name, extra = {}) => ({
  name, type: 'oauth', accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt: Date.now() + 30 * MIN, ...extra,
});

function authError(status = 400) {
  const e = new Error(`Token refresh failed (${status}): {"error":"invalid_grant"}`);
  e.status = status;
  return e;
}

const silent = () => {
  const log = console.log, error = console.error;
  console.log = () => {}; console.error = () => {};
  return () => { console.log = log; console.error = error; };
};

test('relogin check: a dead refresh token found ahead of use marks the account as the on-use path would', async () => {
  const restore = silent();
  try {
    const sent = [];
    const am = new AccountManager([oauth('a')], 0.98, { refreshFn: async rt => { sent.push(rt); throw authError(400); } });
    assert.equal(am.accounts[0].status, 'active');

    const refreshed = await am.refreshExpiringTokens();
    assert.deepEqual(refreshed.map(a => a.name), ['a']);
    assert.deepEqual(sent, ['rt-a']);
    const a = am.accounts[0];
    assert.equal(a.status, 'error', 'the same state the send path sets');
    assert.equal(a._deadRefreshToken, 'rt-a', 'and the same guard, so the token is not sent again');
    assert.equal(needsRelogin(a), true);
    const row = am.getStatus().accounts[0];
    assert.equal(row.status, 'error', 'the payload keeps its word for readers that key on it');
    assert.equal(row.needsRelogin, true);
    assert.equal(row.unavailable, 'error');

    // The next pass sends nothing: the guard holds until a new token arrives.
    await am.refreshExpiringTokens();
    assert.deepEqual(sent, ['rt-a']);
  } finally { restore(); }
});

test('relogin check: a transient refresh failure changes nothing', async () => {
  const restore = silent();
  try {
    for (const fail of [
      () => { const e = new Error('Token refresh failed (503): upstream'); e.status = 503; throw e; },
      () => { const e = new Error('fetch failed'); e.code = 'ECONNRESET'; throw e; },
    ]) {
      const am = new AccountManager([oauth('a')], 0.98, { refreshFn: async () => fail() });
      await am.refreshExpiringTokens();
      const a = am.accounts[0];
      assert.equal(a.status, 'active');
      assert.equal(a._deadRefreshToken, null);
      assert.equal(a.credential, 'at-a', 'the token in hand is kept');
      assert.equal(am.getStatus().accounts[0].needsRelogin, false);
    }
  } finally { restore(); }
});

test('relogin check: a working token is refreshed and the account stays active', async () => {
  const restore = silent();
  try {
    const am = new AccountManager([oauth('a')], 0.98, {
      refreshFn: async () => ({ accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() + 8 * 60 * MIN }),
    });
    await am.refreshExpiringTokens();
    const a = am.accounts[0];
    assert.equal(a.status, 'active');
    assert.equal(a.credential, 'at-new');
    assert.equal(a.refreshToken, 'rt-new');
    // Fresh now: the next pass has nothing to do.
    assert.deepEqual(await am.refreshExpiringTokens(), []);
  } finally { restore(); }
});

test('relogin check: only tokens due within the window, and only accounts the send path would refresh', async () => {
  const restore = silent();
  try {
    const sent = [];
    const am = new AccountManager([
      oauth('due'),
      oauth('expired', { expiresAt: Date.now() - MIN }),
      oauth('later', { expiresAt: Date.now() + RELOGIN_CHECK_WINDOW_MS + 5 * MIN }),
      oauth('unknown', { expiresAt: undefined }),
      oauth('off', { disabled: true }),
      oauth('third-party', { upstream: 'https://glm.example/anthropic' }),
      { name: 'key', type: 'apikey', apiKey: 'k' },
    ], 0.98, { refreshFn: async rt => { sent.push(rt); return { accessToken: 'x', refreshToken: rt, expiresAt: Date.now() + 8 * 60 * MIN }; } });
    // Already in `error`: another refresh repairs nothing, and the dead-token
    // guard would decline it anyway.
    am.addAccount(oauth('dead'));
    const dead = am.accounts[am.accounts.length - 1];
    dead.status = 'error';
    dead._deadRefreshToken = dead.refreshToken;

    const refreshed = await am.refreshExpiringTokens();
    assert.deepEqual(refreshed.map(a => a.name).sort(), ['due', 'expired']);
    assert.deepEqual(sent.sort(), ['rt-due', 'rt-expired']);
  } finally { restore(); }
});

test('relogin check: a Codex account goes through the Codex refresh and is marked the same way', async () => {
  const restore = silent();
  try {
    const anthropic = [], codex = [];
    const am = new AccountManager([
      oauth('claude'),
      oauth('chatgpt', { provider: 'codex', accountId: 'acct-1' }),
    ], 0.98, {
      refreshFn: async rt => { anthropic.push(rt); return { accessToken: 'x', refreshToken: rt, expiresAt: Date.now() + 8 * 60 * MIN }; },
      codexRefreshFn: async rt => { codex.push(rt); throw authError(400); },
    });
    await am.refreshExpiringTokens();
    assert.deepEqual(anthropic, ['rt-claude']);
    assert.deepEqual(codex, ['rt-chatgpt']);
    assert.equal(am.accounts[0].status, 'active');
    assert.equal(am.accounts[1].status, 'error');
    assert.equal(am.getStatus().accounts[1].needsRelogin, true);
  } finally { restore(); }
});

test('relogin check: the prober runs it at the start of every pass, and leaves the marked account out of the pass', async () => {
  const restore = silent();
  try {
    const am = new AccountManager([oauth('dead'), oauth('fine')], 0.98, {
      refreshFn: async rt => {
        if (rt === 'rt-dead') throw authError(400);
        return { accessToken: 'at-fine2', refreshToken: rt, expiresAt: Date.now() + 8 * 60 * MIN };
      },
    });
    const probed = [];
    const prober = new Prober(am, { intervalMs: 0, log: () => {}, probeFn: async token => { probed.push(token); return { fiveHour: { utilization: 0.1, resetAt: 1 } }; } });
    await prober.probeAll();
    assert.equal(am.accounts[0].status, 'error');
    assert.equal(am.accounts[1].status, 'active');
    // The dead account was not probed with a token that cannot be refreshed;
    // the other was probed with the token the check just minted.
    assert.deepEqual(probed, ['at-fine2']);
  } finally { restore(); }
});

test('relogin check: reloginCheck: false leaves the pass as it was', async () => {
  const restore = silent();
  try {
    let refreshes = 0;
    const am = new AccountManager([oauth('dead')], 0.98, { refreshFn: async () => { refreshes++; throw authError(400); } });
    const probed = [];
    const prober = new Prober(am, { intervalMs: 0, reloginCheck: false, log: () => {}, probeFn: async token => { probed.push(token); return { fiveHour: { utilization: 0.1, resetAt: 1 } }; } });
    await prober.probeAll();
    // Thirty minutes out is beyond the five-minute window the probe's own
    // refresh uses, so without the check the dead token goes unnoticed.
    assert.equal(refreshes, 0);
    assert.equal(am.accounts[0].status, 'active');
    assert.deepEqual(probed, ['at-dead']);
  } finally { restore(); }
});

// ── what the readouts say ────────────────────────────────────

const now = Date.parse('2026-07-03T12:00:00Z');

test('relogin check: `teamclaude status` says relogin for an OAuth account in error, and what to do', () => {
  const status = {
    currentAccount: 'ok',
    switchThreshold: 0.98,
    accounts: [
      { name: 'ok', type: 'oauth', priority: 0, status: 'active', needsRelogin: false, quota: {}, usage: {} },
      { name: 'dead', type: 'oauth', priority: 0, status: 'error', needsRelogin: true, unavailable: 'error', quota: {}, usage: {} },
    ],
  };
  const out = renderStatus(status, { color: false, now });
  assert.match(out, /dead \(oauth, prio 0\) relogin/);
  assert.match(out, /Blocked\s+refresh token rejected — sign in again \(teamclaude login/);
  assert.doesNotMatch(out, /account error \(see logs\)/);
  // An older server's payload carries no `needsRelogin`; type and status
  // still say what it is.
  delete status.accounts[1].needsRelogin;
  assert.match(renderStatus(status, { color: false, now }), /dead \(oauth, prio 0\) relogin/);
  // A key in `error` (an older server) is not something a login repairs.
  status.accounts[1].type = 'apikey';
  const key = renderStatus(status, { color: false, now });
  assert.match(key, /dead \(apikey, prio 0\) error/);
  assert.match(key, /account error \(see logs\)/);
});

const SGR = /\x1b\[[0-9;]*m/g;

/** The account rows of one full frame at 120 columns, colour stripped. */
function accountRows(am, { remote = false } = {}) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
    ...(remote ? { remote: {} } : {}),
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  let buf = '';
  try {
    tui._paint = b => { buf = b; };
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols); else delete process.stdout.columns;
    if (rows) Object.defineProperty(process.stdout, 'rows', rows); else delete process.stdout.rows;
  }
  return buf.replace(SGR, '').split('\r\n').filter(l => /@x\.com/.test(l));
}

test('relogin check: the TUI row reads relogin, live and in attach mode, and the l key opens on it', async () => {
  const restore = silent();
  try {
    const am = new AccountManager([oauth('ok@x.com'), oauth('dead@x.com')], 0.98, {
      refreshFn: async rt => {
        if (rt === 'rt-dead@x.com') throw authError(400);
        return { accessToken: 'x', refreshToken: rt, expiresAt: Date.now() + 8 * 60 * MIN };
      },
    });
    await am.refreshExpiringTokens();

    const live = accountRows(am);
    assert.match(live.find(l => l.includes('dead@x.com')), /relogin/);
    assert.doesNotMatch(live.find(l => l.includes('dead@x.com')), /\berror\b/);
    assert.match(live.find(l => l.includes('ok@x.com')), /active/);

    // Attach mode draws from the status payload.
    const rm = new RemoteAccountManager();
    rm.applyStatus(am.getStatus());
    const attached = accountRows(rm, { remote: true });
    assert.match(attached.find(l => l.includes('dead@x.com')), /relogin/);

    // `l` starts on the account that needs it.
    const tui = new TUI({
      accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
      saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
      loginAccount: async () => ({}),
    });
    tui.render = () => {};
    tui._key('l');
    assert.equal(tui.mode, 'select');
    assert.equal(am.accounts[tui.selIdx].name, 'dead@x.com');
  } finally { restore(); }
});

// ── on demand: every token, with an answer per account ───────

test('relogin check: on demand every refresh token is verified and each account reports an outcome', async () => {
  const restore = silent();
  try {
    const sent = [];
    const am = new AccountManager([
      oauth('good'),
      oauth('dead'),
      oauth('flaky'),
      oauth('later', { expiresAt: Date.now() + 5 * 60 * MIN }),   // well past the hour: verified on demand anyway
      oauth('unknown', { expiresAt: undefined }),                 // no expiry known: verified on demand anyway
      { name: 'key', type: 'apikey', apiKey: 'k' },
      oauth('off', { disabled: true }),
      oauth('third-party', { upstream: 'https://glm.example/anthropic' }),
      oauth('chatgpt', { provider: 'codex', accountId: 'acct-1' }),
    ], 0.98, {
      refreshFn: async rt => {
        sent.push(rt);
        if (rt === 'rt-dead') throw authError(400);
        if (rt === 'rt-flaky') { const e = new Error('fetch failed'); e.code = 'ECONNRESET'; throw e; }
        return { accessToken: `new-${rt}`, refreshToken: rt, expiresAt: Date.now() + 8 * 60 * MIN };
      },
      codexRefreshFn: async rt => { sent.push(rt); return { accessToken: 'new-codex', refreshToken: rt, expiresAt: Date.now() + 8 * 60 * MIN }; },
    });
    am.addAccount(oauth('already'));
    const already = am.accounts[am.accounts.length - 1];
    already.status = 'error';
    already._deadRefreshToken = already.refreshToken;

    const r = await am.reloginCheck({ withinMs: Infinity });
    assert.equal(r.scope, 'all');
    assert.equal(r.withinMs, null);
    assert.deepEqual(sent.sort(), ['rt-chatgpt', 'rt-dead', 'rt-flaky', 'rt-good', 'rt-later', 'rt-unknown']);
    const by = Object.fromEntries(r.accounts.map(a => [a.name, a]));
    assert.equal(by.good.outcome, 'refreshed');
    assert.equal(by.good.reason, null);
    assert.equal(by.later.outcome, 'refreshed');
    assert.equal(by.unknown.outcome, 'refreshed');
    assert.equal(by.chatgpt.outcome, 'refreshed');
    assert.equal(by.chatgpt.provider, 'codex');
    assert.equal(by.dead.outcome, 'relogin');
    assert.match(by.dead.reason, /refresh token rejected — sign in again/);
    assert.equal(by.already.outcome, 'relogin');
    assert.match(by.already.reason, /already marked, not retried/);
    assert.equal(by.flaky.outcome, 'failed');
    assert.match(by.flaky.reason, /token kept: fetch failed/);
    assert.deepEqual([by.key.outcome, by.key.reason], ['skipped', 'not an OAuth account']);
    assert.deepEqual([by.off.outcome, by.off.reason], ['skipped', 'disabled']);
    assert.equal(by['third-party'].outcome, 'skipped');
    assert.match(by['third-party'].reason, /third-party/);
    assert.deepEqual([r.checked, r.refreshed, r.relogin, r.failed, r.skipped], [6, 4, 2, 1, 3]);
    assert.equal(am.accounts[1].status, 'error', 'marked as the on-use path would');
    assert.equal(am.accounts[2].credential, 'at-flaky', 'a transient failure keeps the token');
    assert.equal(am.accounts[0].credential, 'new-rt-good');
    // Nothing but the dead ones changed status.
    assert.deepEqual(am.accounts.filter(a => a.status === 'error').map(a => a.name), ['dead', 'already']);
  } finally { restore(); }
});

test('relogin check: under the window a token not yet due is skipped and says when it is; the window is configurable', async () => {
  const restore = silent();
  try {
    const sent = [];
    const mk = opts => new AccountManager([oauth('soon', { expiresAt: Date.now() + 90 * MIN })], 0.98, {
      refreshFn: async rt => { sent.push(rt); return { accessToken: 'x', refreshToken: rt, expiresAt: Date.now() + 8 * 60 * MIN }; },
      ...opts,
    });
    const hour = await mk({}).reloginCheck();
    assert.equal(hour.scope, 'due');
    assert.equal(hour.withinMs, RELOGIN_CHECK_WINDOW_MS);
    assert.equal(hour.checked, 0);
    assert.equal(hour.accounts[0].outcome, 'skipped');
    assert.match(hour.accounts[0].reason, /not due: the token expires in 1h 30m/);
    assert.deepEqual(sent, []);

    const two = await mk({ reloginCheckWindowMs: 2 * 60 * MIN }).reloginCheck();
    assert.equal(two.withinMs, 2 * 60 * MIN);
    assert.equal(two.accounts[0].outcome, 'refreshed');
    assert.deepEqual(sent, ['rt-soon']);

    // Anything but a positive number means the default; the setter is what a
    // config reload calls.
    const am = mk({ reloginCheckWindowMs: 'soon' });
    assert.equal(am.reloginCheckWindowMs, RELOGIN_CHECK_WINDOW_MS);
    assert.equal(am.setReloginCheckWindow(-5), RELOGIN_CHECK_WINDOW_MS);
    assert.equal(am.setReloginCheckWindow(30 * MIN), 30 * MIN);
    assert.equal((await am.reloginCheck()).withinMs, 30 * MIN);
  } finally { restore(); }
});

test('relogin check: the table names each outcome and sums them', () => {
  const out = renderReloginCheck({
    scope: 'all', withinMs: null, checked: 3, refreshed: 1, relogin: 1, failed: 1, skipped: 1,
    accounts: [
      { name: 'good@x.com', provider: 'anthropic', outcome: 'refreshed', reason: null },
      { name: 'dead@x.com', provider: 'anthropic', outcome: 'relogin', reason: 'refresh token rejected — sign in again (teamclaude login)' },
      { name: 'flaky@x.com', provider: 'codex', outcome: 'failed', reason: 'refresh failed, token kept: fetch failed' },
      { name: 'key', provider: 'anthropic', outcome: 'skipped', reason: 'not an OAuth account' },
    ],
  }, { color: false });
  assert.match(out, /^Re-login check \(every OAuth refresh token; 4 accounts, 3 refreshed now\)/);
  assert.match(out, /good@x\.com\s+refreshed$/m);
  assert.match(out, /dead@x\.com\s+relogin\s+refresh token rejected/);
  assert.match(out, /flaky@x\.com\s+failed\s+refresh failed, token kept: fetch failed/);
  assert.match(out, /key\s+skipped\s+not an OAuth account/);
  assert.match(out, /1 refreshed, 1 needs re-login, 1 failed, 1 skipped/);
  assert.match(out, /Sign in again: teamclaude login/);

  const due = renderReloginCheck({ scope: 'due', withinMs: 3600_000, checked: 0, accounts: [] }, { color: false });
  assert.match(due, /tokens due within 60 min; 0 accounts, 0 refreshed now/);
  assert.match(due, /no accounts/);
  assert.match(due, /0 refreshed, 0 need re-login, 0 failed, 0 skipped/);
  assert.doesNotMatch(due, /Sign in again/);
});

test('relogin check: the TUI `v` key runs the on-demand check and logs the summary', async () => {
  const restore = silent();
  try {
    const far = Date.now() + 5 * 60 * MIN; // beyond the hour: only an on-demand check touches these
    const am = new AccountManager([oauth('ok@x.com', { expiresAt: far }), oauth('dead@x.com', { expiresAt: far })], 0.98, {
      refreshFn: async rt => {
        if (rt === 'rt-dead@x.com') throw authError(400);
        return { accessToken: 'x', refreshToken: rt, expiresAt: Date.now() + 8 * 60 * MIN };
      },
    });
    const make = (manager, extra = {}) => {
      const tui = new TUI({
        accountManager: manager, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
        saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {}, ...extra,
      });
      tui.render = () => {};
      return tui;
    };
    const tui = make(am);
    assert.match(tui._renderFooter().replace(SGR, ''), /verify tokens/);
    tui._key('v');
    await new Promise(r => setTimeout(r, 10));
    const log = tui.log.map(e => e.msg.replace(SGR, ''));
    assert.ok(log.includes('Re-login check: 1 refreshed, 1 needs re-login ("dead@x.com"), 0 failed, 0 skipped'), log.join('\n'));
    assert.equal(am.accounts[1].status, 'error');
    assert.equal(am.accounts[0].status, 'active');

    // Attach mode has no manager to run the pass on, and does not offer the key.
    const rm = new RemoteAccountManager();
    rm.applyStatus(am.getStatus());
    const attached = make(rm, { remote: {} });
    assert.doesNotMatch(attached._renderFooter().replace(SGR, ''), /verify tokens/);
    attached._key('v');
    assert.ok(!attached.log.some(e => /Re-login check/.test(e.msg)));
  } finally { restore(); }
});
