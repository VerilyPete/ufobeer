---
title: Enable full TypeScript strict compiler flags and test directory type-checking
implemented: 2026-02-26
commit: 4b35434
tags: [typescript, tsconfig, strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, testing]
---

## Problem

`tsconfig.json` had `"strict": true` but was missing 6 additional strictness flags. The `"exclude": ["test"]` setting meant test files were never type-checked. Two dead flags (`allowJs`, `checkJs`) added noise.

Three categories of errors needed fixing:
- **noUnusedLocals/Parameters**: 6 unused imports and params
- **noUncheckedIndexedAccess**: ~33 errors from array index and `split('T')[0]` patterns
- **exactOptionalPropertyTypes**: 6 errors from explicitly-assigning `undefined` to optional props

## Decision

Added all 6 missing flags: `noUncheckedIndexedAccess`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`. Removed `allowJs`/`checkJs`.

Added a separate `test/tsconfig.json` extending the main config with `noUnusedLocals`, `noUnusedParameters`, and `exactOptionalPropertyTypes` all disabled — test mocks frequently assign `undefined` to optional properties and enforcing these in tests adds noise without improving safety.

Centralized the `split('T')[0]` indexed access pattern into `getToday()` in `src/utils/date.ts`, imported across ~6 files instead of repeated inline.

## Trade-offs

- `exactOptionalPropertyTypes: false` in test tsconfig is a conscious relaxation. Re-enable after cleaning up test mocks (replace `{ prop: undefined }` with conditional spreads or factory functions). Only 1 actual violation existed when re-enabled in commit `f4011ab` — the ~90 estimate was wrong (those were `noUncheckedIndexedAccess` errors).
- Plan listed ~20 files modified; actual was ~45. Downstream import fixes were necessary but not pre-listed.
- Several test files used `global.crypto` which needed replacing with `globalThis.crypto` under strict module mode — not in the plan but required.
- `analytics.ts:trackCron` initially used inline `parts[0] ?? ''` instead of `getToday()` — caught in review, fixed in `e63fab2`.
