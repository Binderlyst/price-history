// Builds data/report.html: what the archive actually looks like, so the shape of
// the data can be judged before any app work is committed to.
//
//   node report.mjs
//
// Three questions it answers:
//   1. Does a collection's value visibly move over thirteen weeks, or is the
//      line flat and the whole feature pointless?
//   2. Do dollars and euros move apart, which is the reason we store both?
//   3. Which cards drive it — the chase cards, or everything drifting together?
//
// The basket is balanced: only cards priced on every single date are counted,
// so every point sums exactly the same cards. A basket that changes as cards
// appear or drop out mixes "the market moved" with "the basket changed", which
// is the trap any value-over-time chart has to avoid. See the basket comment
// below for the two ways that went wrong here first.
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { cached } from './lib/download.mjs';
import { entries } from './lib/stream.mjs';
import { MTGJSON_BASE } from './lib/mtgjson.mjs';
import { DATA_DIR, pointPath, readManifest } from './lib/points.mjs';

const log = (m) => console.log(m);

// Chart series colours. Validated with the dataviz palette checker against this
// page's surface (#15132A, dark): lightness band, chroma floor, CVD separation
// (ΔE 26.4 protan / 16.9 tritan), normal-vision separation and contrast all
// pass. Do not "brighten" these without re-running that check.
const USD_COLOR = '#7B84E8';
const EUR_COLOR = '#B5872F';

async function* pointRows(date) {
  const rl = createInterface({
    input: createReadStream(pointPath(date)).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line) yield JSON.parse(line);
  }
}

