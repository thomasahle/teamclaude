// How many banked resets an account holds, as far as anything should report
// or act on. One rule for the status screen, the TUI row and the Fable focus
// (account-manager.js), so none of them can disagree about whether a reset is
// there. Its own module because account-manager.js cannot import
// status-renderer.js, which reaches account-manager.js through config-ops.js.

// How long a reset-credit reading is worth showing. Nothing refreshes the count
// but the usage probe, and the probe is off by default, so a credit that was
// redeemed or expired would otherwise stay on screen indefinitely. A week is the
// longest Codex window: past it, every window the credit could have reset has
// reset on its own, and the reading describes a situation that is gone.
export const RESET_CREDIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many reset credits to REPORT for this quota: the held count while the
 * reading is fresh, 0 once it is older than RESET_CREDIT_MAX_AGE_MS, past its
 * stated `expiresAt`, or states no positive count. One rule for the status screen and the TUI row, so the two
 * cannot disagree about whether a credit is there (the dashboard page applies
 * the same cut-off in its own serialized helper).
 *
 * A reading with no `seenAt` is shown: its age is unknown rather than old, and
 * every reading the proxy stores itself is stamped.
 *
 * @param {Record<string, any>|null|undefined} quota
 * @param {number} [now]  ms epoch the age is measured from
 * @returns {number}
 */
export function heldResetCredits(quota, now = Date.now()) {
  const credits = quota?.resetCredits;
  const available = credits?.available;
  if (!Number.isFinite(available) || available <= 0) return 0;
  if (Number.isFinite(credits.seenAt) && now - credits.seenAt > RESET_CREDIT_MAX_AGE_MS) return 0;
  // A grant past its stated expiry is gone whatever the last reading said.
  if (Number.isFinite(credits.expiresAt) && credits.expiresAt <= now) return 0;
  return available;
}

/**
 * How many of the reported resets are Fable resets (see bankedResets in
 * oauth.js): 0 wherever heldResetCredits reports none, and never more than it
 * does. A Codex reading carries no `fable` count, so all of its credits stay
 * general ones.
 *
 * @param {Record<string, any>|null|undefined} quota
 * @param {number} [now]
 */
export function heldFableResets(quota, now = Date.now()) {
  const fable = quota?.resetCredits?.fable;
  if (!Number.isFinite(fable) || fable <= 0) return 0;
  return Math.min(fable, heldResetCredits(quota, now));
}
