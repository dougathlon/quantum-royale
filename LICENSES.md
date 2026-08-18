# License map

| Paths                                                                                                                                                 | License                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/**/*.ts`, `src/**/*.css`, `scripts/**`, `compiler/**/*.py`, `tests/**`, `vite.config.ts`, `playwright.config.ts`, and other original source code | MIT; see `LICENSE`                                                |
| `public/assets/**`, `art-source/**`, `README.md`, `qa/**`, `fixtures/**`, `schemas/**`, and other original prose or data                              | CC BY-NC 4.0; see `LICENSE-CONTENT.md`                            |
| `node_modules/**` and separately installed Python dependencies                                                                                        | Their own upstream licenses; not redistributed in this repository |
| Phaser code contained in a compiled browser bundle                                                                                                    | Phaser MIT license; see `THIRD_PARTY_NOTICES.md`                  |

Generated pixel PNGs inherit the content license of their checked-in original source definitions. The browser bundle combines MIT-licensed project code and Phaser; it does not relicense Phaser. If a path contains an explicit third-party notice, that notice controls.