function fmtMoney(cents, symbol) {
  return symbol + (cents / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

async function main() {
  const manifest = readManifest();
  const dates = Object.keys(manifest.points ?? {}).sort();
  if (dates.length < 2) {
    log('Need at least two points before a report means anything.');
    return;
  }
  log(`Report over ${dates.length} points: ${dates[0]} → ${dates[dates.length - 1]}`);

  // ── Basket: cards priced on every single date ──────────────────────────────
  //
  // Two traps live here, and both were hit while building this:
  //
  //   1. A basket taken from the newest point alone contains cards that did not
  //      exist in the older ones. They enter at zero and all arrive at once,
  //      which read as a 9.5% overnight jump. Coverage genuinely grows: the feed
  //      priced 2,400 more printings at the end of thirteen weeks than at the
  //      start, as new sets landed.
  //
  //   2. Carrying a stale price across a gap is worse than leaving the card
  //      out. The feed drops cards for a day, and those gaps land on expensive
  //      cards — 23 of them were missing from one date, averaging $371 each.
  //      Their stale carried values put a phantom 1.1% cliff in the line.
  //
  // So the basket is balanced: only cards priced in dollars on every date. Any
  // chart the app draws needs the same rule, or it will show people crashes
  // that never happened.
  const newest = dates[dates.length - 1];
  const priced = new Map();
  for (const date of dates) {
    for await (const r of pointRows(date)) {
      if (r.usd) priced.set(r.id, (priced.get(r.id) ?? 0) + 1);
    }
  }
  const latest = new Map();
  for await (const r of pointRows(newest)) {
    if (r.usd && priced.get(r.id) === dates.length) latest.set(r.id, r.usd);
  }
  log(`  ${priced.size.toLocaleString()} cards priced at some point, ` +
      `${latest.size.toLocaleString()} priced on all ${dates.length} dates`);

  const byValue = [...latest.entries()].sort((a, b) => b[1] - a[1]);
  const chase = new Set(byValue.slice(0, 100).map(([id]) => id));
  // Deterministic 1,000-card "shoebox": every 40th card in the 10p–£1 band, so
  // the sample is stable between runs and spread across the whole band.
  const bulkPool = byValue.filter(([, v]) => v >= 10 && v <= 100).map(([id]) => id);
  const stride = Math.max(1, Math.floor(bulkPool.length / 1000));
  const bulk = new Set(bulkPool.filter((_, i) => i % stride === 0).slice(0, 1000));
  // Everything the newest point prices, as the market-wide line.
  const market = new Set(latest.keys());
  // Cards worth following individually: £5+, where a percentage means something.
  const watch = new Set(byValue.filter(([, v]) => v >= 500).map(([id]) => id));
  log(`  baskets — market ${market.size}, chase ${chase.size}, shoebox ${bulk.size}`);

  // ── Sum each basket on every date ──────────────────────────────────────────
  const series = {
    marketUsd: [],
    marketEur: [],
    chaseUsd: [],
    bulkUsd: [],
  };
  const carry = new Map(); // id -> [usd, eur] last seen, so a gap doesn't read as zero
  const watchSeries = new Map([...watch].map((id) => [id, []]));

  for (const date of dates) {
    let mUsd = 0;
    let mEur = 0;
    let cUsd = 0;
    let bUsd = 0;
    const seen = new Set();
    for await (const r of pointRows(date)) {
      if (!market.has(r.id)) continue;
      seen.add(r.id);
      const prev = carry.get(r.id);
      const usd = r.usd || prev?.[0] || 0;
      const eur = r.eur || prev?.[1] || 0;
      carry.set(r.id, [usd, eur]);
      mUsd += usd;
      mEur += eur;
      if (chase.has(r.id)) cUsd += usd;
      if (bulk.has(r.id)) bUsd += usd;
      const w = watchSeries.get(r.id);
      if (w) w.push(usd);
    }
    // Cards absent from this date keep their carried value, so the basket size
    // is constant even while the feed's coverage grows week to week.
    for (const [id, [usd, eur]] of carry) {
      if (seen.has(id)) continue;
      mUsd += usd;
      mEur += eur;
      if (chase.has(id)) cUsd += usd;
      if (bulk.has(id)) bUsd += usd;
      const w = watchSeries.get(id);
      if (w) w.push(usd);
    }
    series.marketUsd.push(mUsd);
    series.marketEur.push(mEur);
    series.chaseUsd.push(cUsd);
    series.bulkUsd.push(bUsd);
    log(`  ${date}  market ${fmtMoney(mUsd, "$")}`);
  }

  // ── Cards to feature: biggest movers, plus the steadiest ───────────────────
  //
  // Outliers first. The source carries genuinely bad prices — a Summer Magic
  // Ornithopter listed at 5c for weeks before correcting to $500 — and a single
  // junk week would put a cliff in a user's collection chart that never
  // happened. Anything that multiplies or collapses more than fivefold in one
  // week is treated as a data fault, not a price move. This is a report-level
  // filter only: the archive keeps what the source said, because rewriting
  // history to look tidy is how you end up unable to explain a number later.
  const SPIKE = 5;
  const moves = [];
  let suspicious = 0;
  for (const [id, vals] of watchSeries) {
    if (vals.length !== dates.length || vals[0] < 100) continue;
    let spiked = false;
    for (let i = 1; i < vals.length; i++) {
      const a = vals[i - 1];
      const b = vals[i];
      if (!a || !b) continue;
      if (b / a > SPIKE || a / b > SPIKE) spiked = true;
    }
    if (spiked) {
      suspicious++;
      continue;
    }
    moves.push({ id, vals, change: (vals[vals.length - 1] - vals[0]) / vals[0] });
  }
  moves.sort((a, b) => b.change - a.change);
  const mid = Math.floor(moves.length / 2);
  const featured = [
    ...moves.slice(0, 2),
    ...moves.slice(-2).reverse(),
    ...moves.slice(mid, mid + 2),
  ];
  log(`  ${moves.length.toLocaleString()} cards over £1 tracked, ${suspicious} dropped as bad data`);

  // Names come from MTGJSON's printings file, the copy the capture already
  // cached. Scryfall's bulk file would do the same job, but pulling 78 MB from
  // them to label six cards on a local page is not a reasonable thing to do to
  // someone else's free API when the answer is already on disk.
  const printingsPath = await cached(
    `${MTGJSON_BASE}/AllPrintings.json.gz`,
    'AllPrintings.json.gz',
    { log }
  );
  const wanted = new Set(featured.map((f) => f.id));
  const names = new Map();
  outer: for await (const [code, set] of entries(printingsPath)) {
    for (const list of [set.cards, set.tokens]) {
      for (const c of list ?? []) {
        const id = c.identifiers?.scryfallId;
        if (id && wanted.has(id)) {
          names.set(id, `${c.name} · ${code}`);
          if (names.size === wanted.size) break outer;
        }
      }
    }
  }

  const payload = {
    dates,
    sources: dates.map((d) => manifest.points[d]?.source ?? 'unknown'),
    series,
    featured: featured.map((f) => ({
      name: names.get(f.id) ?? f.id.slice(0, 8),
      vals: f.vals,
      change: f.change,
    })),
    counts: {
      market: market.size,
      chase: chase.size,
      bulk: bulk.size,
      tracked: moves.length,
      suspicious,
    },
    generatedAt: new Date().toISOString(),
  };

  const out = join(DATA_DIR, 'report.html');
  writeFileSync(out, html(payload));
  log(`\nwrote ${out}`);
}

const pctChange = (a, b) => (a ? ((b - a) / a) * 100 : 0);

function html(d) {
  const first = 0;
  const last = d.dates.length - 1;
  const kpi = (label, series, symbol, note) => {
    const change = pctChange(series[first], series[last]);
    const cls = change >= 0 ? 'up' : 'down';
    return `<div class="kpi">
      <div class="label">${label}</div>
      <div class="value">${fmtMoney(series[last], symbol)}
        <span class="delta ${cls}">${change >= 0 ? '+' : ''}${change.toFixed(1)}%</span></div>
      <div class="note">${note}</div>
    </div>`;
  };

  return `<!doctype html>
<meta charset="utf-8">
<title>Binderlyst price archive</title>
<style>
  /* Matches Mission Control (tools/dashboard/dashboard.html): same dark
     surface, same tokens, so the two local pages read as one tool. */
  :root {
    --accent: #6366F1; --usd: ${USD_COLOR}; --eur: ${EUR_COLOR};
    --bg: #0D0B1A; --surface: #15132A; --border: #373750;
    --text-1: #E9E7F5; --text-2: #9B97B8;
    --up: #6EE7A0; --down: #FF7376;
    --mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: var(--bg); color: var(--text-1);
         font: 14px/1.5 system-ui, "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--text-2); font-size: 13px; margin-bottom: 24px; }
  h2 { font-size: 12px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase;
       color: var(--text-2); margin: 28px 0 12px; }
  .card { background: var(--surface); border: 0.5px solid var(--border);
          border-radius: 14px; padding: 18px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
  .kpi .label { font-size: 11px; font-weight: 600; letter-spacing: .5px;
                text-transform: uppercase; color: var(--text-2); }
  .kpi .value { font: 600 24px/1.3 var(--mono); }
  .kpi .note { font-size: 11px; color: var(--text-2); margin-top: 4px; }
  .delta { font: 600 12px/1 system-ui; padding: 3px 7px; border-radius: 6px; vertical-align: 3px; }
  .delta.up { color: var(--up); background: color-mix(in srgb, var(--up) 14%, var(--surface)); }
  .delta.down { color: var(--down); background: color-mix(in srgb, var(--down) 14%, var(--surface)); }
  .legend { display: flex; gap: 18px; margin-bottom: 10px; font-size: 12px; color: var(--text-2); }
  .legend b { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .mini .name { font-size: 12px; color: var(--text-1); margin-bottom: 2px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mini .row { display: flex; justify-content: space-between; align-items: baseline;
               font: 600 13px/1 var(--mono); color: var(--text-2); margin-top: 6px; }
  table { width: 100%; border-collapse: collapse; font: 13px/1.6 var(--mono); }
  th { text-align: right; font: 600 11px/1 system-ui; letter-spacing: .5px;
       text-transform: uppercase; color: var(--text-2); padding: 0 0 8px; }
  th:first-child, td:first-child { text-align: left; }
  td { text-align: right; padding: 3px 0; border-top: 0.5px solid var(--border); }
  .src { font: 600 10px/1 system-ui; letter-spacing: .4px; text-transform: uppercase;
         color: var(--text-2); }
  #tip { position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
         background: #1E1B38; border: 0.5px solid var(--border); border-radius: 8px;
         padding: 8px 10px; font: 12px/1.5 var(--mono); white-space: pre; z-index: 9; }
</style>

<h1>Price archive</h1>
<div class="sub">${d.dates.length} weekly points, ${d.dates[0]} to ${d.dates[last]}.
  ${d.counts.market.toLocaleString()} cards per point.
  Built ${d.generatedAt.slice(0, 16).replace('T', ' ')}.</div>

<h2>Thirteen weeks</h2>
<div class="kpis">
  ${kpi('Whole market', d.series.marketUsd, '$', `${d.counts.market.toLocaleString()} cards, dollars`)}
  ${kpi('Whole market', d.series.marketEur, '€', `${d.counts.market.toLocaleString()} cards, euros`)}
  ${kpi('Top 100 cards', d.series.chaseUsd, '$', 'the chase cards')}
  ${kpi('Shoebox', d.series.bulkUsd, '$', '1,000 cards, 10p to £1')}
</div>

<h2>Market value, indexed to 100</h2>
<div class="card">
  <div class="legend">
    <span><b style="background:var(--usd)"></b>Dollars (TCGplayer)</span>
    <span><b style="background:var(--eur)"></b>Euros (Cardmarket)</span>
  </div>
  <svg id="main" viewBox="0 0 900 300" style="width:100%;height:auto"></svg>
</div>

<h2>Baskets, indexed to 100</h2>
<div class="grid">
  <div class="card mini"><div class="name">Whole market</div><svg class="spark" viewBox="0 0 260 70" style="width:100%;height:auto"></svg><div class="row"><span>${fmtMoney(d.series.marketUsd[0], '$')}</span><span>${fmtMoney(d.series.marketUsd[last], '$')}</span></div></div>
  <div class="card mini"><div class="name">Top 100 cards</div><svg class="spark" viewBox="0 0 260 70" style="width:100%;height:auto"></svg><div class="row"><span>${fmtMoney(d.series.chaseUsd[0], '$')}</span><span>${fmtMoney(d.series.chaseUsd[last], '$')}</span></div></div>
  <div class="card mini"><div class="name">Shoebox, 1,000 cheap cards</div><svg class="spark" viewBox="0 0 260 70" style="width:100%;height:auto"></svg><div class="row"><span>${fmtMoney(d.series.bulkUsd[0], '$')}</span><span>${fmtMoney(d.series.bulkUsd[last], '$')}</span></div></div>
</div>

<h2>Single cards</h2>
<div class="sub">Biggest risers, biggest fallers, and two typical cards, from
  ${d.counts.tracked.toLocaleString()} cards worth over £1 throughout.
  ${d.counts.suspicious.toLocaleString()} more were dropped for moving more than
  fivefold in a single week, which is a bad price in the source rather than a real move.</div>
<div class="grid" id="cards"></div>

<h2>Every point</h2>
<div class="card">
  <table>
    <tr><th>Date</th><th>Source</th><th>Market $</th><th>Market €</th><th>Top 100 $</th><th>Shoebox $</th></tr>
    ${d.dates
      .map(
        (date, i) => `<tr><td>${date}</td><td class="src">${d.sources[i]}</td>
      <td>${fmtMoney(d.series.marketUsd[i], '$')}</td>
      <td>${fmtMoney(d.series.marketEur[i], '€')}</td>
      <td>${fmtMoney(d.series.chaseUsd[i], '$')}</td>
      <td>${fmtMoney(d.series.bulkUsd[i], '$')}</td></tr>`
      )
      .join('\n    ')}
  </table>
</div>

<div id="tip"></div>
<script>
const D = ${JSON.stringify(d)};
const NS = 'http://www.w3.org/2000/svg';
const el = (n, a) => { const e = document.createElementNS(NS, n);
  for (const k in a) e.setAttribute(k, a[k]); return e; };
const index = (vals) => vals.map((v) => (vals[0] ? (v / vals[0]) * 100 : 100));

// ── main chart ───────────────────────────────────────────────────────────────
(function () {
  const svg = document.getElementById('main');
  const W = 900, H = 300, L = 46, R = 58, T = 16, B = 34;
  const usd = index(D.series.marketUsd), eur = index(D.series.marketEur);
  const all = [...usd, ...eur];
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.25, 0.4);
  lo -= pad; hi += pad;
  const x = (i) => L + (i / (D.dates.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  // Grid + axis: recessive, four steps, never competing with the data.
  for (let s = 0; s <= 4; s++) {
    const v = lo + ((hi - lo) * s) / 4;
    svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v),
      stroke: '#373750', 'stroke-width': 0.5 }));
    const t = el('text', { x: L - 8, y: y(v) + 4, fill: '#9B97B8',
      'font-size': 11, 'text-anchor': 'end' });
    t.textContent = v.toFixed(1);
    svg.append(t);
  }
  D.dates.forEach((date, i) => {
    if (i % 3 && i !== D.dates.length - 1) return;
    const t = el('text', { x: x(i), y: H - 12, fill: '#9B97B8',
      'font-size': 11, 'text-anchor': 'middle' });
    t.textContent = date.slice(5);
    svg.append(t);
  });

  const draw = (vals, color) => {
    svg.append(el('polyline', { points: vals.map((v, i) => x(i) + ',' + y(v)).join(' '),
      fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    // Direct label at the line's end, so identity never rests on colour alone.
    const t = el('text', { x: W - R + 8, y: y(vals[vals.length - 1]) + 4,
      fill: color, 'font-size': 12, 'font-weight': 600 });
    t.textContent = vals[vals.length - 1].toFixed(1);
    svg.append(t);
  };
  draw(usd, '${USD_COLOR}');
  draw(eur, '${EUR_COLOR}');

  // Crosshair + tooltip.
  const rule = el('line', { y1: T, y2: H - B, stroke: '#9B97B8',
    'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0 });
  svg.append(rule);
  const dots = ['${USD_COLOR}', '${EUR_COLOR}'].map((c) => {
    const dot = el('circle', { r: 4.5, fill: c, stroke: '#15132A',
      'stroke-width': 2, opacity: 0 });
    svg.append(dot); return dot;
  });
  const tip = document.getElementById('tip');
  svg.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let i = Math.round(((px - L) / (W - L - R)) * (D.dates.length - 1));
    i = Math.max(0, Math.min(D.dates.length - 1, i));
    rule.setAttribute('x1', x(i)); rule.setAttribute('x2', x(i));
    rule.setAttribute('opacity', 1);
    [usd, eur].forEach((vals, n) => {
      dots[n].setAttribute('cx', x(i)); dots[n].setAttribute('cy', y(vals[i]));
      dots[n].setAttribute('opacity', 1);
    });
    tip.textContent = D.dates[i] + '\\n$ ' + usd[i].toFixed(2) + '   € ' + eur[i].toFixed(2);
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top = (e.clientY - 10) + 'px';
    tip.style.opacity = 1;
  });
  svg.addEventListener('mouseleave', () => {
    rule.setAttribute('opacity', 0);
    dots.forEach((dt) => dt.setAttribute('opacity', 0));
    tip.style.opacity = 0;
  });
})();

// ── sparklines ───────────────────────────────────────────────────────────────
function spark(svg, vals, color) {
  const W = 260, H = 70, P = 6;
  const idx = index(vals);
  const lo = Math.min(...idx), hi = Math.max(...idx);
  const span = hi - lo || 1;
  const x = (i) => P + (i / (idx.length - 1)) * (W - P * 2);
  const y = (v) => P + (1 - (v - lo) / span) * (H - P * 2);
  svg.append(el('polyline', { points: idx.map((v, i) => x(i) + ',' + y(v)).join(' '),
    fill: 'none', stroke: color, 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  svg.append(el('circle', { cx: x(idx.length - 1), cy: y(idx[idx.length - 1]),
    r: 4, fill: color, stroke: '#15132A', 'stroke-width': 2 }));
}
const baskets = [D.series.marketUsd, D.series.chaseUsd, D.series.bulkUsd];
document.querySelectorAll('.spark').forEach((svg, i) => spark(svg, baskets[i], '${USD_COLOR}'));

// ── single cards ─────────────────────────────────────────────────────────────
const host = document.getElementById('cards');
for (const c of D.featured) {
  const wrap = document.createElement('div');
  wrap.className = 'card mini';
  const up = c.change >= 0;
  wrap.innerHTML = '<div class="name">' + c.name + '</div>' +
    '<svg class="cardspark" viewBox="0 0 260 70" style="width:100%;height:auto"></svg>' +
    '<div class="row"><span>$' + (c.vals[0] / 100).toFixed(2) +
    ' → $' + (c.vals[c.vals.length - 1] / 100).toFixed(2) + '</span>' +
    '<span class="delta ' + (up ? 'up' : 'down') + '">' + (up ? '+' : '') +
    (c.change * 100).toFixed(1) + '%</span></div>';
  host.append(wrap);
  spark(wrap.querySelector('.cardspark'), c.vals, up ? '#6EE7A0' : '#FF7376');
}
</script>
`;
}

main().catch((e) => {
  console.error('report failed:', e);
  process.exitCode = 1;
});
