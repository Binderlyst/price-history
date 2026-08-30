// Reading prices out of MTGJSON, shared by the weekly capture and the one-off
// backfill.
//
// MTGJSON is the only source in the archive, and that is a licence decision as
// much as a technical one. Scryfall's terms forbid republishing their data, and
// the archive has to be publicly downloadable for the app to reach it. MTGJSON
// publishes the same two shops' figures (TCGplayer for dollars, Cardmarket for
// euros) under an MIT licence that grants redistribution outright.
//
// The cost is that MTGJSON's numbers sit a few percent off the Scryfall prices
// the app displays. That is corrected in the app, not here: each card's series
// is scaled so it lands exactly on the price the app already shows for it. Done
// that way the correction is always current, and the archive stays a clean copy
// of something we are allowed to pass on.
import { entries } from './stream.mjs';
import { cents } from './points.mjs';

/// MTGJSON uuid -> Scryfall id, read from AllPrintings. Every printing carries
/// the Scryfall id outright, so this is a lookup rather than a match on set and
/// collector number. Tokens are included: the app tracks them in decks.
export async function idMap(printingsPath, { log = () => {} } = {}) {
  const out = new Map();
  let sets = 0;
  for await (const [, set] of entries(printingsPath)) {
    sets++;
    for (const list of [set.cards, set.tokens]) {
      for (const c of list ?? []) {
        const id = c.identifiers?.scryfallId;
        if (id) out.set(c.uuid, id);
      }
    }
  }
  log(`  ${sets} sets, ${out.size.toLocaleString()} printings mapped`);
  return out;
}

/// The five dated price series we keep, pulled out of one card's price entry.
/// Each is `{ 'YYYY-MM-DD': number }` or undefined.
///
/// Only the retail side is taken. MTGJSON also carries buylist (what a shop
/// pays you) and Card Kingdom, Manapool and MTGO figures; those are left for a
/// later feature rather than bloating every point now.
///
/// There is no euro etched slot, matching Scryfall's own card object: an etched
/// printing carries a dollar price only, and the app estimates the euro from it.
export function seriesOf(entry) {
  const paper = entry?.paper ?? {};
  const tcg = paper.tcgplayer?.retail ?? {};
  const cm = paper.cardmarket?.retail ?? {};
  return {
    usd: tcg.normal,
    usdFoil: tcg.foil,
    usdEtched: tcg.etched,
    eur: cm.normal,
    eurFoil: cm.foil,
  };
}

/// Newest value at or before [date], in whole cents, looking back at most
/// [lookbackDays].
///
/// The lookback matters: sources drop cards for a day, and those gaps land on
/// expensive cards. Reading a gap as "no price" would drop the card out of a
/// total and read as a crash; reaching back a few days keeps the basket whole.
/// Beyond the window it returns 0, because a price a fortnight stale is not
/// this week's price.
export function valueAt(series, date, lookbackDays = 6) {
  if (!series) return 0;
  for (let i = 0; i <= lookbackDays; i++) {
    const v = series[shiftDate(date, -i)];
    if (v !== undefined) return cents(v);
  }
  return 0;
}

/// A date string moved by [days], staying in UTC so a run near midnight in a
/// summer timezone cannot file a point under the wrong day.
export function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/// The newest date the feed carries, sampled from the first [sample] cards
/// rather than assumed. The feed's latest day moves, and a hardcoded date would
/// silently file a point under the wrong label.
export async function newestDate(pricesPath, { sample = 3000 } = {}) {
  const seen = new Set();
  let n = 0;
  for await (const [, v] of entries(pricesPath)) {
    const t = seriesOf(v).usd;
    if (t) for (const d of Object.keys(t)) seen.add(d);
    if (++n >= sample) break;
  }
  const all = [...seen].sort();
  return { newest: all[all.length - 1], all };
}

export const MTGJSON_BASE = 'https://mtgjson.com/api/v5';
