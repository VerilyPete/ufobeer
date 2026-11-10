# Recorded Exa search responses

Real `POST https://api.exa.ai/search` responses, recorded 2026-11-10 for slice 2
of `plans/abv-untappd-fallback.md`. Request body for each:
`query: "<brewer> <name>"`, `type: 'auto'`, `numResults: 8`,
`includeDomains: ['untappd.com']`, `contents: { text: { maxCharacters: 1500 }, livecrawl: 'preferred' }`.

| File | Query |
|---|---|
| `18th-anniversary.json` | `(512) Brewing Co. 18th Anniversary` (the target) |
| `avery-kaiser.json` | `Avery Brewing Co. Avery Kaiser` |
| `boulevard-tank-7.json` | `Boulevard Brewing Co. Boulevard Tank 7` |
| `512-wba-pecan-porter.json` | `(512) Brewing Co. Whiskey Barrel Aged Pecan Porter` (must not match) |
| `sierra-nevada-mango-little-thing.json` | `Sierra Nevada Brewing Co. Sierra Nevada Mango Little Thing` |

Edited before committing, because this repository is public:
- Each result's `text` is cut at its first `### Global Recent Activity`,
  `### Beer Photos` or `### Loyal Drinkers` heading. The heading is kept so the
  section boundary stays, and the user check-ins and photos after it are removed.
- Each result's free-text description (after its `N Ratings` line, up to the
  next heading) is replaced with a placeholder. Some descriptions name staff,
  founders or personal history.
- `requestId` and the per-result `author`, `image`, `favicon` and `entities`
  fields are dropped.

`src/services/untappdMatch.ts` derives its page-structure rules from these files.
