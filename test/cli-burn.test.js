import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { BurnTracker } from '../src/burn.js';
import { createProxyServer } from '../src/server.js';
import { closedPort } from '../test-helpers/spawn-server.js';

// `teamclaude burn` and the `burn` block of /teamclaude/status, over a real
// proxy server whose quota readings are fed in by hand an hour apart — the
// probe result path, as the Prober would call it — on a clock the test holds.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const HOUR = 3600_000;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** Two accounts with two probe readings each, an hour apart; an API key with none. */
function fleet() {
  const T = Date.now();
  const clock = { t: T - HOUR };
  const burn = new BurnTracker({ now: () => clock.t, log: () => {} });
  const am = new AccountManager([
    { name: 'alice@example.com', type: 'oauth', accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: T + 8 * HOUR },
    { name: 'bot@example.com', type: 'oauth', provider: 'codex', accountId: 'acct-1', accessToken: 'at-b', refreshToken: 'rt-b', expiresAt: T + 8 * HOUR },
    { name: 'key', type: 'apikey', apiKey: 'k1' },
  ], 0.98, { burn });
  const log = console.log;
  console.log = () => {};
  try {
    am.applyUsageData(0, { fiveHour: { utilization: 0.10, resetAt: T + 3 * HOUR }, sevenDay: { utilization: 0.50, resetAt: T + 3 * 24 * HOUR } });
    am.applyCodexUsageData(1, { fiveHour: { utilization: 0.30, resetAt: T + 2 * HOUR }, sevenDay: { utilization: 0.40, resetAt: T + 5 * 24 * HOUR } });
    am.updateUsage(0, 120_000, 30_000);
    clock.t = T;
    am.applyUsageData(0, { fiveHour: { utilization: 0.21, resetAt: T + 3 * HOUR }, sevenDay: { utilization: 0.52, resetAt: T + 3 * 24 * HOUR } });
    am.applyCodexUsageData(1, { fiveHour: { utilization: 0.35, resetAt: T + 2 * HOUR }, sevenDay: { utilization: 0.41, resetAt: T + 5 * 24 * HOUR } });
  } finally { console.log = log; }
  return am;
}

async function withProxy(fn) {
  const am = fleet();
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await listen(proxy);
  try {
    await fn({ am, port });
  } finally {
    proxy.close();
  }
}

async function writeConfig(port) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-burn-'));
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

const near = (actual, expected, eps = 1e-9) => assert.ok(actual != null && Math.abs(actual - expected) < eps, `${actual} is not near ${expected}`);

test('/teamclaude/status carries burn per provider and per account', async () => {
  await withProxy(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'tc-test' } });
    assert.equal(res.status, 200);
    const { burn } = await res.json();
    assert.ok(burn.sampledAt);
    near(burn.byProvider.anthropic.windows.unified5h.perHour1h, 0.11);
    near(burn.byProvider.anthropic.windows.unified7d.perHour1h, 0.02);
    near(burn.byProvider.anthropic.windows.unified7d.pooledRemaining, 0.48);
    near(burn.byProvider.anthropic.windows.unified7d.exhaustHours1h, 24);
    assert.equal(burn.byProvider.anthropic.windows.unified7d.runsOutBeforeReset, true);
    near(burn.byProvider.anthropic.tokens.inPerHour1h, 120_000);
    near(burn.byProvider.codex.windows.unified5h.perHour1h, 0.05);
    // Every account the manager holds has counters, so an account that served
    // nothing reads a token rate of zero, not none.
    assert.equal(burn.byProvider.codex.tokens.inPerHour1h, 0);
    near(burn.byAccount['alice@example.com'].windows.unified5h.perHour1h, 0.11);
    assert.equal(burn.byAccount['alice@example.com'].samples, 2);
    assert.equal(burn.byAccount.key.windows.unified5h.perHour1h, null);
  });
});

test('teamclaude burn prints the provider lines and the per-account table, and --json the block', async () => {
  await withProxy(async ({ port }) => {
    const configPath = await writeConfig(port);
    const res = await runCli(configPath, ['burn', '--color=never']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^Burn per hour \(last reading \d+s ago; each figure: last 1 h \/ last 24 h\)/);
    assert.match(res.stdout, /^  anthropic  5h 11%\/h  wk 2\.0%\/h  tok 120k in\/30k out per h  wk pool 24h \(reset 3d\) — runs out before reset$/m);
    assert.match(res.stdout, /^  codex\s+5h 5\.0%\/h  wk 1\.0%\/h  tok 0 in\/0 out per h  wk pool 59h \(reset 5d\) — runs out before reset$/m);
    assert.match(res.stdout, /^  alice@example\.com\s+anthropic\s+11% \/ 11%\s+2\.0% \/ 2\.0%\s+120k \/ 120k\s+30k \/ 30k$/m);
    assert.match(res.stdout, /^  bot@example\.com\s+codex\s+5\.0% \/ 5\.0%\s+1\.0% \/ 1\.0%\s+0 \/ 0\s+0 \/ 0$/m);
    assert.match(res.stdout, /^  key\s+anthropic\s+- \/ -\s+- \/ -\s+- \/ -\s+- \/ -$/m);

    const json = await runCli(configPath, ['burn', '--json']);
    assert.equal(json.code, 0, json.stderr);
    const burn = JSON.parse(json.stdout);
    near(burn.byProvider.anthropic.windows.unified5h.perHour1h, 0.11);
    assert.ok('byAccount' in burn && 'sampledAt' in burn);
  });
});

test('teamclaude status prints the same provider lines', async () => {
  await withProxy(async ({ port }) => {
    const configPath = await writeConfig(port);
    const res = await runCli(configPath, ['status', '--color=never']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^Burn\s+anthropic  5h 11%\/h  wk 2\.0%\/h/m);
    assert.match(res.stdout, /^Burn\s+codex\s+5h 5\.0%\/h/m);
  });
});

test('teamclaude burn with no server running says so', async () => {
  const configPath = await writeConfig(await closedPort());
  const res = await runCli(configPath, ['burn']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Cannot connect to proxy/);
});
