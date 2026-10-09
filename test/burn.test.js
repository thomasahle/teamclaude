import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BurnTracker, burnKey, burnPerHour, burnSummaryLines, formatRatePct, formatTokens, formatHours, formatUntil, BURN_RETENTION_MS, MIN_SAMPLE_GAP_MS } from '../src/burn.js';
import { renderBurn, renderStatus } from '../src/status-renderer.js';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

// Burn per hour (burn.js): the rates behind the provider lines of the TUI,
// `teamclaude status` and `teamclaude burn`, from the quota readings the
// server already takes. The rate math is pure over a sample list; the tracker
// around it keeps the samples — one series per provider and name — in memory
// and in a JSONL log.

const MIN = 60_000, HOUR = 3600_000;
const T0 = Date.parse('2026-07-03T12:00:00Z');
const near = (actual, expected, eps = 1e-9) => assert.ok(actual != null && Math.abs(actual - expected) < eps, `${actual} is not near ${expected}`);
const A = { name: 'a', type: 'oauth' };
const B = { name: 'b', type: 'oauth' };

/** A tracker on a clock the test moves. */
function clocked(start = T0, opts = {}) {
  const clock = { t: start };
  const tracker = new BurnTracker({ now: () => clock.t, log: () => {}, ...opts });
  return { clock, tracker };
}

/** A sample list for burnPerHour, with every other series blank. */
const series = rows => rows.map(s => ({ unified5h: null, unified7d: null, scopedWeekly: {}, inputTokens: null, outputTokens: null, ...s }));

// ── the rate math ─────────────────────────────────────────────

test('burn: plain growth over the last hour and the last day', () => {
  const { clock, tracker } = clocked(T0 - 24 * HOUR);
  // One probe sample every ten minutes for a day: the 5h window climbs 1% a
  // sample, the weekly 0.1%, Fable 0.2%; 1000 tokens in and 200 out each.
  for (let i = 0; i <= 144; i++) {
    clock.t = T0 - 24 * HOUR + i * 10 * MIN;
    tracker.record(A, { unified5h: i * 0.01, unified7d: i * 0.001, scopedWeekly: { fable: i * 0.002 }, inputTokens: i * 1000, outputTokens: i * 200 }, { force: true });
  }
  const r = tracker.rates(A, T0);
  near(r.windows.unified5h.perHour1h, 0.06);
  near(r.windows.unified5h.perHour24h, 0.06);
  near(r.windows.unified7d.perHour1h, 0.006);
  near(r.windows.scopedWeekly.fable.perHour1h, 0.012);
  near(r.tokens.inPerHour1h, 6000);
  near(r.tokens.outPerHour1h, 1200);
  near(r.tokens.inPerHour24h, 6000);
  assert.equal(r.samples, 145);
  assert.equal(r.sampledAt, T0);
});

test('burn: a drop is a reset — a new segment, never negative burn', () => {
  // 0.2 before the window rolled over and 0.1 after, over one hour: 0.3/h, not -0.35/h.
  const windows = series([
    { t: T0 - 60 * MIN, unified5h: 0.50 }, { t: T0 - 45 * MIN, unified5h: 0.60 }, { t: T0 - 30 * MIN, unified5h: 0.70 },
    { t: T0 - 15 * MIN, unified5h: 0.05 }, { t: T0, unified5h: 0.15 },
  ]);
  near(burnPerHour(windows, 'unified5h', T0, HOUR), 0.3);
  // A token counter that started again after a restart, the same way.
  const tokens = series([
    { t: T0 - 60 * MIN, inputTokens: 900_000 }, { t: T0 - 30 * MIN, inputTokens: 1_000_000 },
    { t: T0 - 20 * MIN, inputTokens: 0 }, { t: T0, inputTokens: 50_000 },
  ]);
  near(burnPerHour(tokens, 'inputTokens', T0, HOUR), 150_000);
});

