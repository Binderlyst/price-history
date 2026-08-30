// The price archive: one file per captured date, plus a manifest.
//
// Layout (all under data/, gitignored):
//   data/cache/<file>            downloaded source files, reused for 20 hours
//   data/points/<YYYY-MM-DD>.jsonl.gz   one line per card, prices in whole cents
//   data/manifest.json           what exists, where it came from, when
//
// A point file is append-only history. Nothing here ever rewrites an existing
// point: a re-run of the same date replaces that one file atomically and leaves
// every other date alone, so the archive can only grow.
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const DATA_DIR = join(ROOT, 'data');
export const CACHE_DIR = join(DATA_DIR, 'cache');
export const POINTS_DIR = join(DATA_DIR, 'points');
export const MANIFEST = join(DATA_DIR, 'manifest.json');

/// The price fields carried in every row, in write order. Cents as integers, so
/// nothing drifts the way repeated float maths would. `usdEtched` mirrors
/// Scryfall's own `usd_etched` slot, which is the only place an etched printing
/// carries a price.
export const FIELDS = ['usd', 'usdFoil', 'usdEtched', 'eur', 'eurFoil'];

export function ensureDirs() {
  for (const d of [DATA_DIR, CACHE_DIR, POINTS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

/// Cents from a Scryfall price string or an MTGJSON number. Returns 0 for
/// missing, empty, unparseable or non-positive values, which is how "unpriced"
/// travels through the whole pipeline.
export function cents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/// One archive row. Zero fields are dropped rather than written, which is worth
/// roughly a third of the file: most printings are priced in one currency only.
export function row(id, prices) {
  const out = { id };
  for (const f of FIELDS) {
    const v = prices[f] || 0;
    if (v > 0) out[f] = v;
  }
  return out;
}

export function pointPath(date) {
  return join(POINTS_DIR, `${date}.jsonl.gz`);
}

export function hasPoint(date) {
  return existsSync(pointPath(date));
}

/// Writes one date's rows, atomically: a crash mid-write leaves the previous
/// file intact instead of a truncated one that would read as real data.
export async function writePoint(date, rows) {
  ensureDirs();
  const final = pointPath(date);
  const tmp = `${final}.tmp`;
  const lines = Readable.from(
    (function* () {
      for (const r of rows) yield JSON.stringify(r) + '\n';
    })()
  );
  await pipeline(lines, createGzip({ level: 9 }), createWriteStream(tmp));
  if (existsSync(final)) rmSync(final);
  renameSync(tmp, final);
  return statSync(final).size;
}

/// Streaming version of [writePoint], for the backfill: it fills thirteen dates
/// in a single pass over the source, so rows have to go straight to disk rather
/// than pile up in thirteen arrays (1.4M objects, and the run dies).
export function openPoint(date) {
  ensureDirs();
  const final = pointPath(date);
  const tmp = `${final}.tmp`;
  const gzip = createGzip({ level: 9 });
  const out = createWriteStream(tmp);
  const done = pipeline(gzip, out);
  let rows = 0;
  return {
    date,
    get rows() {
      return rows;
    },
    /// Resolves only when the stream wants more, so a slow gzip can't be
    /// outrun by the reader and buffer the whole file in memory.
    async write(r) {
      rows++;
      if (!gzip.write(JSON.stringify(r) + '\n')) {
        await new Promise((resolve) => gzip.once('drain', resolve));
      }
    },
    async close() {
      gzip.end();
      await done;
      if (existsSync(final)) rmSync(final);
      renameSync(tmp, final);
      return statSync(final).size;
    },
  };
}

export function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch {
    return { points: {} };
  }
}

/// Records what a run produced. `source` is the provenance of that date's
/// numbers ('mtgjson-backfill' or 'scryfall'), which matters because the
/// borrowed months are a few percent off Scryfall's own figures and we need to
/// be able to tell later which is which.
export function recordPoint(date, info) {
  ensureDirs();
  const m = readManifest();
  m.points[date] = { ...info, writtenAt: new Date().toISOString() };
  m.updatedAt = new Date().toISOString();
  const dates = Object.keys(m.points).sort();
  m.first = dates[0] ?? null;
  m.last = dates[dates.length - 1] ?? null;
  m.count = dates.length;
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}
