// Burn per hour: how fast each account, and each provider's pool, is spending
// its quota windows and its tokens, from readings the server already has.
//
// Every quota reading — a probe result, a response header — lands in the
// account manager, and until now none of them was kept: the dashboards showed
// the level of each window and nothing about its slope. The tracker keeps a
// short history per account (one sample per landing, 48 h, in memory and in
// a JSONL file beside the config so a restart keeps it) and derives rates
// from it on demand. Per window, the utilization spent per hour over the last
// hour and the last day, counting rises only: a drop is a reset — the window
// rolled over, or a token counter started again after a restart — and opens
// a new segment, never negative burn. Per account, tokens per hour from the
// cumulative counters the same way. Per provider the per-account rates are
// summed and set against the pool's remaining capacity, which gives hours to
// empty and whether that comes before the earliest reset.
//
// Nothing here steers routing. Adaptive distribution has its own smoothed
// estimate for reserves (BurnRateLearner); this is the operator's readout.

import { appendFile, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { providerOf } from './provider.js';
import { safeLine } from './safe-text.js';

export const BURN_RETENTION_MS = 48 * 60 * 60 * 1000;
export const BURN_HORIZONS_MS = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };
// A header reading arrives with every response; one sample a minute per
// account is all a rate over an hour can use, so the rest are folded away. A
// probe result always lands: it is the reading the operator asked for.
export const MIN_SAMPLE_GAP_MS = 60 * 1000;
// How far before a horizon its baseline sample may sit. The reading just
// before the window gives the span its full length; one from hours before it
// (the server was idle) would average the rate over the idle stretch.
const BASELINE_SLACK_MS = 10 * 60 * 1000;
// Against a clock that runs backwards or a flood: 48 h at one a minute, with room.
const MAX_SAMPLES = 4000;
// A status payload is read on every dashboard frame; the rates do not move
// between two readings, so a computed one is good for a few seconds.
const STATUS_CACHE_MS = 5000;

const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @typedef {{ t: number, unified5h: number|null, unified7d: number|null, scopedWeekly: Record<string, number>, inputTokens: number|null, outputTokens: number|null }} BurnSample
 * @typedef {{ perHour1h: number|null, perHour24h: number|null }} SeriesRates
 */

/** A sample as stored: the readings at `t`, null where there was none. */
function makeSample(t, reading) {
  /** @type {Record<string, number>} */
  const scoped = {};
  for (const [bucket, value] of Object.entries(reading?.scopedWeekly || {})) {
    const u = num(value);
    if (u != null) scoped[safeLine(bucket, 32)] = u;
  }
  return {
    t,
    unified5h: num(reading?.unified5h),
    unified7d: num(reading?.unified7d),
    scopedWeekly: scoped,
    inputTokens: num(reading?.inputTokens),
    outputTokens: num(reading?.outputTokens),
  };
}

/** One series of a sample: a window, a scoped bucket (`scoped:fable`) or a token counter. */
function seriesValue(sample, key) {
  if (key.startsWith('scoped:')) return num(sample.scopedWeekly?.[key.slice('scoped:'.length)]);
  return num(sample[key]);
}

/**
 * Burn of one series over the last `horizonMs`, per hour: the sum of the
 * rises between consecutive readings, divided by the time they span. A drop
 * is a reset and opens a new segment; nothing is counted across it. The
 * reading just before the horizon is the baseline when it is near enough
 * (BASELINE_SLACK_MS), so the span is the whole horizon once the history
 * reaches back that far. Null with fewer than two readings of the series.
 *
 * @param {BurnSample[]} samples  oldest first
 * @param {string} key
 * @param {number} now
 * @param {number} horizonMs
 * @returns {number|null}
 */
