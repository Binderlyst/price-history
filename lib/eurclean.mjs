// A one-week glitch in MTGJSON's euro prices, put right before it reaches a
// phone.
//
// MTGJSON's Cardmarket feed sometimes carries a single week that is plainly
// wrong: Lord Windgrace at €0.26 for one week between weeks at €8.60, which
// the app then showed as a move of more than 999%. A series may not have a
// hole in it (see bundle.mjs), so the bad week takes the value of the week
// beside it rather than being dropped.
//
// Only a clear case is touched. A week counts as a glitch when it sits at
// least [RATIO] times away from every neighbour it has, those neighbours agree
// with each other, and it is also [RATIO] times away from the card's median
// week. The median test is what keeps a real move safe: a card that has
// genuinely climbed from €10 to €100 has neighbours that disagree, and its
// newest week is not far from where the series has been heading.
//
// USD comes from TCGplayer and has not shown these; only the euro fields are
// cleaned.

export const RATIO = 3;
// Below this (in cents) a threefold move is a few cents and not worth judging.
export const FLOOR = 200;
// Neighbours that differ by more than this are not a settled price.
const AGREE = 1.5;

const far = (a, b) => a >= RATIO * b || a * RATIO <= b;

function median(values) {
  const s = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/// [series] with its one-week glitches replaced, and how many were.
/// Zeros (no price that week) are left alone and never used as neighbours.
export function cleanSeries(series) {
  if (!series || series.length < 3) return { series, fixed: 0 };
  const med = median(series);
  const out = [...series];
  let fixed = 0;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (!v) continue;
    // The two weeks on the side that has them: both sides in the middle, the
    // next two at the start, the previous two at the end.
    const near =
      i === 0
        ? [series[1], series[2]]
        : i === series.length - 1
          ? [series[i - 1], series[i - 2]]
          : [series[i - 1], series[i + 1]];
    if (near.some((n) => !n)) continue;
    if (Math.max(v, ...near) < FLOOR) continue;
    if (!near.every((n) => far(v, n))) continue;
    if (Math.max(...near) > AGREE * Math.min(...near)) continue;
    if (!med || !far(v, med)) continue;
    out[i] = i === 0 ? series[1] : series[i - 1];
    fixed++;
  }
  return { series: out, fixed };
}
