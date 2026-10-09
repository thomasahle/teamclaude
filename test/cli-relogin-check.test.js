import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { closedPort } from '../test-helpers/spawn-server.js';

// POST /teamclaude/relogin-check and `teamclaude relogin-check`: the on-demand
// re-login check over the control plane. The CLI drives the real endpoint, so
// as in cli-switch.test.js it runs against a real proxy server — one whose
// token refresh is stubbed, so no credential leaves the process.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const HOUR = 3600_000;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** A fleet five hours from expiry: nothing the hourly check would touch. */
function fleet() {
  const sent = [];
  const am = new AccountManager([
    { name: 'good@example.com', type: 'oauth', accessToken: 'at-good', refreshToken: 'rt-good', expiresAt: Date.now() + 5 * HOUR },
    { name: 'dead@example.com', type: 'oauth', accessToken: 'at-dead', refreshToken: 'rt-dead', expiresAt: Date.now() + 5 * HOUR },
    { name: 'key', type: 'apikey', apiKey: 'k1' },
  ], 0.98, {
    refreshFn: async rt => {
      sent.push(rt);
      if (rt === 'rt-dead') {
        const e = new Error('Token refresh failed (400): {"error":"invalid_grant"}');
        e.status = 400;
        throw e;
      }
      return { accessToken: 'at-good-2', refreshToken: rt, expiresAt: Date.now() + 8 * HOUR };
    },
  });
  return { am, sent };
}

async function withProxy(fn, { clientKeys = null } = {}) {
  const { am, sent } = fleet();
  const config = { proxy: { apiKey: 'tc-test', ...(clientKeys ? { clientKeys } : {}) }, upstream: 'https://api.anthropic.com' };
  const proxy = createProxyServer(am, config, {});
  const port = await listen(proxy);
  const log = console.log, error = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    await fn({ am, sent, port });
  } finally {
    proxy.close();
    console.log = log; console.error = error;
  }
}

async function writeConfig(port) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-relogin-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    switchThreshold: 0.98,
    accounts: [],
  }));
  return path;
}

function runCli(configPath, cliArgs) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 15_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('POST /teamclaude/relogin-check verifies every refresh token and reports each account', async () => {
  await withProxy(async ({ am, sent, port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/relogin-check`, { method: 'POST', headers: { 'x-api-key': 'tc-test' } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.scope, 'all');
    assert.equal(data.withinMs, null);
    assert.deepEqual(sent.sort(), ['rt-dead', 'rt-good'], 'five hours out, beyond the hourly window: verified on demand');
    const by = Object.fromEntries(data.accounts.map(a => [a.name, a]));
    assert.equal(by['good@example.com'].outcome, 'refreshed');
    assert.equal(by['dead@example.com'].outcome, 'relogin');
    assert.match(by['dead@example.com'].reason, /refresh token rejected/);
    assert.deepEqual([by.key.outcome, by.key.reason], ['skipped', 'not an OAuth account']);
    assert.deepEqual([data.checked, data.refreshed, data.relogin, data.failed, data.skipped], [2, 1, 1, 0, 1]);

    // Marked as the on-use path would have: the status payload says so too.
    assert.equal(am.accounts[1].status, 'error');
    assert.equal(am.accounts[0].credential, 'at-good-2');
    const status = await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'tc-test' } })).json();
    assert.equal(status.accounts.find(a => a.name === 'dead@example.com').needsRelogin, true);
  });
});

test('a client key may not run the re-login check', async () => {
  await withProxy(async ({ sent, port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/relogin-check`, { method: 'POST', headers: { 'x-api-key': 'tc-client' } });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /client key cannot refresh credentials/);
    assert.deepEqual(sent, [], 'no token was sent anywhere');
  }, { clientKeys: [{ name: 'ci', key: 'tc-client' }] });
});

test('teamclaude relogin-check prints the table, and --json the payload', async () => {
  await withProxy(async ({ port }) => {
    const configPath = await writeConfig(port);
    const res = await runCli(configPath, ['relogin-check', '--color=never']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^Re-login check \(every OAuth refresh token; 3 accounts, 2 refreshed now\)/);
    assert.match(res.stdout, /good@example\.com\s+refreshed$/m);
    assert.match(res.stdout, /dead@example\.com\s+relogin\s+refresh token rejected — sign in again/);
    assert.match(res.stdout, /key\s+skipped\s+not an OAuth account/);
    assert.match(res.stdout, /1 refreshed, 1 needs re-login, 0 failed, 1 skipped/);
    assert.match(res.stdout, /Sign in again: teamclaude login/);

    const json = await runCli(configPath, ['relogin-check', '--json']);
    assert.equal(json.code, 0, json.stderr);
    const data = JSON.parse(json.stdout);
    assert.equal(data.ok, true);
    // The second run finds the dead account already marked, and does not retry it.
    const dead = data.accounts.find(a => a.name === 'dead@example.com');
    assert.equal(dead.outcome, 'relogin');
    assert.match(dead.reason, /already marked, not retried/);
  });
});

test('teamclaude relogin-check with no server running says so', async () => {
  const configPath = await writeConfig(await closedPort());
  const res = await runCli(configPath, ['relogin-check']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Cannot connect to proxy/);
});