export function burnPerHour(samples, key, now, horizonMs) {
  const from = now - horizonMs;
  let first = samples.findIndex(s => s.t > from);
  if (first === -1) first = samples.length;
  if (first > 0 && from - samples[first - 1].t <= BASELINE_SLACK_MS) first -= 1;
  let prev = null, firstT = null, lastT = null, rise = 0, count = 0;
  for (let i = first; i < samples.length; i++) {
    const v = seriesValue(samples[i], key);
    if (v == null) continue;
    if (firstT == null) firstT = samples[i].t;
    lastT = samples[i].t;
    count++;
    if (prev != null && v > prev) rise += v - prev;
    prev = v;
  }
  if (count < 2 || !(lastT > firstT)) return null;
  return rise / ((lastT - firstT) / 3_600_000);
}

/** @returns {SeriesRates} */
function seriesRates(samples, key, now) {
  return {
    perHour1h: burnPerHour(samples, key, now, BURN_HORIZONS_MS['1h']),
    perHour24h: burnPerHour(samples, key, now, BURN_HORIZONS_MS['24h']),
  };
}

/** Every rate of one account, from its samples. */
function accountRates(samples, now) {
  /** @type {Record<string, SeriesRates>} */
  const scopedWeekly = {};
  for (const bucket of new Set(samples.flatMap(s => Object.keys(s.scopedWeekly || {})))) {
    scopedWeekly[bucket] = seriesRates(samples, `scoped:${bucket}`, now);
  }
  const tokIn = seriesRates(samples, 'inputTokens', now);
  const tokOut = seriesRates(samples, 'outputTokens', now);
  return {
    windows: { unified5h: seriesRates(samples, 'unified5h', now), unified7d: seriesRates(samples, 'unified7d', now), scopedWeekly },
    tokens: { inPerHour1h: tokIn.perHour1h, outPerHour1h: tokOut.perHour1h, inPerHour24h: tokIn.perHour24h, outPerHour24h: tokOut.perHour24h },
    samples: samples.length,
    sampledAt: samples.length ? samples[samples.length - 1].t : null,
  };
}

/** The series of a window key in an account's rates. */
function seriesOf(rates, key) {
  if (key.startsWith('scoped:')) return rates.windows.scopedWeekly[key.slice('scoped:'.length)] || null;
  return rates.windows[key] || null;
}

/** The current level and reset of one window on a live account, from its quota record. */
function currentWindow(account, key) {
  const q = account?.quota || {};
  if (key.startsWith('scoped:')) {
    const b = q.scopedWeekly?.[key.slice('scoped:'.length)];
    return { utilization: num(b?.utilization), resetAt: num(b?.resetAt) };
  }
  return { utilization: num(q[key]), resetAt: num(q[`${key}Reset`]) };
}

