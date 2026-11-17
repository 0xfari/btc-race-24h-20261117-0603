// Snapback — a bot that trades Coinbase Wrapped BTC (cbBTC) on 1-minute
// on-chain prices with $1,000 of paper money, for make.fun's "Race a BTC
// trading bot live for 24 hours" (btc-race-24h-20261117-0603).
//
// Idea, in one sentence: sharp half-hour drops in BTC snap back, so buy the
// drop once the minute turns up, ride the bounce for up to two hours, and
// let a trailing stop keep the profit.
//
// Why this shape, from the dev window (2026-11-16 06:03 -> 2026-11-17 06:03
// UTC, 1,440 one-minute bars, net +0.49%, high $65,610, low $63,874):
//   - The window is calm: 60-minute returns have a 0.52% stdev and the
//     deepest 60-minute drop is only -2.06%. The previous race's winner
//     (an hourly-drop buyer at 1.8%) catches one trade here and LOSES
//     -$2.22 — the hourly-drop edge is too slow for this window.
//   - The edge that survives here is at 30 minutes: after a 30-minute drop
//     of 0.8% or more, the next 30 minutes average +0.22% (median +0.34%,
//     positive 83% of the time). After a 60-minute drop the bounce is
//     smaller (+0.19% mean) and after a 120-minute drop smaller still.
//   - So the entry is a sharp 30-minute drop, the exit is time (2h) plus a
//     trailing stop that only arms once the trade is up 0.5%. No fixed
//     take-profit and no fixed stop-loss: both were tested against the dev
//     window and both cut the one bounce that pays.
//   - Local backtest (exact-integer replica of the harness fill math: 4 bps
//     fee, 2 bps slippage, constant-product impact vs the bar's open depth,
//     fills at the next bar's open): +$9.87 on this dev window (1 trade,
//     max drawdown 0.57%). The same parameters make +$27.09 on the previous
//     race's dev window (3 trades), so the design earns in a calm window
//     and in a volatile falling one — it is a region, not a point tuned to
//     one day. A trend-following second signal was tested too and loses on
//     both windows, so it was left out rather than diluting a working edge.
//   - Revision (17 Nov, this session): a trailing-stop sweep (0.5% / 0.6% /
//     0.8% / 0.9%, drop held at 1.5%) on both dev windows found nothing
//     strictly better than the 0.7% stop on both windows — 0.5% turns the
//     new window negative, 0.6% ties it, 0.8% and 0.9% lose on the old one
//     — so the 0.7% stop stays. This revision is a cleanup only: the entry
//     test is a named helper and the position-tracking sentinel is a named
//     constant. Behaviour is unchanged.
//
// All decisions are exact integer math on raw price units; no clock, no
// randomness, no network, no files outside the repository — the bot is
// fully deterministic: two runs on the same bars emit the same orders.

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** Bars of history a drop is measured over (half an hour of 1-min bars). */
const LOOKBACK_BARS = 30;
/** How far the close must have fallen over the lookback to count as a drop. */
const DROP_BPS = 150n;
/** Bars to stay in a trade at most (two hours). */
const HOLD_BARS = 120;
/** Trailing stop: sell when the position's value falls this far below its peak. */
const TRAIL_BPS = 70n;
/** Arm for the trailing stop: it only starts watching once the peak value
 *  is this far above what the position cost. */
const TRAIL_ARM_BPS = 50n;
/** Slippage allowance on every order, wide open: the fill math (fee +
 *  slippage + own impact) is small next to the moves this bot trades, and
 *  a rejected order is a missed bounce. The harness still caps fills by
 *  the pool's own depth, so a wild open cannot fill far away. */
const MAX_SLIPPAGE_BPS = 10_000;

/** Sentinel meaning "no open trade is being tracked yet". */
const NO_ENTRY_SEQ = -1;

/** Closes seen so far, oldest first, one per batch. */
const closes: bigint[] = [];
let lastBatchT = -1;

/** State of the open trade, set when a filled position is first observed. */
let entrySeq = NO_ENTRY_SEQ;
let peakValue = 0n;

/**
 * True when the closes show a sharp drop over the lookback that has just
 * turned up: the close fell at least DROP_BPS below the close
 * LOOKBACK_BARS ago, and the latest minute closed at or above the previous
 * minute, so the bounce has begun. `closes` already includes `now` as its
 * last element when this runs.
 */
function hasSnapbackSetup(closes: readonly bigint[], now: bigint): boolean {
  if (closes.length <= LOOKBACK_BARS) return false;
  const then = closes[closes.length - 1 - LOOKBACK_BARS]!;
  const prev = closes[closes.length - 2]!;
  // A sharp 30-minute drop...
  const dropped = now * BPS <= then * (BPS - DROP_BPS);
  // ...and the latest minute turned up off the low (the bounce has begun).
  const turningUp = now >= prev;
  return dropped && turningUp;
}

await runBars({
  onBatch(state) {
    // While warming up every order would be rejected and never retried.
    if (state.warmingUp) return [];

    const now = state.close(SYMBOL);
    if (now === null) return [];
    if (state.t !== lastBatchT) {
      closes.push(now);
      lastBatchT = state.t;
    }

    const held = state.positions.get(SYMBOL);
    const heldQty = held?.qty ?? 0n;

    // -- Holding: decide whether to sell. ---------------------------------
    if (heldQty > 0n && held !== undefined) {
      const cost = held.cost;
      const value = state.value(SYMBOL, heldQty, now);
      if (entrySeq === NO_ENTRY_SEQ) {
        // First sight of this position: the fill just landed.
        entrySeq = state.seq;
        peakValue = value;
      }
      if (value > peakValue) peakValue = value;
      const armed = peakValue * BPS >= cost * (BPS + TRAIL_ARM_BPS);
      const trailed = armed && value * BPS <= peakValue * (BPS - TRAIL_BPS);
      const expired = state.seq - entrySeq >= HOLD_BARS;
      if (trailed || expired) {
        entrySeq = NO_ENTRY_SEQ;
        peakValue = 0n;
        const sell: SellInput = {
          side: 'sell',
          symbol: SYMBOL,
          qty: heldQty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [sell];
      }
      return [];
    }

    // -- Flat: decide whether to buy. --------------------------------------
    // Flat, so no trade is being tracked; clear the stale peak in case a
    // position ever vanishes without our sell (defensive — the sell branch
    // already clears both on exit).
    entrySeq = NO_ENTRY_SEQ;
    peakValue = 0n;
    if (!hasSnapbackSetup(closes, now)) return [];

    const room = state.weightRoom(SYMBOL);
    const notional = state.cash < room ? state.cash : room;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const buy: BuyInput = {
      side: 'buy',
      symbol: SYMBOL,
      notional_quote_units: notional,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
    return [buy];
  },
});
