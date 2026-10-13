// node lib/gapfill.test.mjs
import assert from 'node:assert/strict';
import { fillGaps } from './gapfill.mjs';

const fill = (s) => fillGaps(s).series;

// SLD #875 foil: the 6 Sep week is missing between 30 Aug and 13 Sep.
assert.deepEqual(fill([8324, 9198, 0, 10279, 10360]), [8324, 9198, 9198, 10279, 10360]);
// Two missing weeks in a row stay missing.
assert.deepEqual(fill([500, 0, 0, 600, 610]), [500, 0, 0, 600, 610]);
// The ends are never filled: a new card starts, an old one stops.
assert.deepEqual(fill([0, 500, 510, 0]), [0, 500, 510, 0]);
// Two lone gaps are both filled.
assert.deepEqual(fill([100, 0, 120, 0, 140]), [100, 100, 120, 120, 140]);
assert.equal(fillGaps([100, 0, 120, 0, 140]).filled, 2);
console.log('gapfill: all checks pass');