/** The sum of the numbers among `values`, or null when there is none. */
function sum(values) {
  const xs = values.filter(v => v != null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
}

/**
 * One window of one provider's pool: the per-account burns summed, and that
 * against what the pool has left. `pooledRemaining` is the sum over the
 * accounts rotation can reach (not disabled, not in `error`) of 1 minus the
 * window's current level, in windows; an account with no reading is not
 * counted. From the hourly burn: the share of the pool spent per hour, the
 * hours until it is empty, and whether that comes before the earliest reset
 * among those accounts.
 */
function providerWindow(entries, key, now) {
  const perHour1h = sum(entries.map(e => seriesOf(e.rates, key)?.perHour1h));
  const perHour24h = sum(entries.map(e => seriesOf(e.rates, key)?.perHour24h));
  let pooledRemaining = null;
  let earliestReset = null;
  for (const { account } of entries) {
    if (account.disabled || account.status === 'error') continue;
    const { utilization, resetAt } = currentWindow(account, key);
    if (utilization != null) pooledRemaining = (pooledRemaining ?? 0) + Math.max(0, 1 - utilization);
    if (resetAt != null && resetAt > now && (earliestReset == null || resetAt < earliestReset)) earliestReset = resetAt;
  }
  const pooledPctPerHour1h = perHour1h != null && pooledRemaining != null && pooledRemaining > 0 ? perHour1h / pooledRemaining * 100 : null;
  const exhaustHours1h = perHour1h != null && perHour1h > 0 && pooledRemaining != null ? pooledRemaining / perHour1h : null;
  const runsOutBeforeReset = exhaustHours1h != null && earliestReset != null ? now + exhaustHours1h * 3_600_000 < earliestReset : null;
  return { perHour1h, perHour24h, pooledRemaining, pooledPctPerHour1h, exhaustHours1h, earliestReset, runsOutBeforeReset };
}

export class BurnTracker {
  /**
   * @param {{ path?: string|null, retentionMs?: number, now?: () => number, log?: (line: string) => void }} [opts]
   *   `path`: the JSONL file (none: memory only, as in tests). `now` is
   *   injectable so a test can lay samples out in time.
   */
  constructor({ path = null, retentionMs = BURN_RETENTION_MS, now = () => Date.now(), log = (/** @type {string} */ line) => console.error(line) } = {}) {
    this.path = path;
    this.retentionMs = retentionMs;
    this.now = now;
    this.log = log;
    /** @type {Map<string, BurnSample[]>} oldest first, per account name */
    this.samples = new Map();
    this._seq = 0;
    /** @type {{ seq: number, now: number, n: number, value: any }|null} */
    this._cache = null;
    // Appends are chained so lines land in order; a failure is said once.
    this._writes = Promise.resolve();
    this._writeFailed = false;
  }

  /**
   * Record a reading for an account. A probe result (`force`) always lands;
   * a header reading only when the last sample is MIN_SAMPLE_GAP_MS old.
   * @param {string} name
   * @param {{ unified5h?: unknown, unified7d?: unknown, scopedWeekly?: Record<string, unknown>, inputTokens?: unknown, outputTokens?: unknown }} reading
   * @param {{ force?: boolean }} [opts]
   * @returns {boolean} whether it was kept
   */
  record(name, reading, { force = false } = {}) {
    const t = this.now();
    let ring = this.samples.get(name);
    if (!ring) { ring = []; this.samples.set(name, ring); }
    const last = ring[ring.length - 1];
    if (!force && last && t - last.t < MIN_SAMPLE_GAP_MS) return false;
    const sample = makeSample(t, reading);
    ring.push(sample);
    // Out of order (a clock stepped back): keep the series sorted, since the
    // rates read consecutive pairs.
    if (last && last.t > t) ring.sort((a, b) => a.t - b.t);
    this._trim(ring, t);
    this._seq++;
    this._append(name, sample);
    return true;
  }

  _trim(ring, now) {
    const cutoff = now - this.retentionMs;
    while (ring.length && ring[0].t < cutoff) ring.shift();
    while (ring.length > MAX_SAMPLES) ring.shift();
  }

  _append(name, sample) {
    if (!this.path) return;
    const line = JSON.stringify({ name, ...sample }) + '\n';
    this._writes = this._writes
      .then(() => appendFile(/** @type {string} */ (this.path), line, { mode: 0o600 }))
      .catch(err => {
        if (this._writeFailed) return;
        this._writeFailed = true;
        this.log(`[TeamClaude] Could not write the burn log ${this.path}: ${err.message} — rates go on in memory only`);
      });
  }

  /** Resolves once every append so far has been written (tests). */
  flush() {
    return this._writes;
  }

  /**
   * Read the log back, keep what is still within retention, and compact the
   * file to exactly that — so expired samples and a line cut short by a
   * crash mid-append (skipped here) do not accumulate.
   * @returns {Promise<{ loaded: number, dropped: number }>}
   */
  async load() {
    if (!this.path) return { loaded: 0, dropped: 0 };
    let text;
    try {
      text = await readFile(this.path, 'utf-8');
    } catch (/** @type {any} */ err) {
      if (err?.code === 'ENOENT') return { loaded: 0, dropped: 0 };
      throw err;
    }
    const cutoff = this.now() - this.retentionMs;
    let loaded = 0, dropped = 0;
    /** @type {Map<string, BurnSample[]>} */
    const rings = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { dropped++; continue; }
      if (!row || typeof row !== 'object' || typeof row.name !== 'string' || !Number.isFinite(row.t)) { dropped++; continue; }
      if (row.t < cutoff) { dropped++; continue; }
      const { name, t, ...reading } = row;
      let ring = rings.get(name);
      if (!ring) { ring = []; rings.set(name, ring); }
      ring.push(makeSample(t, reading));
      loaded++;
    }
    for (const [name, ring] of rings) {
      ring.sort((a, b) => a.t - b.t);
      while (ring.length > MAX_SAMPLES) ring.shift();
      this.samples.set(name, ring);
    }
    this._seq++;
    const kept = [];
    for (const [name, ring] of this.samples) for (const s of ring) kept.push(JSON.stringify({ name, ...s }));
    const tmp = `${this.path}.tmp`;
    try {
      await writeFile(tmp, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
      await rename(tmp, this.path);
    } catch (/** @type {any} */ err) {
      await unlink(tmp).catch(() => {});
      this.log(`[TeamClaude] Could not compact the burn log ${this.path}: ${err.message}`);
    }
    return { loaded, dropped };
  }

  /** Every rate of one account. */
  rates(name, now = this.now()) {
    return accountRates(this.samples.get(name) || [], now);
  }

  /**
   * The `burn` block of the status payload: per provider, each window's
   * summed burn against the pool and the token rates; per account, the same
   * without the pooled fields. `accounts` are the manager's live records
   * (provider, disabled, status, quota).
   * @param {Record<string, any>[]} accounts
   * @param {number} [now]
   */
  status(accounts, now = this.now()) {
    const c = this._cache;
    if (c && c.seq === this._seq && c.n === accounts.length && now - c.now >= 0 && now - c.now < STATUS_CACHE_MS) return c.value;
    /** @type {Record<string, any>} */
    const byAccount = {};
    /** @type {Map<string, { account: any, rates: any }[]>} */
    const groups = new Map();
    let latest = null;
    for (const account of accounts) {
      const rates = accountRates(this.samples.get(account.name) || [], now);
      if (rates.sampledAt != null && (latest == null || rates.sampledAt > latest)) latest = rates.sampledAt;
      const provider = providerOf(account);
      byAccount[account.name] = { provider, ...rates };
      let group = groups.get(provider);
      if (!group) { group = []; groups.set(provider, group); }
      group.push({ account, rates });
    }
    /** @type {Record<string, any>} */
    const byProvider = {};
    for (const [provider, entries] of groups) {
      /** @type {Record<string, any>} */
      const scopedWeekly = {};
      for (const bucket of new Set(entries.flatMap(e => Object.keys(e.rates.windows.scopedWeekly)))) {
        scopedWeekly[bucket] = providerWindow(entries, `scoped:${bucket}`, now);
      }
      byProvider[provider] = {
        accounts: entries.length,
        windows: { unified5h: providerWindow(entries, 'unified5h', now), unified7d: providerWindow(entries, 'unified7d', now), scopedWeekly },
        tokens: {
          inPerHour1h: sum(entries.map(e => e.rates.tokens.inPerHour1h)),
          outPerHour1h: sum(entries.map(e => e.rates.tokens.outPerHour1h)),
          inPerHour24h: sum(entries.map(e => e.rates.tokens.inPerHour24h)),
          outPerHour24h: sum(entries.map(e => e.rates.tokens.outPerHour24h)),
        },
      };
    }
    const value = {
      sampledAt: latest == null ? null : new Date(latest).toISOString(),
      horizons: { ...BURN_HORIZONS_MS },
      retentionMs: this.retentionMs,
      byProvider,
      byAccount,
    };
    this._cache = { seq: this._seq, now, n: accounts.length, value };
    return value;
  }
}

// ── formatting, shared by the TUI and the CLI ────────────────

/** A window's burn as a percentage: `11%`, `1.9%`, `<0.1%`, `0%`; `-` for none. */
export function formatRatePct(fraction) {
  if (fraction == null || !Number.isFinite(fraction)) return '-';
  const pct = fraction * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 0.1) return `${pct.toFixed(1)}%`;
  return pct > 0 ? '<0.1%' : '0%';
}