test('burn: fewer than two readings of a series is no rate; a flat series is a rate of zero', () => {
  const { clock, tracker } = clocked();
  assert.equal(tracker.rates(A).windows.unified5h.perHour1h, null, 'no samples at all');
  tracker.record(A, { unified5h: 0.1 }, { force: true });
  assert.equal(tracker.rates(A).windows.unified5h.perHour1h, null, 'one sample');
  clock.t += 10 * MIN;
  tracker.record(A, { unified7d: 0.2 }, { force: true });
  const r = tracker.rates(A);
  assert.equal(r.windows.unified5h.perHour1h, null, 'the 5h series still has one reading');
  assert.equal(r.windows.unified7d.perHour1h, null);
  assert.equal(r.tokens.inPerHour1h, null);
  clock.t += 10 * MIN;
  tracker.record(A, { unified5h: 0.3, unified7d: 0.2 }, { force: true });
  near(tracker.rates(A).windows.unified5h.perHour1h, 0.2 / (20 / 60));
  assert.equal(tracker.rates(A).windows.unified7d.perHour1h, 0);
});

test('burn: the baseline just before a horizon is used, a distant one is not, and nothing inside the window is no rate', () => {
  // Five minutes before the hour: the span is the whole 65 minutes.
  near(burnPerHour(series([{ t: T0 - 65 * MIN, unified7d: 0.10 }, { t: T0 - 30 * MIN, unified7d: 0.20 }, { t: T0, unified7d: 0.30 }]), 'unified7d', T0, HOUR), 0.2 / (65 / 60));
  // Two hours before it (the server was idle): only the readings inside count.
  near(burnPerHour(series([{ t: T0 - 3 * HOUR, unified7d: 0.10 }, { t: T0 - 30 * MIN, unified7d: 0.20 }, { t: T0, unified7d: 0.30 }]), 'unified7d', T0, HOUR), 0.2);
  // Old readings alone, none in the last hour: no rate for the hour, one for the day.
  const old = series([{ t: T0 - 5 * HOUR, unified7d: 0.10 }, { t: T0 - 3 * HOUR, unified7d: 0.30 }]);
  assert.equal(burnPerHour(old, 'unified7d', T0, HOUR), null);
  near(burnPerHour(old, 'unified7d', T0, 24 * HOUR), 0.1);
});

test('burn: header readings are folded to one a minute per account; a probe result always lands', () => {
  const { clock, tracker } = clocked();
  assert.equal(tracker.record(A, { unified5h: 0.1 }), true);
  clock.t += 20_000;
  assert.equal(tracker.record(A, { unified5h: 0.11 }), false, 'twenty seconds later: folded');
  assert.equal(tracker.record(A, { unified5h: 0.12 }, { force: true }), true, 'a probe result lands regardless');
  clock.t += MIN_SAMPLE_GAP_MS;
  assert.equal(tracker.record(A, { unified5h: 0.13 }), true);
  assert.equal(tracker.samples.get('anthropic/a').length, 3);
  assert.equal(tracker.record(B, { unified5h: 0.5 }), true, 'the gap is per account');
});

test('burn: retention trims the ring to 48 h', () => {
  const { clock, tracker } = clocked(T0 - 60 * HOUR);
  for (let i = 0; i <= 60; i++) {
    clock.t = T0 - 60 * HOUR + i * HOUR;
    tracker.record(A, { unified7d: i * 0.01 }, { force: true });
  }
  const ring = tracker.samples.get('anthropic/a');
  assert.equal(ring.length, 49);
  assert.equal(ring[0].t, T0 - BURN_RETENTION_MS, 'the oldest kept is exactly 48 h old');
  near(tracker.rates(A, T0).windows.unified7d.perHour24h, 0.01);
});

// ── one series per provider and name ──────────────────────────

