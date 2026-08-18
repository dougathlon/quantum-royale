# Quantum Royale V2.4 QA record

**Date:** 2026-08-18
**Scope:** public-release presentation, deterministic game boundary, artifact hygiene, desktop/narrow browser rendering, and GitHub Pages readiness

## Current result

The V2.4 web source passes formatting, strict TypeScript, all 117 Vitest tests, and a production build. The release artifact scan passes with 16 files and finds no source map, test hook, local user path, localhost string, or legacy SVG runtime asset. The committed fixture was not regenerated; V1 and V2 retain byte-identical fixture SHA-256 `f00d3123374cbc92600677845c1e7af0e98f93e5cb137d95016f62185dc049cc`.

The managed macOS host still blocks native Playwright Chromium before product assertions with `MachPortRendezvousServer ... Permission denied (1100)`. This is a host boundary, not a browser-test pass. [Linux CI run `32197721442`](https://github.com/dougathlon/quantum-royale/actions/runs/32197721442) passed all three V2.4 Chromium journeys against the built `/quantum-royale/` artifact: the complete desktop game, the seed-`5` audit/export path, and the `412 × 915` layout. The desktop journey also proves that an explicit round pause replaces Coop-Cam with the checkpoint/betting decision surface while the frozen arena remains visible, keeping the complete bet form inside a 1000-pixel viewport.

Equivalent in-app-browser QA passed on `http://127.0.0.1:4202/?test=1&seed=5`:

- the start gate appeared at tick `0`, `1×`, paused;
- all six scoreboard cards showed large KO totals, numeric HP, proportional HP bars, down state, and compact shield status;
- the arena, tracked marker, active relation treatments, Coop-Cam, global desk, and exact resolver rendered together without console warnings or errors;
- the same page exposed exactly four LAB groups and no public role grid;
- the desktop document had `scrollWidth === innerWidth === 1280`;
- at `412 × 915`, the scoreboard remained exactly two columns by three rows with `188 px` cards and `scrollWidth === innerWidth === 412`;
- the public production build excludes the test API even when loaded with `?test=1`.

## Deterministic contracts

- Default seed `260817` logical history: `384397fa0eccde8f8c856f82d60134b9b8befc8d17ae10d2aa6654384229964e`.
- Seed `5` logical history: `35c8295892d01200ba66f39fb704082a75dbdd9403fb4ce07b49218a23e3e9d5`.
- Existing 1×/2×/4×, irregular render partition, pause, intermission, and speed-change invariants remain green.
- New tests cover centralized relation expiry, non-round/restart clearing, unordered-pair deduplication, X/Y/Z priority, newest-event selection, exact pair-control marginals, zero control covariance, ordered-pair reversal, and no fixture/event mutation.
- Tracking and start-gate state remain presentation-only; no fixture probability, PRNG draw, bet, winner, or consequential history changed.

## Browser cases

`pnpm exec playwright test --list` discovers:

1. a complete desktop public journey covering the start gate, four LAB groups, exact resolver, event-level pair control, compact checkpoint chain, above-fold betting, single finale, all six interviews, collapse/restore, and restart;
2. a seed-5 desktop journey proving roles remain final-only and exporting the complete audit JSON;
3. a `412 × 915` journey proving the six scoreboard cards remain 2×3 without horizontal overflow.

## Release evidence

GitHub Pages deployment [`32197841738`](https://github.com/dougathlon/quantum-royale/actions/runs/32197841738) completed successfully. A post-deploy fetch of <https://dougathlon.github.io/quantum-royale/> returned HTTP 200 and verified the V2.4 title, canonical URL, `index,follow` metadata, repository base path, robots file, and hashed production module. The served module contains no test hook, localhost reference, `/Users/` path, provider endpoint, or source-map reference.

- [`quantum-royale-v2.4-release.png`](screenshots/quantum-royale-v2.4-release.png) — active desktop arena, prominent scoreboard, selected relation, Coop-Cam, and global desk.
- [`quantum-royale-v2.4-narrow.png`](screenshots/quantum-royale-v2.4-narrow.png) — narrow two-column scoreboard and stacked broadcast.
- `public/social-card.png` — `1200 × 630` crop derived from the desktop release capture.

Exact hashes:

| Artifact                   | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| desktop release screenshot | `427be9c8b661343e6abcb779915b440669cdb38c7aab1ca5a17fc1b10f1df4eb` |
| narrow screenshot          | `e6f0cf8716a3f59ac11dac50376012e10bfc818e3b03472da82c263fdbb489c6` |
| social card                | `346b865f5ffedde77d87514eeab7e1c16c2372d24bf352f6da663222f606b8d3` |

## Remaining empirical boundary

No unfamiliar spectator has yet completed the locked comprehension check. The release should not be described as audience-validated until one person can identify, without coaching, the leader, winner rule, active relations, Coop-Cam relation, stored distribution and draw, QuantumGraph's offline contribution, classical runtime remainder, and checkpoint change. Browser correctness does not substitute for that study.

Actual sound clarity and fatigue also remain a human-hearing question. Automated tests establish event-bound dispatch, prioritization, mute, volume, and graceful unlock failure—not psychoacoustic quality.