/** A token count: `1.2M`, `300k`, `850`; `-` for none. */
export function formatTokens(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${Math.round(n)}`;
}

/** A number of hours: `40m`, `7.2h`, `52h`, `4.2d`; `-` for none. */
export function formatHours(h) {
  if (h == null || !Number.isFinite(h)) return '-';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 10) return `${h.toFixed(1)}h`;
  if (h < 72) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Time until a moment, from a span in ms: `42m`, `5h 12m`, `3d 2h`; `-` when it has passed. */
export function formatUntil(ms) {
  if (ms == null || !(ms > 0)) return '-';
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60), rm = mins % 60;
  if (hrs < 24) return rm ? `${hrs}h ${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24), rh = hrs % 24;
  return rh ? `${days}d ${rh}h` : `${days}d`;
}

/** The pool clause of a provider line for one window, or null when there is nothing to say. */
function poolText(label, w, now) {
  if (!w) return null;
  if (w.exhaustHours1h != null) {
    const reset = w.earliestReset != null ? ` (reset ${formatUntil(w.earliestReset - now)})` : '';
    return `${label} pool ${formatHours(w.exhaustHours1h)}${reset}${w.runsOutBeforeReset ? ' — runs out before reset' : ''}`;
  }
  if (w.pooledRemaining != null) return `${label} pool ${w.pooledRemaining.toFixed(1)} windows left, idle`;
  return null;
}

