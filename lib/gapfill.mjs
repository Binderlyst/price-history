// A single week with no price, between two priced weeks, carries the week
// before it.
//
// MTGJSON's Cardmarket feed had no foil prices for the week of 6 Sep 2026.
// A series may not have a hole in it (see bundle.mjs), so that one missing
// week cut every week before it: 8,840 euro foil lines lost two months, and
// the app then hid them beside versions with a full line. A price held for
// one week is closer to the truth than no line at all.
//
// Only a lone gap is filled. Two or more missing weeks in a row are a card
// that really left the market, and the series still starts after them.

/// [series] with each lone unpriced week filled, and how many were.
export function fillGaps(series) {
  if (!series || series.length < 3) return { series, filled: 0 };
  const out = [...series];
  let filled = 0;
  for (let i = 1; i < series.length - 1; i++) {
    if (!series[i] && series[i - 1] && series[i + 1]) {
      out[i] = series[i - 1];
      filled++;
    }
  }
  return { series: out, filled };
}
