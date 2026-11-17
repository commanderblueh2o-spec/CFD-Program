# Roadmap

Development is ongoing. Scheduled improvement runs pick the next unchecked item, implement it with tests, verify it in a browser, and push.

## Done (v0.1)
- [x] Thin-film solver on curved grids: ADI, implicit capillary and advection, disjoining-pressure wetting, adaptive steps
- [x] Plasma, dip, spray, drip/bead insertion, vacuum withdraw, HACS airflow, dwell, thermal/UV cure
- [x] Catheter, IOL cartridge, custom profile and coupon geometries; inner and outer surfaces
- [x] Single-file web app: 3D view, unwrapped map, profiles, histories, findings, parameter sweeps, export
- [x] Verification suite (16 analytic/conservation checks) and headless browser tests

## Done (v0.2)
- [x] HA (hyaluronic acid) hydrophilic coating with thermal crosslinking
- [x] Part temperature field with heat-up lag; heated down-draft airflow with axial cooling; horizontal cross-jet blow-off
- [x] SAICCS presets: stationary vertical cartridge, plasma → multi-needle bead → blow-off → heated down-draft or oven cure
- [x] Multi-needle bead dispensing (beads spaced around the bore)
- [x] Simplified UI: sliders for coating and stage parameters, live re-run, cleaner results panel
- [x] Animated playback: glossy liquid → dry → cured colouring, air/needle/bath effects, stage timeline, video recording

Findings: on a vertical, stationary cartridge the heated down-draft sets the film before it drains (87% coverage, flat axial profile). The oven route drains during flash-off (≈6× thicker at the tip). In a 2 mm bore the hot air cools markedly toward the outlet, so cure falls off along the bore.

## Done (v0.3) — SAICCS details from the owner
- [x] Peristaltic pump dispense through a fixed inserter nozzle at the wide proximal end
- [x] Bevelled cartridge tip; horizontal HACS jets aligned with the bevel (misalignment angle setting)
- [x] Heated air in SCFH (20–60, default 30 SCFH at 60 °C), nozzle diameter and capture fraction
- [x] HA cure kinetics retuned to the 60–80 °C window
- [x] Liquid bridging into plugs in narrowing bores; plugs moved by gravity and air pressure; graceful stop at the computing time limit

Findings: with one pumped stream, coverage is limited by wetting (plasma reach) and volume. Larger volumes bridge the nozzle and the plug coats all the way round. Aligned bevel jets keep the bevel-face film (31 µm vs 7 µm at 40° misalignment).

## Done (v0.4)
- [x] Fill, dwell & withdraw stage (SAICCS insertion with tip withdraw pumps): priming, fill, ~30 s dwell, pump-controlled withdrawal
- [x] SAICCS presets use it; the single-stream version is kept as a comparison preset

Findings: fill/dwell/withdraw coats 100% of the bore (vs ~37% for a single pumped stream). The film follows the meniscus speed Q/A(s), so it is thinnest at the top of the wide chamber and thickest through the taper. Withdraw rate is the main thickness lever. 10 min of 60 °C air reaches ~82% cure, lowest toward the tip.

## Done (v0.6) — dip withdrawal speed profiles
- [x] Dip withdrawal profiles: constant, linear ramp (start → end speed along the immersed length) and multi-step (up to three speeds with two switch points); each cell takes the LLD/Bretherton film for the speed at which it leaves the bath
- [x] Verified: ramp/step withdrawal times against closed forms; film at the bath line within 1% of LLD for the local speed; a fast-setting film keeps the (v₁/v₂)^2/3 ratio

Findings: a profile only helps when the film drains before it sets. For PU/THF on a 20 mm coupon a gentle 2.5→0.6 mm/s ramp cuts the CoV from 31% to 24%. Too steep a slow-down (4→0.4 mm/s) lets the thick upper film drain onto the thin lower one and form a drainage front, so the bottom ends up thicker than at constant speed. Fast-setting coatings (silicone dispersion) and long-draining non-volatile oils (Jeffreys regime, independent of the deposit) gain nothing; for these a constant speed is best.
Robustness note: `catheter_lumen_dip` is chaotically sensitive to tiny changes (speed 2 vs 2.001 mm/s → CoV 72% vs 55%), from the lumen column draining to and pooling at the tip. Results for that preset should be read as a range.

## Done (v0.7) — measured profile import
- [x] Import an axial profile from CSV (e.g. a measured cartridge bore): comma/semicolon (decimal comma)/tab/space separated; header picks columns (position; diameter/ID, radius, or width/height) and units (mm, µm, cm, in); descending or tip-first data, repeated stations averaged, dense scans bin-averaged to ≤240 stations; unit sanity checks. Importing keeps the tip bevel and the evaluation zone so SAICCS jets and statistics still apply; Export writes the profile back as CSV. Custom profiles now take a tip bevel too.
- [x] Verified: frustum bore volume from the grid matches πL(r₁²+r₁r₂+r₂²)/3 to 1e-4, also from 4001 noisy points; a CSV replica of the SAICCS cartridge reproduces the built-in preset exactly (1.269 µm, CoV 37%, 100% coverage), with or without ±2 µm measurement noise
- [x] Fixed the "Press Run" placeholder in the empty results panel (text was split into flex columns)

Finding: resetting the evaluation zone on import counts the tip pool deposit and inflates the CoV from 37% to 101% for the same cartridge, so the zone matters as much as the geometry when comparing a measured part with a preset.

