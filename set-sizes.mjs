// Exact set sizes for the app's Set Completion, cut from MTGJSON's AllPrintings.
//
// The app shows "owned / size" for every set in a collection. The size it
// wants is what Scryfall's search counts for `set:xxx -r:special -r:bonus`
// with unique cards: one entry per distinct card, bonus sheets and special
// rarities left out. The set list Scryfall serves in one request understates
// that (its card_count includes them), so the app used to run one search per
// owned set to get the exact figure, on every phone, every week. For a big
// collection that was a hundred and more searches in a row, which is what
// earned the rate-limit bans of 2026-09-21.
//
// This computes the same figure for every set from a file we already download,
// so the app makes no searches at all for it. Output:
//
//   data/bundle/set-sizes.json   {"built":"YYYY-MM-DD","sizes":{"mh3":303,…}}
//
// A set the file does not know (released since the last run) still costs the
// app its one search, as before.
//
// Checked 2026-09-21 against Scryfall on fifteen sets: exact on every regular
// set; Secret Lair and The List come out about 2% under, from reversible
// printings whose ids differ between the two sources. Nobody completes those.
//
//   node set-sizes.mjs            # write the file
//   node set-sizes.mjs --check    # compare a sample against Scryfall's search
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cached, UA } from './lib/download.mjs';
import { MTGJSON_BASE } from './lib/mtgjson.mjs';
import { entries } from './lib/stream.mjs';
import { DATA_DIR } from './lib/points.mjs';

const OUT_DIR = join(DATA_DIR, 'bundle');
const OUT = join(OUT_DIR, 'set-sizes.json');

// Scryfall's four counted rarities. Anything else (special, bonus) is a bonus
// sheet or a promo-style extra that the completion bars do not count.
const COUNTED = new Set(['common', 'uncommon', 'rare', 'mythic']);

/// Distinct cards per set among the counted rarities, keyed by lower-case set
/// code. Distinct the way Scryfall's `unique=cards` is: by oracle id, so a
/// reversible printing (which MTGJSON names "X // X") folds into its card and
/// the two faces of a double-faced card count once. MTGJSON's online-only
/// flag is not consulted: it marks cards Scryfall still counts (checked
/// 2026-09-21 on MH3), and the app is only ever asked about paper sets.
export async function setSizes(printingsPath, { log = () => {} } = {}) {
  const sizes = {};
  let sets = 0;
  for await (const [code, set] of entries(printingsPath)) {
    sets++;
    const cards = new Set();
    for (const c of set.cards ?? []) {
      if (!COUNTED.has(c.rarity)) continue;
      cards.add(c.identifiers?.scryfallOracleId ?? c.name);
    }
    if (cards.size > 0) sizes[code.toLowerCase()] = cards.size;
  }
  log(`  ${sets} sets read, ${Object.keys(sizes).length} sized`);
  return sizes;
}

async function scryfallSize(code) {
  const q = encodeURIComponent(`set:${code} -r:special -r:bonus`);
  const res = await fetch(`https://api.scryfall.com/cards/search?q=${q}&unique=cards`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`Scryfall search ${code}: HTTP ${res.status}`);
  return (await res.json()).total_cards;
}

const args = new Set(process.argv.slice(2));
const printingsPath = await cached(
  `${MTGJSON_BASE}/AllPrintings.json.gz`,
  'AllPrintings.json.gz',
);
const sizes = await setSizes(printingsPath, { log: console.log });

if (args.has('--check')) {
  // A spread of set kinds: a recent standard set, one with a bonus sheet, a
  // Commander deck set, a masters set, a Secret Lair, an old core set and a
  // promo set. Paced at one a second, well under Scryfall's limit.
  const sample = ['mh3', 'blb', 'fdn', 'dsk', 'otj', 'cmm', 'sld', 'm21', 'plst', 'eoe', 'tdm', 'fic', 'woe', 'ltr', 'one'];
  let off = 0;
  for (const code of sample) {
    const theirs = await scryfallSize(code);
    const ours = sizes[code] ?? 0;
    const mark = theirs === ours ? 'ok ' : 'OFF';
    if (theirs !== ours) off++;
    console.log(`  ${mark} ${code.padEnd(5)} scryfall=${theirs} file=${ours}`);
    await new Promise((r) => setTimeout(r, 1100));
  }
  console.log(off === 0 ? 'all match' : `${off} of ${sample.length} differ`);
  process.exit(off === 0 ? 0 : 1);
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const built = new Date().toISOString().slice(0, 10);
writeFileSync(OUT, JSON.stringify({ built, sizes }));
console.log(`  wrote ${OUT}: ${Object.keys(sizes).length} sets, built ${built}`);