test('burn: the same name under two providers is two series, and neither provider mixes them in', () => {
  const { clock, tracker } = clocked(T0 - HOUR);
  const claude = { name: 'me@x.com', type: 'oauth', quota: { unified7d: 0.63, unified7dReset: T0 + 24 * HOUR, scopedWeekly: {} } };
  const codex = { name: 'me@x.com', type: 'oauth', provider: 'codex', accountId: 'acct', quota: { unified7d: 0.20, unified7dReset: T0 + 24 * HOUR, scopedWeekly: {} } };
  assert.equal(burnKey(claude), 'anthropic/me@x.com');
  assert.equal(burnKey(codex), 'codex/me@x.com');
  // The readings alternate, as a hub holding both logins sees them: the
  // Anthropic weekly at 0.61 and climbing slowly, the Codex one at 0.18. Keyed
  // by name alone, every alternation read as 0.43 of growth.
  for (let i = 0; i <= 6; i++) {
    clock.t = T0 - HOUR + i * 10 * MIN;
    tracker.record(claude, { unified7d: 0.61 + i * 0.003, inputTokens: i * 1000 }, { force: true });
    if (i < 6) {
      clock.t += 5 * MIN;
      tracker.record(codex, { unified7d: 0.18 + i * 0.001 }, { force: true });
    }
  }
  near(tracker.rates(claude, T0).windows.unified7d.perHour1h, 0.018);
  near(tracker.rates(codex, T0).windows.unified7d.perHour1h, 0.005 / (50 / 60));
  const s = tracker.status([claude, codex], T0);
  near(s.byProvider.anthropic.windows.unified7d.perHour1h, 0.018);
  near(s.byProvider.codex.windows.unified7d.perHour1h, 0.006);
  near(s.byProvider.anthropic.tokens.inPerHour1h, 6000);
  assert.equal(s.byProvider.codex.tokens.inPerHour1h, null, 'the Codex series has no token readings of its own');
  assert.deepEqual(Object.keys(s.byAccount).sort(), ['anthropic/me@x.com', 'codex/me@x.com']);
  assert.equal(s.byAccount['anthropic/me@x.com'].name, 'me@x.com');
  assert.equal(s.byAccount['codex/me@x.com'].provider, 'codex');
  near(s.byAccount['codex/me@x.com'].windows.unified7d.perHour1h, 0.006);
  const out = renderBurn(s, { color: false, now: T0 });
  assert.match(out, /^  me@x\.com\s+anthropic\s+- \/ -\s+1\.8% \/ 1\.8%\s+6k \/ 6k/m);
  assert.match(out, /^  me@x\.com\s+codex\s+- \/ -\s+0\.6% \/ 0\.6%\s+- \/ -/m);
});

test('burn: legacy rows without a provider are placed by name, and dropped when the name is held by two providers or by none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-burn-legacy-'));
  const path = join(dir, 'teamclaude.burn.jsonl');
  const rows = [
    { name: 'only@x.com', t: T0 - 10 * MIN, unified7d: 0.1 },
    { name: 'only@x.com', t: T0, unified7d: 0.2 },
    { name: 'me@x.com', t: T0 - 10 * MIN, unified7d: 0.61 },
    { name: 'me@x.com', t: T0 - 5 * MIN, unified7d: 0.18 },
    { name: 'gone@x.com', t: T0, unified7d: 0.5 },
    { provider: 'codex', name: 'me@x.com', t: T0 - 2 * MIN, unified7d: 0.19 },
  ];
  await writeFile(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const lines = [];
  const tracker = new BurnTracker({ path, now: () => T0, log: l => lines.push(l) });
  const accounts = [
    { name: 'only@x.com', type: 'oauth' },
    { name: 'me@x.com', type: 'oauth' },
    { name: 'me@x.com', type: 'oauth', provider: 'codex', accountId: 'x' },
  ];
  assert.deepEqual(await tracker.load({ accounts }), { loaded: 3, dropped: 3 });
  assert.equal(tracker.rates(accounts[0], T0).samples, 2, 'a name one account holds is placed');
  assert.equal(tracker.rates(accounts[1], T0).samples, 0, 'a name two providers hold is not guessed');
  assert.equal(tracker.rates(accounts[2], T0).samples, 1, 'a row that names its provider lands as written');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /3 sample\(s\) from before provider keys were dropped \(2 under a name held by more than one provider, 1 under a name no account holds\)/);
  // The compacted file names the provider on every row.
  const kept = (await readFile(path, 'utf-8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(kept.length, 3);
  assert.ok(kept.every(r => typeof r.provider === 'string' && typeof r.name === 'string'));
  assert.deepEqual(kept.map(r => `${r.provider}/${r.name}`).sort(), ['anthropic/only@x.com', 'anthropic/only@x.com', 'codex/me@x.com']);
});

// ── persistence ───────────────────────────────────────────────

