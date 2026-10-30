/**
 * The wallet: how a user pays for fills, like a transport card.
 *
 * A new wallet holds FREE_APPLICATIONS free applications and no money. A
 * free application is counted by application, not by page: every page of a
 * multi-step application that started free is free. After those, each fill
 * is charged what it used: PRICE_MULTIPLIER times its model cost, never more
 * than PRICE_CAP_CENTS. The user reloads at least MIN_RELOAD_CENTS at a time.
 *
 * A fill may start while the wallet holds anything at all, so the last fill
 * can take it a little below zero (at most one capped fill); the next reload
 * covers that.
 *
 * Pure functions on plain objects, shared by the extension (the dev build's
 * own wallet, src/background/billing.js) and the hosted backend
 * (backend/server.mjs), so both charge exactly the same way. No browser or
 * Node APIs here.
 */

import { MAX_FILL_CENTS, PRICE_MULTIPLIER } from '../background/cost.js';

export const FREE_APPLICATIONS = 10;
export const MIN_RELOAD_CENTS = 500;
export const PRICE_CAP_CENTS = MAX_FILL_CENTS * PRICE_MULTIPLIER;

const roundCents = c => Math.round(c * 10000) / 10000;

/** A new wallet: the free applications and `balanceCents` (none unless given). */
export function newWallet({ balanceCents = 0 } = {}) {
  return { balanceCents, freeLeft: FREE_APPLICATIONS, freeApps: [], spentCents: 0, reloadedCents: balanceCents };
}

/** What a fill costs the user, from what its model calls cost. */
export function priceOf(costCents) {
  return roundCents(Math.min(PRICE_CAP_CENTS, Math.max(0, Number(costCents) || 0) * PRICE_MULTIPLIER));
}

/**
 * Whether a fill on the application `appKey` may start, and whether it is
 * free (an application already started free, or a free one left).
 */
export function canStart(wallet, appKey) {
  const w = wallet || newWallet();
  // An unlimited wallet (given by hand, tools/accounts.py) never runs out.
  if (w.unlimited) return { allowed: true, free: true };
  const free = (w.freeApps || []).includes(appKey) || (w.freeLeft || 0) > 0;
  return { allowed: free || (w.balanceCents || 0) > 0, free };
}

/**
 * Settle a finished fill. A fill that filled nothing costs nothing and uses no
 * free application. Returns the new wallet and what was charged:
 * `{ wallet, charge: { free, cents, costCents, freeLeft } }`.
 */
export function settleFill(wallet, { appKey, costCents = 0, filled = 0 }) {
  const w = { ...newWallet(), ...wallet, freeApps: [...(wallet?.freeApps || [])] };
  const charge = { free: false, cents: 0, costCents: roundCents(Number(costCents) || 0) };
  if (filled > 0 && w.unlimited) {
    // Free, uses no free application; what it cost us is kept, to see what the gift costs.
    charge.free = true;
    charge.unlimited = true;
    w.giftedCents = roundCents((w.giftedCents || 0) + charge.costCents);
  } else if (filled > 0) {
    if (w.freeApps.includes(appKey)) {
      charge.free = true;
    } else if (w.freeLeft > 0) {
      w.freeApps.push(appKey);
      w.freeLeft -= 1;
      charge.free = true;
    } else {
      charge.cents = priceOf(costCents);
      w.balanceCents = roundCents(w.balanceCents - charge.cents);
      w.spentCents = roundCents(w.spentCents + charge.cents);
    }
  }
  // Only the most recent free applications need remembering: an old one
  // whose later pages come back long after is charged, which is fair.
  w.freeApps = w.freeApps.slice(-50);
  charge.freeLeft = w.freeLeft;
  return { wallet: w, charge };
}

/** Add money. Below the minimum is refused. */
export function reload(wallet, cents) {
  const amount = Math.round(Number(cents) || 0);
  if (amount < MIN_RELOAD_CENTS) throw new Error(`The smallest reload is $${(MIN_RELOAD_CENTS / 100).toFixed(2)}.`);
  const w = { ...newWallet(), ...wallet };
  return { ...w, balanceCents: roundCents(w.balanceCents + amount), reloadedCents: roundCents((w.reloadedCents || 0) + amount) };
}

/** What a popup needs to show: the balance, free applications left, and whether a fill can start. */
export function walletView(wallet) {
  const w = { ...newWallet(), ...wallet };
  return {
    balanceCents: w.balanceCents,
    freeLeft: w.freeLeft,
    spentCents: w.spentCents,
    unlimited: !!w.unlimited,
    canFill: !!w.unlimited || w.freeLeft > 0 || w.balanceCents > 0,
    minReloadCents: MIN_RELOAD_CENTS
  };
}
