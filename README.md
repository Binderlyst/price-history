# Magic: the Gathering price history

Weekly snapshots of card prices, keyed by Scryfall id, published as release
assets.

They exist because price history is otherwise unavailable: Scryfall publishes
none, and [MTGJSON](https://mtgjson.com)'s window only reaches 90 days. Anything
not captured inside that window cannot be obtained again afterwards, from
anywhere. This repository captures it weekly so it accumulates.

Built for [Binderlyst](https://binderlyst.github.io), and public because the app
has to be able to download it. Anyone else is welcome to it under the same terms
it comes to us under.

## The files

Everything lives on the [releases](../../releases):

| Release | Asset | What it is |
|---|---|---|
| `bundle` | `prices-12w.jsonl.gz` | The last 12 weeks, one row per card. This is what the app downloads. |
| `archive` | `YYYY-MM-DD.jsonl.gz` | One file per captured week, every week ever captured. |
| `archive` | `manifest.json` | Which weeks exist, and how many cards each holds. |

The bundle has a stable address, so it can be fetched without asking an API
what the latest release is:

```
https://github.com/Binderlyst/price-history/releases/latest/download/prices-12w.jsonl.gz
```

## Format

Gzipped [JSON Lines](https://jsonlines.org). The bundle's first line is a
header, and every line after it is one card:

```json
{"version":1,"source":"mtgjson","dates":["2026-06-12", "…"],"fields":["usd","usdFoil","usdEtched","eur","eurFoil"],"cards":83761}
{"id":"e3094187-d666-414b-a1fd-ae0ef55c3fcb","usd":[650,659,665,667,667,674,674,658,658,664,664,668],"eur":[400,495,486,502,580,504,526,547,577,556,549,544]}
```

- `id` is the **Scryfall** id for that printing.
- Prices are **whole cents**, as integers, in the same order as `dates`.
- A field is absent when the card carries no price of that kind. Dollars come
  from TCGplayer, euros from Cardmarket.
- Archive files are the same shape without the arrays: one price per field.

A card appears in the bundle only if it is priced in **every** week it covers.
That is deliberate. Coverage grows as sets release, and a card that appeared
half way through a chart would arrive as a jump that no price movement caused.
Nothing is interpolated across a missing week either — the card is simply left
out, because a guessed week shows a crash that never happened.

## Caveats worth reading before you use it

- **These are estimates, not valuations.** They are market figures published by
  shops, they lag real sales, and they assume a near-mint English copy.
- **They will not exactly match another source's numbers.** Everyone sampling
  TCGplayer and Cardmarket does so at a different hour, and each shop publishes
  more than one figure. Expect a few percent, and pennies of rounding on cheap
  cards. If you need your figures to agree with another source, scale each
  card's series by the ratio between the two on a day they overlap.
- **Bad prices exist in the source.** Roughly one card in six hundred over £1
  carries a week bad enough to move it more than fivefold. Treat any single-week
  move of that size as a data fault rather than a price move.

## Running it

```
node capture.mjs          # fill in any weekly points the archive is missing
node bundle.mjs --weeks=12  # cut the file the app downloads
node check.mjs            # non-zero exit if the newest point is stale
node report.mjs           # build a local page showing what the data looks like
```

`capture.mjs` reads MTGJSON's rolling 90-day file rather than its daily one, so
a failed run costs nothing: the next run sees the hole and fills it. The job
would have to be broken for twelve straight weeks before any week was actually
lost. A 113-byte check runs first, so a run that is not due downloads nothing.

The weekly run is a GitHub Action in this repository. No credentials are
involved.

## Credit and licence

Card prices come from **MTGJSON**, which aggregates them from TCGplayer,
Cardmarket and other partners, and publishes under the MIT licence. Their
copyright notice travels with this data and is reproduced in [NOTICE](NOTICE).
This is not affiliated with or endorsed by MTGJSON, Scryfall, or Wizards of the
Coast.

The code here is MIT (see [LICENSE](LICENSE)). Magic: the Gathering is
copyright Wizards of the Coast; no card text, art or imagery is redistributed
here, only prices and identifiers.