test('burn: persistence round trip, compacted on load, with a corrupted trailing line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-burn-'));
  const path = join(dir, 'teamclaude.burn.jsonl');
  const { clock, tracker } = clocked(T0 - 50 * HOUR, { path });
  for (let i = 0; i <= 50; i++) {
    clock.t = T0 - 50 * HOUR + i * HOUR;
    tracker.record(A, { unified5h: i * 0.01, inputTokens: i * 100 }, { force: true });
  }
  tracker.record(B, { unified7d: 0.4 }, { force: true });
  await tracker.flush();
  const written = (await readFile(path, 'utf-8')).split('\n').filter(Boolean);
  assert.equal(written.length, 52, 'one line per sample, appended as they came');
  assert.deepEqual(Object.keys(JSON.parse(written[0])).slice(0, 3), ['provider', 'name', 't']);
  // A crash mid-append leaves a line cut short.
  await appendFile(path, '{"provider":"anthropic","name":"a","t":17000000');

  const { clock: clock2, tracker: again } = clocked(T0, { path });
  assert.deepEqual(await again.load(), { loaded: 50, dropped: 3 }, '49 of a within 48 h and one of b; two expired, one cut short');
  near(again.rates(A, T0).windows.unified5h.perHour24h, 0.01);
  near(again.rates(A, T0).tokens.inPerHour24h, 100);
  assert.equal(again.rates(B, T0).samples, 1);
  const compacted = (await readFile(path, 'utf-8')).split('\n').filter(Boolean);
  assert.equal(compacted.length, 50, 'compacted to what was kept');
  assert.ok(compacted.every(line => JSON.parse(line).t >= T0 - BURN_RETENTION_MS));
  // New samples go on the end of the compacted file.
  clock2.t = T0 + MIN;
  again.record(B, { unified7d: 0.41 }, { force: true });
  await again.flush();
  assert.equal((await readFile(path, 'utf-8')).split('\n').filter(Boolean).length, 51);
  // No file is an empty history, not an error.
  const fresh = new BurnTracker({ path: join(dir, 'none.jsonl'), log: () => {} });
  assert.deepEqual(await fresh.load(), { loaded: 0, dropped: 0 });
  // A log that cannot be written is said once and the rates go on in memory.
  const lines = [];
  const unwritable = new BurnTracker({ path: join(dir, 'missing-dir', 'x.jsonl'), log: l => lines.push(l) });
  unwritable.record(A, { unified5h: 0.1 }, { force: true });
  unwritable.record(A, { unified5h: 0.2 }, { force: true });
  await unwritable.flush();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Could not write the burn log/);
  assert.equal(unwritable.samples.get('anthropic/a').length, 2);
});

// ── per provider ──────────────────────────────────────────────

