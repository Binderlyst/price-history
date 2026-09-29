// node lib/eurclean.test.mjs
import assert from 'node:assert/strict';
import { cleanSeries } from './eurclean.mjs';

const fix = (s) => cleanSeries(s).series;

// Lord Windgrace: one week at €0.26 between weeks at €8.60.
assert.deepEqual(fix([860, 860, 26, 860, 860]), [860, 860, 860, 860, 860]);
// A one-week spike in the middle.
assert.deepEqual(fix([2527, 2548, 13791, 2571, 2602]), [2527, 2548, 2548, 2571, 2602]);
// First and last weeks, judged against the two weeks beside them.
assert.deepEqual(fix([12335, 264, 250, 250]), [264, 264, 250, 250]);
assert.deepEqual(fix([30, 32, 31, 31, 2749]), [30, 32, 31, 31, 31]);
// A real climb is left alone: the neighbours disagree.
assert.deepEqual(fix([1000, 1500, 3200, 6000, 9000]), [1000, 1500, 3200, 6000, 9000]);
// A long run at a new level is left alone: the median follows it.
assert.deepEqual(fix([1000, 90, 90, 90, 1000, 1000, 1000]), [1000, 90, 90, 90, 1000, 1000, 1000]);
// Cheap cards are not judged, and a week with no price is not a neighbour.
assert.deepEqual(fix([10, 10, 60, 10, 10]), [10, 10, 60, 10, 10]);
assert.deepEqual(fix([860, 0, 26, 860, 860]), [860, 0, 26, 860, 860]);
console.log('eurclean: all checks pass');
