// The banked resets an account holds, laid out for `teamclaude redeem`: every
// reset, what kind it is, what it clears, when it expires, and which one a
// redemption would spend next. Read-only: nothing here spends anything.
//
// A Claude account may hold several grants at once (a monthly full reset, the
// Fable launch resets, ...), but Anthropic decides which is spent: a claim may
// only name the payload's `next_grant_id` (see claude-resets.js). So the list
// marks that one, and the operator confirms it by its `ref` — a short hash of
// the grant id, never the id itself — so a confirmation cannot spend a
// different reset than the one shown if the next in line changed meanwhile.
// A Codex account's credits are spent soonest-expiry first (redeemableCredit).

import { createHash } from 'node:crypto';
import { isFableReset } from './oauth.js';
import { safeLine } from './safe-text.js';

/** A short, stable handle for one reset (a hash of its id): what the CLI confirms. @param {string} id */
export function resetRef(id) {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
}

const LIMIT_NAMES = /** @type {Record<string, string>} */ ({
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_overage_included: 'Fable',
});

/** @param {string} limit */
export const limitName = (/** @type {string} */ limit) => LIMIT_NAMES[limit] ?? safeLine(limit, 32);

/** The kind a grant's `clears` make it: `full` clears the shared weekly, `fable` only the Fable weekly. @param {string[]} clears */
export function resetKind(clears) {
  if (clears.includes('seven_day')) return 'full';
  if (isFableReset(clears)) return 'fable';
  return 'other';
}

const KIND_NAMES = /** @type {Record<string, string>} */ ({ full: 'Full reset', fable: 'Fable reset', other: 'Reset' });

/** @param {unknown} v */
const isoMs = v => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
/** @param {unknown} v */
const pct = v => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
/** @param {unknown} v */
const count = v => (Number.isInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : 0);
/** @param {unknown} v */
const limits = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 64) : []);

/**
 * What a Claude usage payload says about the account's resets, for display.
 * Null when the payload carries no reset block at all.
 *
 * @param {any} data  the whole `/api/oauth/usage` payload (`?cedar_ember=1`)
 * @param {number} [now]
 */
export function describeClaudeResets(data, now = Date.now()) {
  const block = data?.cedar_ember;
  if (!block || typeof block !== 'object' || typeof block.eligible !== 'boolean') return null;
  const shares = Array.isArray(data?.weekly_scoped_shares) ? data.weekly_scoped_shares : [];
  const fableShare = shares.map((/** @type {any} */ s) => pct(s?.used_percent_of_weekly)).find(v => v != null) ?? null;
  const window = (/** @type {any} */ w) => (w && typeof w === 'object' ? { percent: pct(w.utilization), resetAt: isoMs(w.resets_at) } : null);
  const grants = (Array.isArray(block.grants) ? block.grants : []).flatMap((/** @type {any} */ g) => {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string') return [];
    const clears = limits(g.clears);
    const endsAt = isoMs(g.ends_at);
    if (endsAt != null && endsAt <= now) return [];
    /** @type {Record<string, number>} */
    const percentUsed = {};
    if (g.percent_used && typeof g.percent_used === 'object') {
      for (const [k, v] of Object.entries(g.percent_used)) { const p = pct(v); if (p != null && k.length <= 64) percentUsed[k] = p; }
    }
    return [{
      ref: resetRef(g.id),
      next: g.id === block.next_grant_id,
      label: typeof g.label === 'string' ? safeLine(g.label, 120) : null,
      kind: resetKind(clears),
      clears,
      left: count(g.resets_left),
      total: count(g.resets_total),
      startsAt: isoMs(g.starts_at),
      endsAt,
      usableNow: g.usable_now === true,
      unavailableReason: typeof g.unavailable_reason === 'string' ? safeLine(g.unavailable_reason, 40) : null,
      requiresLimit: g.use_requires_limit === true,
      paused: g.paused === true,
      givesBackWeekly: g.gives_back_weekly === true,
      percentUsed,
    }];
  });
  return {
    provider: 'anthropic',
    eligible: block.eligible,
    ineligibleReason: typeof block.ineligible_reason === 'string' ? safeLine(block.ineligible_reason, 40) : null,
    atLimit: block.at_limit === true,
    exhausted: limits(block.exhausted),
    cooldownUntil: isoMs(block.cooldown_until),
    usage: {
      weekly: window(data?.seven_day),
      fiveHour: window(data?.five_hour),
      fableShareOfWeekly: fableShare,
    },
    grants,
  };
}

/**
 * A Codex account's credit rows (fetchResetCreditDetails), for display.
 * `nextId` is the credit redeemOnRequest would spend (redeemableCredit: the
 * soonest-expiring one the plan can use), passed in so the two cannot disagree.
 *
 * @param {Array<{ id: string, status: string|null, supportedByPlan: boolean, expiresAt: number|null, title: string|null }>} rows
 * @param {string|null} nextId
 * @param {number} [now]
 */