test('burn: per-provider aggregate, the pooled remaining capacity and the time to empty against the earliest reset', () => {
  const { clock, tracker } = clocked(T0 - HOUR);
  const accounts = [
    { name: 'a', type: 'oauth', quota: { unified5h: 0.60, unified5hReset: T0 + 2 * HOUR, unified7d: 0.50, unified7dReset: T0 + 3 * 24 * HOUR, scopedWeekly: {} } },
    { name: 'b', type: 'oauth', quota: { unified5h: 0.80, unified5hReset: T0 + HOUR, unified7d: 0.90, unified7dReset: T0 + 2 * 24 * HOUR, scopedWeekly: {} } },
    { name: 'off', type: 'oauth', disabled: true, quota: { unified5h: 0, unified5hReset: T0 + 10 * MIN, unified7d: 0, scopedWeekly: {} } },
    { name: 'dead', type: 'oauth', status: 'error', quota: { unified5h: 0, unified7d: 0, scopedWeekly: {} } },
    { name: 'k', type: 'oauth', provider: 'codex', accountId: 'x', quota: { unified5h: 0.10, unified7d: 0.20, scopedWeekly: {} } },
  ];
  const byName = Object.fromEntries(accounts.map(a => [a.name, a]));
  const at = (t, rows) => { clock.t = t; for (const [name, r] of rows) tracker.record(byName[name], r, { force: true }); };
  // An hour ago and now: a spends 0.10 of its 5h and 0.05 of its weekly, b 0.20
  // and 0.10, the Codex account 0.05 and 0.01; the two out of rotation spend nothing.
  at(T0 - HOUR, [['a', { unified5h: 0.50, unified7d: 0.45, inputTokens: 0, outputTokens: 0 }], ['b', { unified5h: 0.60, unified7d: 0.80, inputTokens: 0, outputTokens: 0 }],
    ['k', { unified5h: 0.05, unified7d: 0.19 }], ['off', { unified5h: 0 }], ['dead', { unified5h: 0 }]]);
  at(T0, [['a', { unified5h: 0.60, unified7d: 0.50, inputTokens: 300_000, outputTokens: 60_000 }], ['b', { unified5h: 0.80, unified7d: 0.90, inputTokens: 100_000, outputTokens: 20_000 }],
    ['k', { unified5h: 0.10, unified7d: 0.20 }], ['off', { unified5h: 0 }], ['dead', { unified5h: 0 }]]);

  const s = tracker.status(accounts, T0);
  assert.equal(s.sampledAt, new Date(T0).toISOString());
  const an = s.byProvider.anthropic;
  assert.equal(an.accounts, 4);
  near(an.windows.unified5h.perHour1h, 0.30);
  near(an.windows.unified7d.perHour1h, 0.15);
  // The pool is a and b: `off` is disabled and `dead` waits on a sign-in.
  near(an.windows.unified5h.pooledRemaining, 0.6);
  near(an.windows.unified7d.pooledRemaining, 0.6);
  near(an.windows.unified5h.pooledPctPerHour1h, 50);
  near(an.windows.unified5h.exhaustHours1h, 2);
  assert.equal(an.windows.unified5h.earliestReset, T0 + HOUR, "b's; the disabled account's sooner reset does not count");
  assert.equal(an.windows.unified5h.runsOutBeforeReset, false, 'empty in two hours, b resets in one');
  near(an.windows.unified7d.exhaustHours1h, 4);
  assert.equal(an.windows.unified7d.earliestReset, T0 + 2 * 24 * HOUR);
  assert.equal(an.windows.unified7d.runsOutBeforeReset, true, 'empty in four hours, the first weekly reset is in two days');
  near(an.tokens.inPerHour1h, 400_000);
  near(an.tokens.outPerHour1h, 80_000);
  const cx = s.byProvider.codex;
  near(cx.windows.unified5h.perHour1h, 0.05);
  near(cx.windows.unified5h.pooledRemaining, 0.9);
  near(cx.windows.unified5h.exhaustHours1h, 18);
  assert.equal(cx.windows.unified5h.earliestReset, null);
  assert.equal(cx.windows.unified5h.runsOutBeforeReset, null, 'no reset known, no verdict');
  assert.equal(cx.tokens.inPerHour1h, null, 'no counters were sampled for it');
  // Per account: the same rates, without the pooled fields.
  near(s.byAccount['anthropic/a'].windows.unified5h.perHour1h, 0.10);
  assert.equal(s.byAccount['anthropic/a'].provider, 'anthropic');
  assert.equal(s.byAccount['anthropic/a'].name, 'a');
  assert.equal(s.byAccount['codex/k'].provider, 'codex');
  assert.ok(!('pooledRemaining' in s.byAccount['anthropic/a'].windows.unified5h));
  assert.equal(s.byAccount['anthropic/dead'].windows.unified5h.perHour1h, 0);
  // Computed once for a few seconds; a new sample invalidates it.
  assert.equal(tracker.status(accounts, T0 + 1000), s);
  tracker.record(byName.a, { unified5h: 0.61 }, { force: true });
  assert.notEqual(tracker.status(accounts, T0 + 1000), s);
});

// ── what the readouts say ─────────────────────────────────────

test('burn: the formatters', () => {
  assert.deepEqual([0.11, 0.019, 0.0004, 0, null].map(formatRatePct), ['11%', '1.9%', '<0.1%', '0%', '-']);
  assert.deepEqual([1_234_567, 300_000, 850, null].map(formatTokens), ['1.2M', '300k', '850', '-']);
  assert.deepEqual([0.5, 7.27, 24, 52.6, 100, null].map(formatHours), ['30m', '7.3h', '24h', '53h', '4.2d', '-']);
  assert.deepEqual([42 * MIN, 5 * HOUR + 12 * MIN, 3 * 24 * HOUR + 2 * HOUR, 0, null].map(formatUntil), ['42m', '5h 12m', '3d 2h', '-', '-']);
});

