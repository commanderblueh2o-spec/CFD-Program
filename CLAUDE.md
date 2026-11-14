# CoatSim — notes for development sessions

- Goal: polished, usable thin-film coating simulator for catheters and IOL cartridges (owner's SAICCS machine: plasma station → coating → horizontal airflow "HACS" → cure).
- Layout: `src/core/*` = physics (pure ES modules, no DOM). `src/ui/*` = interface. `build.mjs` bundles everything into `docs/index.html` (GitHub Pages) and `dist/coatsim.html`. Never hand-edit `docs/index.html`.
- Bundler constraints: single-line `import {…} from` statements; `export function|const|class` only; exported names must be unique across all modules.
- Always run before committing: `node build.mjs && node test/core.test.mjs && node test/process.test.mjs`. For UI changes, also run `node tools/ui-test.mjs <presetId> /tmp/shots` (look at the screenshots), `node tools/ui-controls-test.mjs` and `node tools/ui-sweep-test.mjs /tmp/shots`.
- SAICCS facts from the owner: cartridges are stationary (no rotation) and vertical, wide proximal end up. Inserter nozzles dispense coating into the wide proximal end, driven by a peristaltic pump; during the initial insertion, "vacuum" peristaltic pumps on the distal tips withdraw the coating, then stop while filling continues, so the coating dwells ~30 s in the full cartridge (held by positive pressure in the withdraw line). After the dwell the withdraw pump restarts and the cartridge is essentially fully drained before the heated airflow/cure (confirmed by the owner). Modelled by the `fill` stage. In HACS, heated air blows down into the cartridge at 20–60 SCFH and 60–80 °C (default 30 SCFH at 60 °C) to cure the inside, and horizontal nozzles aligned with the tip bevel blow out excess without disturbing the coating on the exposed bevel face. Thermal-cure coatings (HA) otherwise cure stationary in an oven.
- `node tools/run-presets.mjs [id]` gives a headless regression of all presets (each should finish in < 60 s at the normal grid).
- Keep `docs/ROADMAP.md` current: tick items when done, add findings.
- Bump `version` in package.json for user-visible changes.
- Commit messages should explain the physics or UX reason for each change.
