// The capture: fills in every weekly point the archive is missing, from
// MTGJSON's rolling 90-day price file.
//
//   node capture.mjs [--weeks=13] [--force] [--repair] [--dry]
//
// Run weekly. The first run on an empty archive backfills thirteen weeks; every
// run after that adds the one new point. It is the same job either way, which
// is why there is no separate backfill script.
//
// Reading the 90-day file rather than the 5 MB daily one is deliberate, and it
// buys two things:
//
//   • Recovery. A run that fails takes nothing with it — the next run sees the
//     hole and fills it from the same window. The job can be broken for up to
//     twelve weeks before anything is actually lost. With the daily file, one
//     missed Monday was gone for good.
//   • Whole cards. Sources drop a card for a day, and those gaps land on
//     expensive cards. The 90-day file lets a point reach back a few days for a
//     price; the daily file has nothing to reach back to. Measured on one date:
//     116 cards priced from the window that the daily file left blank.
//
// The cost is one 143 MB download a week from a small free project. A 113-byte
// Meta.json check runs first, so a run that is not due — a manual re-trigger, a
// double-fired schedule — costs them nothing at all.
//
// Why MTGJSON and not Scryfall, when the app displays Scryfall's prices: the
// archive has to be publicly downloadable for the app to reach it, and
// Scryfall's terms forbid republishing their data. MTGJSON carries the same two
// shops under an MIT licence that grants redistribution. The few percent
// between them is corrected in the app, per card — see lib/mtgjson.mjs.
import { cached, UA } from './lib/download.mjs';
import { entries } from './lib/stream.mjs';
import { idMap, MTGJSON_BASE, newestDate, seriesOf, shiftDate, valueAt } from './lib/mtgjson.mjs';
import {
  ensureDirs,
  FIELDS,
  hasPoint,
  openPoint,
  readManifest,
  recordPoint,
  row,
} from './lib/points.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
// How far back to reach on a first run. Thirteen weeks is all MTGJSON's window
// holds; there is no way to get more, from anywhere, at any price.
const WEEKS = Number.parseInt(args.weeks, 10) || 13;
const FORCE = !!args.force;
const REPAIR = !!args.repair;
const DRY = !!args.dry;

const log = (m) => console.log(m);
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

/// The weekly grid this run should end up owning, oldest first.
///
/// Anchored on the newest date the feed carries and stepped backwards, so the
/// spacing stays exactly seven days whether the job ran on time, ran late, or
/// did not run for a month. Anchoring on "today" instead would drift the grid
/// every time a run slipped.
function grid(newest, weeks) {
  const out = [];
  for (let i = 0; i < weeks; i++) out.unshift(shiftDate(newest, -i * 7));
  return out;
}

/// Days between two YYYY-MM-DD dates.
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

async function main() {
  ensureDirs();
  log('Binderlyst price capture');

  // Cheap check first. MTGJSON's Meta.json is 113 bytes and carries the build
  // date, which is the same day the price file's newest prices land on. If the
  // archive is already complete and current there is nothing to do, and asking
  // a small free project for 143 MB to find that out would be rude.
  const manifest = readManifest();
  const points = Object.keys(manifest.points ?? {}).sort();
  if (!FORCE && !REPAIR && points.length >= WEEKS) {
    const meta = await fetch(`${MTGJSON_BASE}/Meta.json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    }).then((r) => (r.ok ? r.json() : null));
    const feedDate = meta?.data?.date;
    const last = points[points.length - 1];
    if (feedDate && daysBetween(last, feedDate) < 7) {
      log(`  feed is at ${feedDate}, newest point is ${last} — not due yet`);
      return;
    }
  }

  const pricesPath = await cached(`${MTGJSON_BASE}/AllPrices.json.gz`, 'AllPrices.json.gz', {
    log,
  });
  const printingsPath = await cached(
    `${MTGJSON_BASE}/AllPrintings.json.gz`,
    'AllPrintings.json.gz',
    { log }
  );

  const { newest, all } = await newestDate(pricesPath);
  if (!newest) throw new Error('no dates found in the price file');
  log(`  feed covers ${all[0]} → ${newest} (${all.length} days)`);

  // The manifest, not the local files, decides what the archive already holds.
  // On GitHub the runner starts with an empty disk every week, so a
  // file-existence test would rebuild all thirteen points every run; the
  // manifest travels with the archive and is the actual record of it. Points
  // are written atomically, so the manifest can never be claiming a torn file.
  //
  // --repair also refills any point whose local file is missing, for the case
  // where the local copy has been pruned but the manifest still lists it.
  const known = new Set(Object.keys(readManifest().points ?? {}));
  const wanted = grid(newest, WEEKS).filter((d) => d >= all[0]);
  const targets = FORCE
    ? wanted
    : wanted.filter((d) => !known.has(d) || (REPAIR && !hasPoint(d)));

  if (!targets.length) {
    log(`  archive already holds every point back to ${wanted[0]}; nothing to do`);
    return;
  }
  if (known.size && targets.length > 1) {
    log(`  ! ${targets.length} points missing — recovering a gap, not just adding this week`);
  }
  log(`  writing ${targets.length} point(s): ${targets.join(', ')}`);
  if (DRY) {
    log('--dry: stopping before any write');
    return;
  }

  const ids = await idMap(printingsPath, { log });

  const writers = new Map(targets.map((d) => [d, openPoint(d)]));
  let cards = 0;
  let mapped = 0;
  for await (const [uuid, entry] of entries(pricesPath)) {
    cards++;
    const id = ids.get(uuid);
    if (!id) continue;
    mapped++;
    const series = seriesOf(entry);
    for (const date of targets) {
      const priced = {};
      let any = false;
      for (const f of FIELDS) {
        const v = valueAt(series[f], date);
        if (v) {
          priced[f] = v;
          any = true;
        }
      }
      if (any) await writers.get(date).write(row(id, priced));
    }
    if (cards % 25000 === 0) log(`  … ${cards.toLocaleString()} cards`);
  }

  let total = 0;
  for (const date of targets) {
    const w = writers.get(date);
    const rows = w.rows;
    const size = await w.close();
    total += size;
    recordPoint(date, { source: 'mtgjson', rows, bytes: size });
    log(`  ${date}  ${rows.toLocaleString().padStart(8)} rows  ${mb(size).padStart(9)}`);
  }
  log(`  ${cards.toLocaleString()} cards read, ${mapped.toLocaleString()} with a Scryfall id`);
  log(`  wrote ${mb(total)}`);
}

main().catch((e) => {
  console.error('capture failed:', e);
  process.exitCode = 1;
});