function samplePayload() {
  const w = (perHour1h, perHour24h, rest = {}) => ({ perHour1h, perHour24h, pooledRemaining: null, pooledPctPerHour1h: null, exhaustHours1h: null, earliestReset: null, runsOutBeforeReset: null, ...rest });
  const noTokens = { inPerHour1h: null, outPerHour1h: null, inPerHour24h: null, outPerHour24h: null };
  return {
    sampledAt: new Date(T0 - 12_000).toISOString(),
    byProvider: {
      anthropic: {
        accounts: 2,
        windows: {
          unified5h: w(0.11, 0.09, { pooledRemaining: 0.8, pooledPctPerHour1h: 13.75, exhaustHours1h: 7.27, earliestReset: T0 + 3 * HOUR, runsOutBeforeReset: false }),
          unified7d: w(0.019, 0.017, { pooledRemaining: 1.0, pooledPctPerHour1h: 1.9, exhaustHours1h: 52.6, earliestReset: T0 + 3 * 24 * HOUR + 2 * HOUR, runsOutBeforeReset: true }),
          scopedWeekly: {},
        },
        tokens: { inPerHour1h: 1_200_000, outPerHour1h: 300_000, inPerHour24h: 1_000_000, outPerHour24h: 250_000 },
      },
      codex: { accounts: 1, windows: { unified5h: w(null, null), unified7d: w(null, null), scopedWeekly: {} }, tokens: noTokens },
    },
    byAccount: {
      'anthropic/alice@x.com': { name: 'alice@x.com', provider: 'anthropic', windows: { unified5h: { perHour1h: 0.11, perHour24h: 0.095 }, unified7d: { perHour1h: 0.019, perHour24h: 0.017 }, scopedWeekly: {} },
        tokens: { inPerHour1h: 1_200_000, outPerHour1h: 300_000, inPerHour24h: 1_000_000, outPerHour24h: 250_000 }, samples: 13, sampledAt: T0 },
      'codex/k@x.com': { name: 'k@x.com', provider: 'codex', windows: { unified5h: { perHour1h: null, perHour24h: null }, unified7d: { perHour1h: null, perHour24h: null }, scopedWeekly: {} }, tokens: noTokens, samples: 1, sampledAt: T0 },
    },
  };
}

test('burn: the provider line, the table, and the Burn rows of `status`', () => {
  const burn = samplePayload();
  const lines = burnSummaryLines(burn, T0);
  assert.equal(lines.length, 1, 'a provider with no rate yet has no line');
  assert.equal(lines[0].provider, 'anthropic');
  assert.equal(lines[0].text, 'anthropic  5h 11%/h  wk 1.9%/h  tok 1.2M in/300k out per h  wk pool 53h (reset 3d 2h) — runs out before reset');
  assert.equal(lines[0].critical, true);
  // The five-hour pool joins the line when it is the one running out.
  burn.byProvider.anthropic.windows.unified5h.runsOutBeforeReset = true;
  burn.byProvider.anthropic.windows.unified7d.runsOutBeforeReset = false;
  assert.match(burnSummaryLines(burn, T0)[0].text, /wk pool 53h \(reset 3d 2h\)  5h pool 7\.3h \(reset 3h\) — runs out before reset$/);
  burn.byProvider.anthropic.windows.unified5h.runsOutBeforeReset = false;
  // Idle: no rate to divide by, but a pool to report.
  burn.byProvider.anthropic.windows.unified7d.exhaustHours1h = null;
  assert.match(burnSummaryLines(burn, T0)[0].text, /wk pool 1\.0 windows left, idle$/);
  assert.equal(burnSummaryLines(burn, T0)[0].critical, false);

  const out = renderBurn(samplePayload(), { color: false, now: T0 });
  assert.match(out, /^Burn per hour \(last reading 12s ago; each figure: last 1 h \/ last 24 h\)/);
  assert.match(out, /^  anthropic  5h 11%\/h  wk 1\.9%\/h/m);
  assert.match(out, /^  Account\s+Provider\s+5h %\/h\s+wk %\/h\s+in tok\/h\s+out tok\/h$/m);
  assert.match(out, /^  alice@x\.com\s+anthropic\s+11% \/ 9\.5%\s+1\.9% \/ 1\.7%\s+1\.2M \/ 1\.0M\s+300k \/ 250k$/m);
  assert.match(out, /^  k@x\.com\s+codex\s+- \/ -\s+- \/ -\s+- \/ -\s+- \/ -$/m);
  const none = renderBurn({ byProvider: {}, byAccount: {} }, { color: false, now: T0 });
  assert.match(none, /no readings yet/);
  assert.match(none, /no rate yet/);
  // `teamclaude status` carries the provider lines, and none when the server sends no block.
  const status = renderStatus({ currentAccount: 'alice@x.com', switchThreshold: 0.98, accounts: [], burn: samplePayload() }, { color: false, now: T0 });
  assert.match(status, /^Burn\s+anthropic  5h 11%\/h/m);
  assert.doesNotMatch(renderStatus({ currentAccount: 'a', switchThreshold: 0.98, accounts: [] }, { color: false, now: T0 }), /Burn/);
});

