// Cuts the archive down to what a phone actually needs: one row per card
// carrying that card's weekly prices, instead of one file per week.
//
//   node bundle.mjs [--weeks=12] [--currency=usd|eur|both] [--min=0]
//
// The archive is stored a week at a time because that is how it is captured and
// it makes each write append-only. A phone wants the opposite shape — give me
// this card's line — so the bundle transposes it. One download, parsed once,
// and the app keeps only the cards its owner actually holds.
//
// It stays a plain file on purpose. A lookup service would mean the phone
// telling us which cards someone owns, and the app has never done that.
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip, createGzip } from 'node:zlib';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DATA_DIR, pointPath, readManifest } from './lib/points.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const WEEKS = Number.parseInt(args.weeks, 10) || 12;
const CURRENCY = args.currency === true || !args.currency ? 'both' : String(args.currency);
const MIN = Number.parseInt(args.min, 10) || 0;

const log = (m) => console.log(m);
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

async function* pointRows(date) {
  const rl = createInterface({
    input: createReadStream(pointPath(date)).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) if (line) yield JSON.parse(line);
}

/// The newest [WEEKS] dates that sit a week apart. The archive can hold points
/// closer together than that (a manual capture, or the day the backfill handed
/// over to Scryfall), and a chart wants an even spacing, not every point we own.
function weeklyDates(all, weeks) {
  const out = [];
  let cursor = null;
  for (const date of [...all].reverse()) {
    if (!cursor) {
      out.push(date);
      cursor = Date.parse(date + 'T00:00:00Z');
      continue;
    }
    const gap = (cursor - Date.parse(date + 'T00:00:00Z')) / 86400000;
    if (gap >= 6) {
      out.push(date);
      cursor = Date.parse(date + 'T00:00:00Z');
    }
    if (out.length === weeks) break;
  }
  return out.reverse();
}

async function main() {
  const manifest = readManifest();
  const dates = weeklyDates(Object.keys(manifest.points ?? {}).sort(), WEEKS);
  if (dates.length < 2) {
    log('Not enough points to bundle.');
    return;
  }
  log(`Bundling ${dates.length} weekly points: ${dates[0]} → ${dates[dates.length - 1]}`);

  const fields =
    CURRENCY === 'usd'
      ? ['usd', 'usdFoil']
      : CURRENCY === 'eur'
        ? ['eur', 'eurFoil']
        : ['usd', 'usdFoil', 'usdEtched', 'eur', 'eurFoil'];

  // id -> field -> array of weekly values, 0 where that week has no price.
  const cards = new Map();
  dates.forEach((date, w) => cards.set(date, w));
  for (let w = 0; w < dates.length; w++) {
    for await (const r of pointRows(dates[w])) {
      let entry = cards.get(r.id);
      if (typeof entry === 'number' || entry === undefined) {
        entry = {};
        for (const f of fields) entry[f] = new Array(dates.length).fill(0);
        cards.set(r.id, entry);
      }
      for (const f of fields) if (r[f]) entry[f][w] = r[f];
    }
    log(`  read ${dates[w]}`);
  }
  for (const date of dates) cards.delete(date);

  // A card is only worth shipping if it has a price on every week: a line with
  // holes cannot be drawn honestly, and a card that appears halfway through
  // would make a deck's total jump for no reason.
  const out = [];
  let dropped = 0;
  for (const [id, entry] of cards) {
    const main = entry[fields[0]];
    if (main.some((v) => !v)) {
      dropped++;
      continue;
    }
    if (MIN && Math.max(...main) < MIN) {
      dropped++;
      continue;
    }
    const row = { id };
    for (const f of fields) {
      if (entry[f].some((v) => v)) row[f] = entry[f];
    }
    out.push(row);
  }

  const dir = join(DATA_DIR, 'bundle');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // The default build carries both currencies and every card, and is the file
  // the app fetches, so it gets a stable name with nothing qualifying it. The
  // app's URL is built from this; renaming it breaks every installed copy.
  const plain = CURRENCY === 'both' && !MIN;
  const name = plain
    ? `prices-${dates.length}w.jsonl.gz`
    : `prices-${dates.length}w-${CURRENCY}${MIN ? `-min${MIN}` : ''}.jsonl.gz`;
  const path = join(dir, name);
  // Version first, so a future format change is something the app can refuse
  // cleanly rather than misread. Every row after this line is one card.
  const header =
    JSON.stringify({
      version: 1,
      source: 'mtgjson',
      licence: 'MIT, https://mtgjson.com/license/',
      dates,
      fields,
      cards: out.length,
      builtAt: new Date().toISOString(),
    }) + '\n';
  await pipeline(
    Readable.from(
      (function* () {
        yield header;
        for (const r of out) yield JSON.stringify(r) + '\n';
      })()
    ),
    createGzip({ level: 9 }),
    createWriteStream(path)
  );
  log(`  ${out.length.toLocaleString()} cards kept, ${dropped.toLocaleString()} dropped (gaps or below floor)`);
  log(`  ${name}  ${mb(statSync(path).size)}`);
}

main().catch((e) => {
  console.error('bundle failed:', e);
  process.exitCode = 1;
});
