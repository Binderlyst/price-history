// Streaming readers for the multi-hundred-MB source files. Nothing here ever
// holds a whole file in memory: AllPrices.json is ~1.5 GB uncompressed, well
// past what JSON.parse can take, and the machine running this is a PC, not a
// server.
//
// Char codes are used instead of quoted literals in the scanner so the source
// carries no escape sequences of its own.
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

const QUOTE = 34;
const BACKSLASH = 92;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;

const CHUNK = 1 << 20; // 1 MB: fewer, larger reads than the 64 KB default

/// Yields `[key, value]` for every entry of the top-level `data` object in a
/// gzipped JSON file shaped `{"meta":{…},"data":{"<key>":<value>,…}}`, which is
/// how every MTGJSON bulk file is laid out. Each value is parsed on its own, so
/// peak memory is one entry — one set, or one card's price history.
///
/// The scanner keeps its position and nesting state across chunk boundaries.
/// That matters: an AllPrintings entry is a whole set, several MB, spread over
/// dozens of chunks, and rescanning it from the start each time turns the pass
/// into hours of quadratic character scanning.
///
/// Values are expected to be objects or arrays, which is true of every MTGJSON
/// bulk file; a bare scalar value would never close and would stall the read.
export async function* entries(path, dataKey = 'data') {
  const gz = createReadStream(path, { highWaterMark: CHUNK }).pipe(
    createGunzip({ chunkSize: CHUNK })
  );
  const marker = '"' + dataKey + '":{';

  let buf = '';
  let started = false;
  let mode = 'key';
  let pos = 0; // where the next key search starts
  let key = '';
  let valueFrom = 0; // first char after the key's colon
  let scan = 0; // how far the value scanner has already looked
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1; // opening brace/bracket of the current value

  for await (const chunk of gz) {
    buf += chunk.toString('utf8');

    if (!started) {
      const i = buf.indexOf(marker);
      if (i === -1) {
        // Keep a marker-length tail so a marker split across chunks still matches.
        if (buf.length > marker.length) buf = buf.slice(-marker.length);
        continue;
      }
      buf = buf.slice(i + marker.length);
      started = true;
      pos = 0;
      scan = 0;
    }

    for (;;) {
      if (mode === 'key') {
        const ks = buf.indexOf('"', pos);
        if (ks === -1) break;
        const ke = buf.indexOf('"', ks + 1);
        if (ke === -1) break;
        const colon = buf.indexOf(':', ke + 1);
        if (colon === -1) break;
        key = buf.slice(ks + 1, ke);
        mode = 'value';
        valueFrom = colon + 1;
        scan = valueFrom;
        depth = 0;
        inStr = false;
        esc = false;
        start = -1;
      }

      let i = scan;
      let done = false;
      for (; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (esc) {
          esc = false;
          continue;
        }
        if (c === BACKSLASH) {
          esc = true;
          continue;
        }
        if (c === QUOTE) {
          inStr = !inStr;
          continue;
        }
        if (inStr) continue;
        if (c === OPEN_BRACE || c === OPEN_BRACKET) {
          if (depth === 0) start = i;
          depth++;
        } else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
          depth--;
          if (depth === 0) {
            i++;
            done = true;
            break;
          }
        }
      }

      if (!done) {
        // Ran out of data mid-value: remember how far we looked and wait.
        scan = buf.length;
        break;
      }
      yield [key, JSON.parse(buf.slice(start, i))];
      mode = 'key';
      pos = i;
      scan = i;
    }

    // Drop everything already consumed. Mid-value, the value's own start is the
    // furthest back we may cut.
    const cut = mode === 'value' ? (start >= 0 ? start : valueFrom) : pos;
    if (cut > 0) {
      buf = buf.slice(cut);
      pos -= cut;
      scan -= cut;
      valueFrom -= cut;
      if (start >= 0) start -= cut;
    }
  }
}

/// Yields each parsed object from a gzipped JSONL file (Scryfall's bulk format:
/// one card object per line).
export async function* jsonLines(path) {
  const rl = createInterface({
    input: createReadStream(path, { highWaterMark: CHUNK }).pipe(
      createGunzip({ chunkSize: CHUNK })
    ),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim().replace(/,$/, '');
    if (!t || t === '[' || t === ']') continue;
    try {
      yield JSON.parse(t);
    } catch {
      // A truncated last line means a half-downloaded file; skip it rather than
      // kill a run that has already processed 100k good rows.
    }
  }
}