// ── through the manager and the TUI ───────────────────────────

const SGR = /\x1b\[[0-9;]*m/g;

/** The rows of one full frame at 120 columns, colour stripped. */
function frame(am, { remote = false } = {}) {
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
  return buf.replace(SGR, '').split('\r\n');
}

test('burn: the manager samples probe results and header readings, and the TUI draws the provider line, live and attached', () => {
  const T = Date.now();
  const clock = { t: T - HOUR };
  const burn = new BurnTracker({ now: () => clock.t, log: () => {} });
  const am = new AccountManager([
    { name: 'a@x.com', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: T + 8 * HOUR },
  ], 0.98, { burn });
  const log = console.log;
  console.log = () => {};
  try {
    am.applyUsageData(0, { fiveHour: { utilization: 0.10, resetAt: T + 3 * HOUR }, sevenDay: { utilization: 0.50, resetAt: T + 3 * 24 * HOUR } });
    am.updateUsage(0, 120_000, 30_000);
    clock.t = T;
    am.applyUsageData(0, { fiveHour: { utilization: 0.21 }, sevenDay: { utilization: 0.52 } });
  } finally { console.log = log; }

  const s = am.getStatus();
  near(s.burn.byProvider.anthropic.windows.unified5h.perHour1h, 0.11);
  near(s.burn.byProvider.anthropic.windows.unified7d.perHour1h, 0.02);
  near(s.burn.byProvider.anthropic.windows.unified7d.exhaustHours1h, 24);
  assert.equal(s.burn.byProvider.anthropic.windows.unified7d.runsOutBeforeReset, true);
  near(s.burn.byAccount['anthropic/a@x.com'].tokens.inPerHour1h, 120_000);
  assert.equal(s.burn.byAccount['anthropic/a@x.com'].samples, 2);

  const expected = /burn\s+anthropic  5h 11%\/h  wk 2\.0%\/h  tok 120k in\/30k out per h  wk pool 24h \(reset 3d\) — runs out before reset/;
  const live = frame(am);
  assert.ok(live[2] && expected.test(live[2]), `under the header:\n${live.slice(0, 4).join('\n')}`);
  const rm = new RemoteAccountManager();
  rm.applyStatus(am.getStatus());
  const attached = frame(rm, { remote: true });
  assert.ok(attached[2] && expected.test(attached[2]), `attached:\n${attached.slice(0, 4).join('\n')}`);

  // A header reading within a minute of the last sample is folded; a later one lands.
  am._sampleBurn(am.accounts[0]);
  assert.equal(burn.samples.get('anthropic/a@x.com').length, 2);
  clock.t = T + MIN;
  am._sampleBurn(am.accounts[0]);
  assert.equal(burn.samples.get('anthropic/a@x.com').length, 3);
  // The dedicated Fable field stands in for a scoped bucket the probe did not list.
  am.accounts[0].quota.unified7dFable = 0.3;
  clock.t = T + 2 * MIN;
  am._sampleBurn(am.accounts[0], { probe: true });
  assert.equal(burn.samples.get('anthropic/a@x.com')[3].scopedWeekly.fable, 0.3);
});
