// Cuts the archive down to what a phone actually needs: one row per card
// carrying that card's weekly prices, instead of one file per week.
//
//   node bundle.mjs [--weeks=12] [--currency=usd|eur|both] [--min=0] [--list]
//
// --list only prints the dates a build would use, one per line, and writes
// nothing. The workflow runs it first to know which points to fetch, so the
// selection below is the single place that decides.
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
const LIST = !!args.list;

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
  if (LIST) {
    for (const d of dates) console.log(d);
    return;
  }
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

  // Two things travel per card, and the difference matters:
  //
  //   * a weekly series: the longest unbroken run of priced weeks ending at the
  //     most recent one. Usually that is the whole window. For a printing that
  //     came out part way along it is the weeks since it did, and sending those
  //     is the difference between a recent card showing a movement and showing
  //     nothing at all. What never travels is a line with holes in it, because
  //     there is no honest way to draw one.
  //
  //     A short series is always the TAIL of the window, so the weeks it is
  //     missing are always the earliest ones and the reader can work out which
  //     dates it covers from its length alone. Nothing else would be safe: the
  //     app pairs prices with dates from the end backwards.
  //
  //     Two points is the floor. One price is a price, not a movement.
  //
  //   * its latest price, whenever there is no series to read it from. A card
  //     too new to have even two points still has a price today, and an app
  //     that knows it can hold the card flat across the window instead of
  //     counting it as worth nothing. Leaving this out made recent printings,
  //     which are often the expensive ones, vanish from any total the app could
  //     not price itself.
  //
  // Older builds of the app skip any series that is not exactly one value per
  // week, so a short one reads to them as no series at all: they carry on using
  // the latest price, exactly as they do today. That is why this needs no
  // version bump, and it must stay true of anything added here.

  // How many weeks at the end of [series] are priced without a gap.
  const tailLength = (series) => {
    let n = 0;
    for (let i = series.length - 1; i >= 0 && series[i]; i--) n++;
    return n;
  };

  const out = [];
  let full = 0;
  let partial = 0;
  let priceOnly = 0;
  for (const [id, entry] of cards) {
    const row = { id };
    const now = {};
    let any = false;
    let shortest = Infinity;
    for (const f of fields) {
      const series = entry[f];
      const last = series[series.length - 1];
      if (last) any = true;
      const keep = tailLength(series);
      const tail = keep === series.length ? series : series.slice(-keep);
      // Enough of a run to show a movement, and above the floor if one was
      // asked for.
      if (keep >= 2 && (!MIN || Math.max(...tail) >= MIN)) {
        row[f] = tail;
        if (keep < shortest) shortest = keep;
        // A PARTIAL series still carries the latest price, because older builds
        // skip any series that is not one value per week and would otherwise be
        // left with nothing at all for this card. Without this line, giving a
        // recent printing a partial series would take its price away from every
        // installed copy and send it back to counting the card as worthless,
        // which is the very thing the price-only field was added to stop.
        if (keep < series.length) now[f] = last;
      } else if (last) {
        // For a card with a FULL series the latest price is its last value, and
        // repeating it for all of them cost 1.6 MB.
        now[f] = last;
      }
    }
    if (!any) continue;
    if (shortest === Infinity) {
      priceOnly++;
    } else if (shortest === dates.length) {
      full++;
    } else {
      partial++;
    }
    if (Object.keys(now).length) row.now = now;
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
      version: 2,
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
  log(
    `  ${out.length.toLocaleString()} cards: ${full.toLocaleString()} with a full series, ` +
      `${partial.toLocaleString()} with a partial one, ${priceOnly.toLocaleString()} with today's price only`
  );
  log(`  ${name}  ${mb(statSync(path).size)}`);
}

main().catch((e) => {
  console.error('bundle failed:', e);
  process.exitCode = 1;
});
