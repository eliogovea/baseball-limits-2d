# Data License

The baseball statistics shipped in this repository — both the source CSVs
under `data/` and the binary blobs inlined into `dist/index.html` — are
derived from the **SABR Lahman Baseball Database** (1871–2025 release).

The Lahman database is copyright © 1996–2025 by SABR (Society for American
Baseball Research), via generous donation from Sean Lahman, and is licensed
under the [Creative Commons Attribution-ShareAlike 3.0 Unported License
(CC BY-SA 3.0)](https://creativecommons.org/licenses/by-sa/3.0/).

By the terms of CC BY-SA 3.0, any work derived from the database — including
the derived CSVs and the packed binary in this project — is itself licensed
under CC BY-SA 3.0. The source code that processes and renders this data is
separately MIT-licensed (see [LICENSE](LICENSE)).

## Required attribution

> **Data:** [SABR Lahman Baseball Database](https://sabr.org/lahman-database/),
> licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).

## Retrosheet play-by-play data

The sub-season / game-by-game layer (`data/pbp/*.bl2p.gz`, lazy-loaded for the
"Smooth" animation) is derived from **Retrosheet**'s parsed game-level CSV
downloads (1898–2025). Retrosheet requires the following notice on any product
that uses its data:

> The information used here was obtained free of charge from and is copyrighted
> by Retrosheet. Interested parties may contact Retrosheet at
> [www.retrosheet.org](https://www.retrosheet.org).

Retrosheet player IDs are crosswalked to the Lahman display names via the
`retroID` column of the Lahman People table.

## Contact

For Lahman licensing inquiries: lahmandb@sabr.org
