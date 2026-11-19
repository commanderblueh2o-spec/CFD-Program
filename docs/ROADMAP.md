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

## Done (v0.8.1) — tip jets, 35° bevel, smooth model, Fusion-style camera (owner feedback)
- [x] Horizontal tip jets drawn blowing across the opening into the long side of the bevel, parallel to the bevel plane, with excess ejected straight off the tip (head/tail streaks show the travel direction)
- [x] Default cartridge bevel 35°
- [x] Smooth 3D model: the exact elliptical section with 4× circumferential subdivision, blended colours, and vertices clamped onto the cut plane (no stepped bevel); the surface map is interpolated
- [x] Fusion 360 camera: middle-drag pan, Shift + middle-drag orbit, wheel zoom about the surface under the cursor (the orbit pivot lands on the part), double-click middle / F6 to fit, Home / H for the home view; a controls panel and Home/Fit buttons in the corner

## Done (v0.8.2) — cartridge orientation (owner request)
- [x] IOL cartridges default to vertical, wide proximal end up and tip down, in every stage: on presets, when the part is switched to a cartridge, for newly added stages, and in the solver's stage defaults

## Done (v0.9.0) — no rotation, visible 35° bevel, cartridge locked upright (owner feedback)
- [x] Removed every rotation option (stage rpm fields, rotating presets, rotation advice); old saved setups with rpm are ignored. Spray uses 1–8 fixed nozzles spaced around the part instead
- [x] Bevel angle measured between the face and the axis (the usual convention): 35° now gives a ~1.9 mm cut on the 1.35 mm-deep tip instead of ~0.9 mm
- [x] Bevelled bores are cut open along the bevel plane and viewed from that side, so the whole slant is shown in profile. Default drip/stream placement moves to the middle of the visible half
- [x] IOL cartridge tilt locked to vertical, proximal end up, in every stage (the tilt field is hidden); old saved setups with a horizontal stage no longer flip the cartridge during playback
- Finding: with the long side across the wider 1.7 mm tip dimension (clock 0°), the fill stage leaves a ~115 µm bead on the short-side lip that 5 SCFH jets don't strip (capillary hold ≈ 130 µm). With the long side on the cartridge floor (270°) it doesn't happen

## Done (v0.10.0) — coating drawn as a 3D layer (owner request)
- [x] The wall is drawn in grey at its true position and the coating as a separate surface standing off it by film × magnification; flooded cells (fill, plugs, bath, tip pool) fill the bore to the axis
- [x] Caps on the cut-open plane show the coating band and the wall band (exact plane, not per-vertex)
- [x] Thickness slider: log scale from true scale up to max(20× auto, ×2000); auto draws the run's 95th-percentile film/radius at a third of the bore radius; the factor is shown next to the slider and in the overlay
- [x] Section slider: slices the part across at any height and draws the coating and wall as rings

## Done (v0.10.1) — bevel visibility (owner feedback)
- [x] Outline drawn round the bevelled tip opening, plus a Tip close-up (⌖ button / T key). At true size a 35° bevel on the 1.35 mm-deep tip is only ~1.9 mm of a 36 mm cartridge, so it barely showed at full-part zoom

## Done (v0.11.0) — tip pool drawn to volume (owner priority 1)
- [x] Meniscus-shaped tip pool body with the solver's volume; see the owner-priority item below

## Done (v0.12.0) — whole coating drawn to volume (owner priority 1)
- [x] Drawn liquid volume checked against the solver in every frame; plugs, fill and held columns drawn with menisci; thick films, oval bores, tube outsides and coupon edges drawn to volume. See the owner-priority item below

## Done (v0.10.2) — saved setups get the bevel (owner feedback)
- [x] The owner's browser restored a cartridge setup saved before the bevel existed (tipBevelDeg 0), so no bevel change showed. Saved and linked setups are now migrated on load: cartridges get the 35° face-to-axis bevel, and other bevels are converted from the old from-square angle
- [x] Tip close-up is exactly side-on, so the cut shows as a straight line at its true angle

