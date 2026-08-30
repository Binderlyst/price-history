// Cached downloads of the source files. These are 78-180 MB each, so a re-run
// within the same day reuses what is already on disk rather than pulling them
// again. Scryfall and MTGJSON both rebuild once a day, so nothing fresher
// exists to fetch anyway.
import { createWriteStream, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CACHE_DIR, ensureDirs } from './points.mjs';

// Both sources ask for an honest User-Agent naming the app.
export const UA = 'Binderlyst/1.0 (price history; https://binderlyst.com)';

const MAX_AGE_MS = 20 * 60 * 60 * 1000; // 20h: under both feeds' daily rebuild

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/// Downloads [url] into data/cache/[name] unless a copy younger than 20 hours is
/// already there. Returns the local path.
export async function cached(url, name, { log = console.log } = {}) {
  ensureDirs();
  const path = join(CACHE_DIR, name);
  if (existsSync(path)) {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age < MAX_AGE_MS) {
      log(`  cached  ${name} (${mb(statSync(path).size)}, ${Math.round(age / 3600000)}h old)`);
      return path;
    }
  }
  log(`  fetching ${name} …`);
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${url}`);
  const tmp = `${path}.tmp`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  if (existsSync(path)) rmSync(path);
  renameSync(tmp, path);
  log(`  got      ${name} (${mb(statSync(path).size)})`);
  return path;
}

/// Resolves the current Scryfall "default cards" bulk file. The URL carries a
/// build timestamp that changes daily, so it has to be looked up rather than
/// hardcoded.
export async function scryfallBulkUrl(type = 'default_cards') {
  const res = await fetch('https://api.scryfall.com/bulk-data', {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Scryfall bulk-data: HTTP ${res.status}`);
  const body = await res.json();
  const entry = body.data.find((d) => d.type === type);
  if (!entry) throw new Error(`Scryfall bulk-data: no "${type}" file`);
  // Scryfall serves JSONL now; the older single-array .json is the fallback.
  const url = entry.jsonl_download_uri || entry.download_uri;
  return { url, updatedAt: entry.updated_at, jsonl: !!entry.jsonl_download_uri };
}