/**
 * One line per provider for the dashboards, e.g.
 * `anthropic  5h 11%/h  wk 1.9%/h  tok 1.2M in/300k out per h  wk pool 52h (reset 3d 2h)`,
 * `critical` when a pool runs out before its reset. A provider with no rate
 * yet (fewer than two readings) gets no line. The payload may come off the
 * wire (attach mode), so its names are cut down here.
 * @param {any} burn  the status payload's `burn`
 * @param {number} [now]
 * @returns {{ provider: string, text: string, critical: boolean }[]}
 */
export function burnSummaryLines(burn, now = Date.now()) {
  const out = [];
  const providers = burn?.byProvider && typeof burn.byProvider === 'object' ? Object.entries(burn.byProvider) : [];
  for (const [rawProvider, entry] of providers) {
    const provider = safeLine(rawProvider, 16);
    const w5 = entry?.windows?.unified5h, w7 = entry?.windows?.unified7d, tok = entry?.tokens;
    const parts = [];
    if (w5?.perHour1h != null) parts.push(`5h ${formatRatePct(w5.perHour1h)}/h`);
    if (w7?.perHour1h != null) parts.push(`wk ${formatRatePct(w7.perHour1h)}/h`);
    if (tok?.inPerHour1h != null || tok?.outPerHour1h != null) {
      parts.push(`tok ${formatTokens(tok.inPerHour1h ?? 0)} in/${formatTokens(tok.outPerHour1h ?? 0)} out per h`);
    }
    if (!parts.length) continue;
    const pools = [poolText('wk', w7, now) || poolText('5h', w5, now)];
    if (w5?.runsOutBeforeReset && pools[0] && !pools[0].startsWith('5h')) pools.push(poolText('5h', w5, now));
    for (const pool of pools) if (pool) parts.push(pool);
    const critical = w5?.runsOutBeforeReset === true || w7?.runsOutBeforeReset === true;
    out.push({ provider, text: `${provider.padEnd(9)}  ${parts.join('  ')}`, critical });
  }
  return out;
}