## Done (v0.7.1) — results views polish (UI review)
- [x] Surface map in "Coating state" mode now uses the same liquid / dry / cured colours as the 3D view (the legend claimed them, but the map drew dry thickness in a blue colour map, so a fully cured cartridge looked like liquid). Hover shows the state per cell: wet and projected dry thickness and solids for liquid, dry thickness and cure for set film, plug/bath, bare or bevel cut-away.
- [x] Axial thickness chart no longer flattened by the tip deposit: the y-axis is scaled to the evaluation zone (1.3 × its 98th-percentile max) when an outlier is > 1.5× that, the off-scale peak is labelled ("↑ off scale: 111 µm at s = 35.6 mm"), and stations outside the evaluation zone are greyed. The circumference chart now averages over the evaluation zone only, so it matches the "uneven around the circumference" finding.
- [x] `tools/ui-test.mjs` hovers the surface map and prints the tooltip, to catch state-text regressions

Finding: with the SAICCS heated preset the readable axial profile shows the film rising from ~0.5 µm at the top of the wide chamber to ~2–2.5 µm through the taper (meniscus speed Q/A(s)), with a step at the nozzle/taper transition; previously the 111 µm tip deposit hid all of this behind a 0–100 µm axis.

## Done (v0.8) — A/B run comparison
- [x] Pin any result as reference A ("📌 Set as reference A" in the results panel); it is kept as a compact snapshot (final dry film, axial profile, history, metrics, setup) that survives switching presets, re-running and reloading the page
- [x] Every later run shows a comparison card: A vs this run for dry film, P5–P95, CoV, coverage, cure and findings, with Δ (and % for thickness); a plain-language list of the settings that changed (stage fields with their labels and defaults, coating values resolved from the library, part dimensions, measured profile, resolution)
- [x] Difference map "Final dry film − reference A" on the surface map and the 3D part (diverging blue = thinner / orange = thicker, symmetric scale, hover shows both values); evaluation-zone statistics: mean and RMS change, area thicker/thinner, largest change and where
- [x] Axial profile and thickness-history charts overlay A (dashed); the axial y-scale accounts for A so its tip deposit does not flatten the comparison
- [x] Runs on different grids or part lengths are compared at the same distance s from the top (`resampleField` in `src/core/compare.js`: linear in s and around, periodic for tubes, bevel cut-away cells carry no weight, beyond the shorter part = no data). Tested against an analytic field: interior error 5.7e-3 vs the expected linear-interpolation error ≈ 6e-3
- [x] Fixed: chart headers with a two-line title/legend overlapped the plot (fixed 22 px header height)
- [x] `tools/ui-compare-test.mjs`: pin → change viscosity → re-run → table, settings diff, difference map hover, chart overlay, reload persistence, clear

Finding (SAICCS heated preset): lowering the HA viscosity from 300 to ~96 mPa·s thins the dry film by 38% (1.27 → 0.79 µm) and doubles the CoV (37% → 75%); the film is thinner on 90% of the evaluation zone, most of all in the nozzle (−1.5 µm at s ≈ 34 mm), while the corner stripes of the oval bore get slightly thicker. The cure rises 72% → 77% because the thinner film dries sooner.

## Next
- [x] Confirmed by the owner: the withdraw pump restarts after the dwell and drains the cartridge before heated airflow/cure (as modelled)
- [ ] Get typical fill/withdraw pump rates from the owner
- [ ] Make the lumen dip column drainage / tip pooling less sensitive to tiny parameter changes (see v0.6 robustness note)

## Done (v0.5) — wall excess and tip pooling (owner observation)
- [x] Wall excess drains to the tip and pools, held by surface tension (won't drain on its own); bevel jets blow it out above ~2γ/r dynamic pressure (~16 m/s for this tip); otherwise it dries as a tip deposit
- [x] Evaporative cooling (wet film near wet-bulb in hot air) and local air speed / heat transfer per cell
- [x] Plug and fill volume bookkeeping made exactly conservative (incl. implicit fluxes into held cells)

Findings: with HACS at 20 m/s bevel jets the tip pool is cleared; the oven route keeps draining after the blow-off and pools ~3.5 µL at the tip (≈80 µm dry deposit). Evaporative cooling delays heating of the wet film, so cure after 10 min at 60 °C is ~72%.

Earlier finding (wall excess after draining, before evaporative cooling): the drained cartridge still carries ~34 µL (65–105 µm wet) on its walls. Under 60 °C HACS air ~70% of it dries in place within ~1 min, and ~7 µL is pushed down and blown off at the bevel. Levers on the dry film: withdraw rate (10 vs 20 µL/s → −25%), air flow (60 vs 30 SCFH → −14%); a 60 s unheated pre-blow changes little (−4%) for 300 mPa·s HA.
- [ ] Calibrate the HA preset against a measured SAICCS cartridge (coating volume, dry thickness, coverage, cure time)
- [ ] Simultaneous inner + outer surface run (both walls of a tube in one simulation)
- [ ] Marangoni stresses from solids-dependent surface tension (edge and picture-frame effects)
- [ ] Multi-coat processes: base coat + top coat, each with its own coating properties
- [ ] Calibration helper: fit viscosity or evaporation rate to a measured dry thickness
- [ ] Moisture-cure kinetics (RTV silicones), oxygen inhibition for UV acrylates
- [ ] Performance: typed-array kernels, optional multi-worker sweeps
- [ ] Printable PDF run report
