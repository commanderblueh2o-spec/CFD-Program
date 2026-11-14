# CoatSim — notes for development sessions

- Goal: polished, usable thin-film coating simulator for catheters and IOL cartridges (owner's SAICCS machine: plasma station → coating → horizontal airflow "HACS" → cure).
- Layout: `src/core/*` = physics (pure ES modules, no DOM). `src/ui/*` = interface. `build.mjs` bundles everything into `docs/index.html` (GitHub Pages) and `dist/coatsim.html`. Never hand-edit `docs/index.html`.
- Bundler constraints: single-line `import {…} from` statements; `export function|const|class` only; exported names must be unique across all modules.
- Always run before committing: `node build.mjs && node test/core.test.mjs && node test/process.test.mjs`. For UI changes, also run `node tools/ui-test.mjs <presetId> /tmp/shots` and look at the screenshots.
- `node tools/run-presets.mjs [id]` gives a headless regression of all presets (each should finish in < 60 s at the normal grid).
- Keep `docs/ROADMAP.md` current: tick items when done, add findings.
- Bump `version` in package.json for user-visible changes.
- Commit messages should explain the physics or UX reason for each change.
