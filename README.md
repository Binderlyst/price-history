# price-history

Working data for the [Binderlyst](https://binderlyst.github.io) app: weekly
Magic card price snapshots, captured from [MTGJSON](https://mtgjson.com).

It is public only because the app downloads the file and a credential shipped
inside an app is not a credential.

> **Not a service, and not for anyone else to use.** The files, their format and
> their address change whenever the app needs them to, and may be removed
> entirely without notice. Nothing here is maintained for outside use and no
> support is offered.
>
> If you want Magic price history, take it from MTGJSON directly. It is the same
> data, it is free, and it does not depend on one Android app's plans.

## Maintenance

```
node capture.mjs    # fill in any weekly points the archive is missing
node bundle.mjs     # cut the file the app downloads
node check.mjs      # non-zero exit if the newest point is stale
node report.mjs     # local page showing what the data looks like
```

`capture.mjs` runs weekly as a GitHub Action here. It reads MTGJSON's 90-day
file rather than the daily one, so a failed run costs nothing: the next run
sees the hole and fills it. Twelve consecutive failures would be needed before a
week was actually lost, and a lost week cannot be recovered from anywhere.

A 113-byte check runs first, so a run that is not due asks MTGJSON for nothing.

## Credit and licence

Prices come from **MTGJSON**, which aggregates them from TCGplayer, Cardmarket
and other partners and publishes under the MIT licence. Their copyright notice
travels with the data and is reproduced in [NOTICE](NOTICE). This project is not
affiliated with or endorsed by MTGJSON, Scryfall, or Wizards of the Coast.

The code here is MIT ([LICENSE](LICENSE)). Magic: the Gathering is copyright
Wizards of the Coast; no card text, art or imagery is redistributed here.
