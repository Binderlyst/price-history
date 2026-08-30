// Staleness guard. The one failure mode that actually costs us data is this job
// dying quietly for a month, so the scheduled runner ends with this: it exits
// non-zero and leaves data/STALE.txt when the newest point is too old, which
// Task Scheduler surfaces as a failed Last Run Result.
//
//   node check.mjs [--maxdays=8]
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, readManifest } from './lib/points.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const MAX_DAYS = Number.parseInt(args.maxdays, 10) || 8;
const FLAG = join(DATA_DIR, 'STALE.txt');

const m = readManifest();
const dates = Object.keys(m.points ?? {}).sort();
const newest = dates[dates.length - 1];

if (!newest) {
  const msg = 'price archive is empty — capture has never produced a point';
  writeFileSync(FLAG, msg + '\n');
  console.error(msg);
  process.exit(1);
}

const ageDays = Math.floor((Date.now() - Date.parse(`${newest}T00:00:00Z`)) / 86400000);
if (ageDays > MAX_DAYS) {
  const msg =
    `price archive is ${ageDays} days stale (newest point ${newest}). ` +
    'Every day not captured is gone for good — fix the weekly job now.';
  writeFileSync(FLAG, msg + '\n');
  console.error(msg);
  process.exit(1);
}

if (existsSync(FLAG)) rmSync(FLAG);
console.log(`archive healthy: ${dates.length} points, newest ${newest} (${ageDays}d old)`);