## Next
### Owner priorities (2026-11-17) — work these first, in order
- [ ] **Coating volume in 3D, especially at the tip.** Check that what is drawn matches the simulated liquid volume. The rendered coating layer (film plus flooded cells), integrated over the drawn geometry at true scale, should equal the film and pool volumes in the mass balance. Add a test and a UI check.
  - [x] (v0.11.0) The tip pool is drawn as a meniscus-shaped body instead of flooding every cell within `poolReach`. It fills up from the long-side point of the bevel, its lower face spans the opening in the bevel plane, and its free surface is a concave meniscus (spherical-cap depth r(1 − sin θ)/cos θ, as a volume-preserving paraboloid). Its volume is the held pool plus the film in the cells it covers (`tipPoolBody` in `src/core/geometry.js`). The overlay shows both. Tests: analytic square and bevelled tube, an independent voxel count on the SAICCS cartridge (0.3 and 3.5 µL within 1%), and film bookkeeping. `ui-test` checks the drawn body against the solver's pool at the largest-pool frame and takes a tip close-up (`6-tip-pool.png`).
  - Finding: the oven preset holds up to 6.8 µL at the tip during the cure (plus 1.5 µL of film under it), a 5.3 mm tall body. The old drawing flooded only the last ~2.7 mm (`poolReach`) whatever the volume, so it under-drew the pool by about half. With the heated preset only ~0.1 µL sits in the bevel scoop.
  - [x] (v0.12.0) Drawn-volume check for the whole coating (film layer at true scale + tip pool + plugs + full bore) against the solver's bookkeeping, in every frame. `src/core/drawn.js` builds the drawn mesh for the view and the tests (`coatingMesh`, `meshVolume`, `heldBody`, `frameLiquid`); frames now record the held liquid (`aux.held`: volume and meniscus positions). Tests: analytic oval bore, thick film inside and outside tubes, coupon edge beads, plug menisci, tip plugs on the cartridge, and every frame of the SAICCS heated and lumen-dip presets (worst 0.49% and 0.35%). `ui-test` steps through the run and fails above 1.5%, and the overlay shows "Liquid on the part … · drawn at true scale …".
  - [x] (v0.12.0) Plugs, the filling bore and held columns are drawn as liquid bodies with concave menisci at their true ends (not whole flooded cell rows); a plug leaving the tip spans the opening in the bevel plane. Close-up: `7-plug-meniscus.png`.
  - Findings from the check on the old drawing (true scale): the filling bore and plugs were drawn as whole flooded cell rows, so the meniscus jumped a row at a time (small fills off by up to 8%); thick films were drawn ~3% short over the drained cartridge (up to ~7% in the nozzle, where the film is 7% of the radius and the inner surface shrinks) and oval sections lost more (radial instead of normal thickness); the end rows were stretched over 1.5 cells, so edge beads were mis-drawn (catheter tip bead +4% of the whole coating); coupon edges were missing half a column (−12.5% on `coupon_lld`). All presets now match within 1%.
  - [ ] Bore volume through the bevel: the solver's plug and fill bookkeeping (`cumA`, `crossArea`) counts the full cross-section in the bevelled rows, but the cut-away scoop can't hold liquid. The drawing keeps the solver's volume, so a small plug at the tip is drawn ~1 mm higher than the solver's meniscus (8 µL: 30.97 vs 31.98 mm), and a completely full cartridge is 1.8 µL (0.5%) more than the bore holds. Use the uncut section fraction in `crossArea` for the bevelled rows.
  - Resolve the tip better: check grid resolution over the ~1.9 mm bevel (only ~6 rows at ns = 120). Consider axial grid refinement toward the tip, and check that the liquid on the exposed bevel face and its edge bead are captured.
- [ ] **More realistic graphics.**
  - Translucent liquid with a refraction-like tint and thickness-dependent opacity (thin films pale, thick ones deep blue).
  - Specular highlights and a soft environment light.
  - Proper translucent cartridge plastic (PP/PC) with edge darkening (fresnel).
  - Soft shadows or ambient occlusion in the bore.
  - A smooth meniscus at contact lines and film fronts.
  - The cured HA film as a thin glossy layer.
  - Keep it fast (the animation must stay smooth), and screenshot before and after.
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
