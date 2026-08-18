# Quantum Royale chicken art provenance

## Legacy V1/V2 SVG asset record

The six chicken sprites under `art-source/legacy-svg/chickens/` were authored directly in this repository as original SVG markup during the 2026-08-17 implementation session. They are preserved as legacy source history outside `public/` and are no longer copied into the build or loaded at runtime in V2.1. No external illustration, stock asset, commercial character, user-supplied image, image-generation output, font, linked raster, or remote resource is incorporated into them. This is a project-authorship record rather than independent rights verification.

Every sprite uses a transparent `96 × 96` view box, faces right by default, shares an approximately common foot baseline, and uses the corresponding palette registered in `src/content/chickens.ts`. Phaser texture keys and paths are bound centrally in `src/assets/chickenManifest.ts`.

| Chicken          | Texture key         | Distinguishing silhouette and markings                                              |
| ---------------- | ------------------- | ----------------------------------------------------------------------------------- |
| Velvet Talon     | `chicken-velvet`    | Purple body, tall split crest, lavender wing, and long swept tail.                  |
| Cornfield Comet  | `chicken-comet`     | Gold body, wheat-fan tail, pale feather shafts, and star-marked wing.               |
| Scarlet Bantam   | `chicken-scarlet`   | Compact round body, short stepped tail, patterned pale wing, and feathered feet.    |
| Midnight Rooster | `chicken-midnight`  | Tall blue-black neck, large red comb, cyan-striped sickle tail, and long legs.      |
| Buttercup Blitz  | `chicken-buttercup` | Fluffy scalloped yellow body, unruly tail, orange crest, and lightning-marked wing. |
| Silver Drumstick | `chicken-silver`    | Broad silver body, barred wing, pale tail stripes, and heavy feathered legs.        |

## Immutable asset identities

| File                   | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `buttercup-blitz.svg`  | `fbc7f66435d51ff596100b67f05d8c33fba3c319e23bdf730dc0e4eb1e9012d8` |
| `cornfield-comet.svg`  | `bd3e932e2efb491d7721652e65bf70a171ca2b59d3c352834e90cfff7537f46b` |
| `midnight-rooster.svg` | `26d28c820d68c5f545e374b0387672b8e0fea10ffb1159e27fae782fbee01691` |
| `scarlet-bantam.svg`   | `f0ae893f0839b7ee5c8f3c74e2456cac4896a8ed784576c22c1f3b8f687d928d` |
| `silver-drumstick.svg` | `ebf5acc7473bf56a5906ca8e2f747e91f33484857bb2dfe99b254935beb0ea9f` |
| `velvet-talon.svg`     | `07ec5b3dcb3b48074e244c49ce89974491735ba16292a25ccb88d69cf3154a41` |

## V2.4 runtime pixel sheets

The V2.4 runtime assets under `public/assets/pixel/` are deterministic PNG outputs from the checked-in original definitions in `scripts/generate-pixel-assets.mjs`. The script uses Node standard-library PNG encoding and hand-specified pixel rectangles; it does not call an image model, asset service, stock library, or remote endpoint. Each chicken sheet is `192 × 24`, divided into eight `24 × 24` frames: two idle frames, peck, guard, cover, hurt, knockdown, and recovery. The compact forward brace cannot be mistaken for shield status or a relationship highlight. Stable chicken IDs, texture keys, fixture qubits, and palettes remain unchanged. The two `40 × 40` commentator portraits and the `12 × 12` shield-status icon were produced by the same local source.

| Runtime file                            | SHA-256                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `pixel/chickens/buttercup-blitz.png`    | `7077340e6d840f5d0c011169055cb29bb92aa9122bac3c051772be3bc099e4f3` |
| `pixel/chickens/cornfield-comet.png`    | `04c71de900645edccb5878259e69a02bf4f37accb69d942657908c412518430c` |
| `pixel/chickens/midnight-rooster.png`   | `692a6f57a1360d79b81c8c6c23eb715183742a6e9dcd039b2eb02ae9e84c5495` |
| `pixel/chickens/scarlet-bantam.png`     | `f01ad13338279f1621ff86680e9b3a536f5347f1f4c7a4f86eea00636040db51` |
| `pixel/chickens/silver-drumstick.png`   | `b875ee0e871a135fe93abaa05240cae042fb79d1c06381eac100ef4082b881ac` |
| `pixel/chickens/velvet-talon.png`       | `67f61da97711873c83c8fd1f88571764cc29c6b7f1711e7d0b2b089969113ff0` |
| `pixel/commentators/clive-peckham.png`  | `0b46d7d021f21eef916c48a1074670a68915d4a81635527d56f3354d762e0b96` |
| `pixel/commentators/henrietta-hype.png` | `08d60d0ebf6aba4948a6628f13b4f65a4b9aaff30d39928562371e37483dbe95` |
| `pixel/ui/shield.png`                   | `90f6d7522bec051143cf6af139822bf1186af28752dc6bd1af530695dd6e5674` |

The presenter monitor also uses an original checked-in `3 × 5` bitmap alphabet in `src/presentation/bitmapAlphabet.ts`. DOM controls and the dense LAB use the browser's generic monospace fallback; no redistributable third-party font file is bundled.

## Legacy runtime and animation boundary

The legacy SVGs are neutral single-pose identity sprites rather than animation strips. The V2.4 PNG sheets supersede them at runtime. Health, shields, pair highlights, presenter framing, and hit emphasis remain separate disposable presentation layers derived from authoritative game state.

The original runtime art is distributed under CC BY-NC 4.0 as mapped in `LICENSES.md`. This provenance record establishes the recorded local origin and generation method; it is not independent rights verification.

## Legacy V2 commentator portraits

The two portraits under `art-source/legacy-svg/commentators/` were authored directly as original SVG markup for Quantum Royale V2 on 2026-08-18. They are retained outside `public/` and are neither copied into the build nor loaded at runtime. The V2.1 pixel portraits preserve Clive Peckham as the gold presenter and Henrietta Hype as the purple analyst with glasses. As above, this is a project-authorship record rather than independent rights verification.