export function describeCodexCredits(rows, nextId, now = Date.now()) {
  const live = rows.filter(r => r.status === 'available' && (r.expiresAt == null || r.expiresAt > now));
  const next = live.find(r => r.id === nextId) ?? null;
  return {
    provider: 'codex',
    credits: live.map(r => ({
      ref: resetRef(r.id),
      next: r === next,
      label: r.title ? safeLine(r.title, 120) : null,
      endsAt: r.expiresAt,
      supportedByPlan: r.supportedByPlan !== false,
    })),
  };
}

/** The reset a redemption on this entry would spend, or null. @param {any} entry */
export function nextReset(entry) {
  const list = entry?.claude?.grants ?? entry?.codex?.credits ?? [];
  const next = list.find((/** @type {any} */ r) => r.next);
  if (!next) return null;
  if (entry.claude && (next.left < 1 || !next.usableNow || next.paused)) return null;
  if (entry.codex && !next.supportedByPlan) return null;
  return next;
}

/** "Full reset", "Fable reset", "Reset credit". @param {any} reset */
export function resetKindName(reset) {
  return reset?.kind ? KIND_NAMES[reset.kind] : 'Reset credit';
}

// ── formatting ──────────────────────────────────────────────────────────────

/** @param {boolean} on */
export function resetPaint(on) {
  const wrap = (/** @type {number} */ code) => (/** @type {unknown} */ v) => (on ? `\x1b[${code}m${v}\x1b[0m` : String(v));
  return { bold: wrap(1), dim: wrap(2), cyan: wrap(36), yellow: wrap(33), green: wrap(32), red: wrap(31) };
}

/** `4d6h`, `7h25m`, `12m`. @param {number} ms */
function span(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return mins % 60 ? `${hrs}h${mins % 60}m` : `${hrs}h`;
  return hrs % 24 ? `${Math.floor(hrs / 24)}d${hrs % 24}h` : `${Math.floor(hrs / 24)}d`;
}

