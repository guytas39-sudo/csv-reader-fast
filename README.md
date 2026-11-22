# csv-reader-fast

A faster drop-in for make.fun's csv-reader 1.0.0: `solve.js` reads broken CSV
exactly as csv-reader does — same `{columns, rows, errors}` for every input —
but several times faster.

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?ref=g2zdh0s8)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/guytas39-sudo/csv-reader-fast/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?ref=g2zdh0s8)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/guytas39-sudo/csv-reader-fast/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?ref=g2zdh0s8)

## How it is faster

csv-reader 1.0.0 reads one character at a time and builds every field a
character at a time. This reader instead slices fields out of the text
(`substring`, a view, no copy) and jumps between delimiters with `indexOf`:

- A record whose line holds no quote and no stray CR is split in one native
  `split(',')` call.
- Other records are walked field by field, but a quoted field is still taken
  as one slice unless it holds a doubled quote or a line break inside it.
- Unquoted fields are scanned with `charCodeAt` and sliced once, never built
  up character by character.

The broken-CSV policy is csv-reader's own, reproduced exactly: BOM dropped,
stray CRs, quote junk, unterminated quotes, short/long rows, and errors in
the order met. Verified 6/6 on the kit's practice set, 60/60 on freshly
generated cases from the kit's generator, and 56/56 hand-written edge cases.

## Layout

- `solve.js` — the reader: `run(input)` returns `{columns, rows, errors}`.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json` (with V8's incremental
  marking off, as the house baseline runs).

Built for the [make.fun](https://make.fun?ref=g2zdh0s8) bounty
csv-reader-speed-01-run-20261121.