/** `10 Dec 22:00 (in 29d)`, with the year when it is not this one. @param {number} t @param {number} now */
function when(t, now) {
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time} (${t > now ? `in ${span(t - now)}` : `${span(now - t)} ago`})`;
}

/** What spending `g` would do to the account's usage, from the payload's own numbers. @param {any} g @param {any} claude */
function givesBack(g, claude) {
  /** @type {string[]} */
  const parts = [];
  const weekly = claude.usage.weekly?.percent ?? g.percentUsed.seven_day ?? null;
  for (const limit of g.clears) {
    const used = limit === 'seven_day' ? weekly : g.percentUsed[limit] ?? (limit === 'five_hour' ? claude.usage.fiveHour?.percent : null);
    if (used != null) parts.push(`${limitName(limit)} ${used}% → 0%`);
  }
  if (!g.clears.includes('seven_day') && g.givesBackWeekly && weekly != null && claude.usage.fableShareOfWeekly != null) {
    parts.push(`weekly ${weekly}% → ${Math.max(0, weekly - claude.usage.fableShareOfWeekly)}%`);
  }
  return parts.join(', ');
}

/** Why a grant that is not next cannot be spent now, or that it waits its turn. @param {any} g @param {number} now */
function grantState(g, now) {
  if (g.left < 1) return 'spent';
  if (g.paused) return 'paused';
  if (g.startsAt != null && g.startsAt > now) return `usable from ${when(g.startsAt, now)}`;
  if (g.unavailableReason === 'cooldown') return 'cooling down';
  if (!g.usableNow) return g.unavailableReason ? `not usable now (${g.unavailableReason})` : 'not usable now';
  if (g.next) return 'spent next';
  return 'waits behind the one marked ►';
}

/**
 * The listing `teamclaude redeem` prints.
 *
 * @param {any[]} entries  `{ account, provider, error?, claude?, codex? }` per account
 * @param {{ now?: number, color?: boolean }} [opts]
 */
export function formatResetList(entries, { now = Date.now(), color = false } = {}) {
  const p = resetPaint(color);
  /** @type {string[]} */
  const out = [];
  for (const entry of entries) {
    const name = p.bold(safeLine(entry.account, 64));
    if (entry.error) { out.push(`${name}  ${p.red(`could not read its resets: ${safeLine(entry.error, 120)}`)}`, ''); continue; }
    if (entry.claude) {
      const c = entry.claude;
      const u = c.usage;
      const head = [];
      if (u.weekly?.percent != null) head.push(`weekly ${u.weekly.percent}%${u.weekly.resetAt ? `, resets ${when(u.weekly.resetAt, now)}` : ''}`);
      const fable = c.grants.find((/** @type {any} */ g) => g.percentUsed.seven_day_overage_included != null)?.percentUsed.seven_day_overage_included;
      if (fable != null) head.push(`Fable ${fable}%`);
      if (u.fiveHour?.percent != null) head.push(`5-hour ${u.fiveHour.percent}%`);
      out.push(`${name}  ${p.dim(head.join(' · '))}`);
      if (!c.eligible) { out.push(`  ${p.yellow(`not eligible for resets${c.ineligibleReason ? ` (${c.ineligibleReason})` : ''}`)}`, ''); continue; }
      if (c.cooldownUntil != null && c.cooldownUntil > now) out.push(`  ${p.yellow(`cooling down after a reset: none can be spent until ${when(c.cooldownUntil, now)}`)}`);
      if (c.atLimit && c.exhausted.length) out.push(`  ${p.yellow(`at its limit: ${c.exhausted.map(limitName).join(', ')}`)}`);
      const held = c.grants.filter((/** @type {any} */ g) => g.left > 0);
      if (!held.length) out.push(`  ${p.dim('holds no reset')}`);
      for (const g of held) {
        const mark = g.next ? p.cyan('►') : ' ';
        const leftText = g.total > 1 ? `${g.left} of ${g.total} left` : '1 left';
        out.push(`  ${mark} ${p.bold(KIND_NAMES[g.kind].padEnd(12))}${leftText.padEnd(12)}${g.endsAt ? `expires ${when(g.endsAt, now)}` : 'no expiry'}`);
        out.push(`      ${p.dim(`clears ${g.clears.map(limitName).join(', ') || 'nothing listed'}`)}${g.requiresLimit ? p.dim(' · only at a usage limit') : ''}`);
        const state = grantState(g, now);
        const back = g.next && g.usableNow ? givesBack(g, c) : '';
        out.push(`      ${p.dim(state)}${back ? p.dim(' · ') + p.green(back) : ''}`);
        if (g.label) out.push(p.dim(`      ${g.label}`));
      }
      const spent = c.grants.filter((/** @type {any} */ g) => g.left < 1);
      if (spent.length) out.push(p.dim(`    already spent: ${countKinds(spent, g => g.total || 1)}`));
      out.push('');
      continue;
    }
    if (entry.codex) {
      out.push(`${name}  ${p.dim(`${entry.codex.credits.length} reset ${entry.codex.credits.length === 1 ? 'credit' : 'credits'}`)}`);
      if (!entry.codex.credits.length) out.push(`  ${p.dim('holds no reset credit')}`);
      for (const r of entry.codex.credits) {
        out.push(`  ${r.next ? p.cyan('►') : ' '} ${p.bold('Reset credit'.padEnd(14))}${r.endsAt ? `expires ${when(r.endsAt, now)}` : 'no expiry'}`);
        out.push(`      ${p.dim(r.supportedByPlan ? (r.next ? 'spent next' : 'after the one marked ►') : 'not usable on this plan')}`);
        if (r.label) out.push(p.dim(`      ${r.label}`));
      }
      out.push('');
    }
  }
  if (entries.some(e => e.claude?.grants?.length || e.codex?.credits?.length)) {
    out.push(p.dim('► is what `teamclaude redeem <account>` spends next. Anthropic sets the order of Claude resets;'));
    out.push(p.dim('  a Codex account spends the credit that expires soonest.'));
  }
  return out.join('\n').replace(/\n+$/, '');
}

/** "1 full reset, 3 Fable resets", counting each grant as `n(grant)`. @param {any[]} grants @param {(g: any) => number} n */
function countKinds(grants, n) {
  const nouns = /** @type {Record<string, string>} */ ({ full: 'full reset', fable: 'Fable reset', other: 'reset' });
  /** @type {Record<string, number>} */
  const by = {};
  for (const g of grants) by[g.kind] = (by[g.kind] ?? 0) + n(g);
  return Object.entries(by).map(([k, c]) => `${c} ${nouns[k]}${c === 1 ? '' : 's'}`).join(', ');
}

/** "1 Fable reset; the soonest expires 9 Mar 2027 ..."-style summary of what an entry still holds. @param {any} entry @param {number} [now] */
export function heldSummary(entry, now = Date.now()) {
  if (entry?.codex) return `${entry.codex.credits.length} reset ${entry.codex.credits.length === 1 ? 'credit' : 'credits'}`;
  const held = (entry?.claude?.grants ?? []).filter((/** @type {any} */ g) => g.left > 0);
  if (!held.length) return 'no resets';
  const soonest = Math.min(...held.map((/** @type {any} */ g) => g.endsAt ?? Infinity));
  return countKinds(held, g => g.left) + (Number.isFinite(soonest) ? `; the soonest expires ${when(soonest, now)}` : '');
}
