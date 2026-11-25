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
Robustness note: `catheter_lumen_dip` is chaotically sensitive to tiny changes (speed 2 vs 2.001 mm/s → CoV 72% vs 55%), from the lumen column draining to and pooling at the tip. Results for that preset should be read as a range. (Resolved in v0.13.0: spurious solids at the pooled tip; now CoV 13–15% for 1.9–2.1 mm/s.)

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

## Done (v0.13.0) — solids move with the liquid; optional tip grid refinement (owner priority 1)
- [x] Solids transported with the liquid the implicit step actually moved (consistent face fluxes, implicit upwind solids fraction); clipping no longer creates or destroys solids. See the owner-priority item below
- [x] Optional axial grid refinement toward a bevelled tip (`grid.tipRefine`, default off); bit-identical results on uniform grids
- [x] Step-size control ignores film an end cell loses right after the step (cross-jet strip, tip pool)

## Done (v0.14.0) — realistic liquid and plastic shading (owner priority 2)
- [x] Translucent, thickness-dependent liquid; fresnel studio reflections and highlights; volumetric liquid bodies; PP/PC plastic shading; glossy cured HA layer. See the owner-priority item below

## Done (v0.15.0) — see-through cartridge plastic (owner priority 2)
- [x] Translucent, tinted cartridge wall and cut-plane wall band; the liquid shows through the uncut part. See the owner-priority item below

## Done (v0.16.0) — shadows in the bore (owner priority 2)
- [x] Soft key-light shadows, ambient occlusion and occluded reflections inside bores; see the owner-priority item below

## Done (v0.10.2) — saved setups get the bevel (owner feedback)
- [x] The owner's browser restored a cartridge setup saved before the bevel existed (tipBevelDeg 0), so no bevel change showed. Saved and linked setups are now migrated on load: cartridges get the 35° face-to-axis bevel, and other bevels are converted from the old from-square angle
- [x] Tip close-up is exactly side-on, so the cut shows as a straight line at its true angle

## Next
### Owner priorities (2026-11-17) — work these first, in order
- [x] **Coating volume in 3D, especially at the tip.** (complete: every sub-step below is done and checked in every frame by the tests) Check that what is drawn matches the simulated liquid volume. The rendered coating layer (film plus flooded cells), integrated over the drawn geometry at true scale, should equal the film and pool volumes in the mass balance. Add a test and a UI check.
  - [x] (v0.11.0) The tip pool is drawn as a meniscus-shaped body instead of flooding every cell within `poolReach`. It fills up from the long-side point of the bevel, its lower face spans the opening in the bevel plane, and its free surface is a concave meniscus (spherical-cap depth r(1 − sin θ)/cos θ, as a volume-preserving paraboloid). Its volume is the held pool plus the film in the cells it covers (`tipPoolBody` in `src/core/geometry.js`). The overlay shows both. Tests: analytic square and bevelled tube, an independent voxel count on the SAICCS cartridge (0.3 and 3.5 µL within 1%), and film bookkeeping. `ui-test` checks the drawn body against the solver's pool at the largest-pool frame and takes a tip close-up (`6-tip-pool.png`).
  - Finding: the oven preset holds up to 6.8 µL at the tip during the cure (plus 1.5 µL of film under it), a 5.3 mm tall body. The old drawing flooded only the last ~2.7 mm (`poolReach`) whatever the volume, so it under-drew the pool by about half. With the heated preset only ~0.1 µL sits in the bevel scoop.
  - [x] (v0.12.0) Drawn-volume check for the whole coating (film layer at true scale + tip pool + plugs + full bore) against the solver's bookkeeping, in every frame. `src/core/drawn.js` builds the drawn mesh for the view and the tests (`coatingMesh`, `meshVolume`, `heldBody`, `frameLiquid`); frames now record the held liquid (`aux.held`: volume and meniscus positions). Tests: analytic oval bore, thick film inside and outside tubes, coupon edge beads, plug menisci, tip plugs on the cartridge, and every frame of the SAICCS heated and lumen-dip presets (worst 0.49% and 0.35%). `ui-test` steps through the run and fails above 1.5%, and the overlay shows "Liquid on the part … · drawn at true scale …".
  - [x] (v0.12.0) Plugs, the filling bore and held columns are drawn as liquid bodies with concave menisci at their true ends (not whole flooded cell rows); a plug leaving the tip spans the opening in the bevel plane. Close-up: `7-plug-meniscus.png`.
  - Findings from the check on the old drawing (true scale): the filling bore and plugs were drawn as whole flooded cell rows, so the meniscus jumped a row at a time (small fills off by up to 8%); thick films were drawn ~3% short over the drained cartridge (up to ~7% in the nozzle, where the film is 7% of the radius and the inner surface shrinks) and oval sections lost more (radial instead of normal thickness); the end rows were stretched over 1.5 cells, so edge beads were mis-drawn (catheter tip bead +4% of the whole coating); coupon edges were missing half a column (−12.5% on `coupon_lld`). All presets now match within 1%.
  - [x] (v0.12.1) Bore volume through the bevel: the solver's plug and fill bookkeeping (`cumA`) now uses the liquid-holding section `holdArea` (the uncut circular-segment fraction of each bevelled row, `src/core/geometry.js`); the full `crossArea` stays the air path. A pumped meniscus in the bevel moves at Q/A_hold (floored at 10% of the section). Tests: a bevelled round bore holds exactly half the cut length's full volume (0.00%), half the section at mid-cut, and the solver's meniscus for 8 and 120 µL tip plugs on the SAICCS cartridge sits where the drawn body puts it (31.17/31.17 mm and 13.88/13.89 mm; before, 31.98 vs 30.97 mm).
  - Findings: a full SAICCS cartridge now takes 463.6 µL instead of 465.4 µL (−1.8 µL, the scoop); dry film and cure are unchanged within 0.1% (heated) and 2% (oven, max tip deposit 87→90 µm). The worst per-frame drawn-vs-solver error in the heated-preset test dropped from 0.49% to 0.19%. Remaining (fixed in v0.12.2): `ui-test` at the UI grid shows a 0.99% (pre-existing) drawn excess at one fill frame near the proximal opening — check the flat top end of the filling bore.
  - [x] (v0.12.2) Filling bore near the proximal opening: with HA on plasma-treated PP (θ ≈ 1°) the meniscus sag is ~r (≈2 mm in the wide chamber), so a fill level 0.2 mm below the opening put the meniscus's wall contact above the opening, and `heldBody` then drew the end flat at the opening (+3.5 µL, +0.99%). The contact line now pins at the rim and only the centre dips, holding exactly the solver's volume; the "already at the top" shortcut no longer swallows the last half cell. Tests: round bore filled to 0.1 and 0.25 mm below the opening at θ = 1° (exact volume, contact line at the rim, centre below the mean level), and the every-frame check now also uses the run's own tip contact angle (as the view does). `ui-test` worst frame 0.99% → −0.11%.
  - Finding (v0.12.2, grid study at the tip, SAICCS presets, nφ = 32): the part-wide result is grid-converged (heated: dry mean 1.271 / 1.272 / 1.263 µm, CoV 37.5 / 36.7 / 36.6% at ns = 120 / 200 / 320), but the tip is not. Over the lower half of the bevel (last 0.97 mm; 3 / 5 / 9 rows) the dry film is 15.6 / 11.2 / 7.8 µm and over the 3 mm above it 2.57 / 2.43 / 2.28 µm; the heated run's largest tip pool is 0.092 / 0.061 / 0.067 µL. Oven: bevel-half 127 → 150 µm and 3 mm above 78 → 89 µm from ns = 120 to 200. Run time grows ~ns² (dt ∝ ds), so a uniformly finer grid is too slow; refine the grid axially toward the tip instead (next step).
  - [x] (v0.13.0) Resolve the tip better. Axial rows can now be refined toward a bevelled tip (`spec.grid.tipRefine`, 1–8; `tipZoneMm`): rows `tipRefine`× shorter over the bevel cut + 2 mm, smoothly blended (neighbouring rows < 25% apart). The solver, plug/fill bookkeeping (`cumA`, `rowOfS`), drawn bodies, 3D view and surface map all use per-row lengths; uniform grids give bit-identical results (checked on the presets). Tests: rows span the part, 20 rows over the bevel at ×3 (6 uniform), bore and holding volumes grid-independent, liquid and solids conserved and the drawn film within 0.05% on the refined grid.
  - Finding (why it stays off by default): the time step at the tip is set by the accuracy control in the tip cells (thick draining film, jets), not by a CFL limit, so the step count grows with the refinement: ×2 → 3.4× the steps (10 620 vs 3 147, heated), the same cost as a uniform ns = 200 grid (8 111 steps × 200 rows). Local time stepping would be needed to make tip refinement cheap.
  - [x] (v0.13.0) **Solids bug found by the tip study:** solids were moved with the explicit fluxes only, while the liquid moved with the implicit (ADI) update. In stiff tip cells these differ a lot, so the solids fraction swung between 0 and 1 and the clipping (m < 0 → 0, m > h → h) created solids: +0.72 µL (−0.10 µL) in the SAICCS heated run, against 0.53 µL of solids left on the part; +2.58 µL (−1.16 µL) in the oven run. Now each face carries the volume that actually crossed it (explicit flux + the face form of the implicit correction, which sums exactly to the liquid update) and the solids fraction is upwinded implicitly, φ'_k = (m_k A_k + Σ_in V φ'_donor)/(h_k A_k + Σ_in V), solved by symmetric Gauss–Seidel (≈2 sweeps) and applied as conservative face fluxes. Tests: a thick film draining into the cartridge's bevelled tip keeps a uniform solids fraction to 1e-15 and its solids to 1e-15 (was ±10% in φ); the every-frame drawn-volume test also asserts zero solids clipping on the heated and lumen-dip presets.
  - Findings (v0.13.0, presets): heated 1.271 → 1.268 µm, CoV 37%, cure 72% (unchanged), 3 666 → 3 147 steps. Oven: dry mean 3.17 → 1.52 µm, CoV 412% → 141%, tip deposit max 90 → 16 µm (pool still 6.8 µL at its largest, 3.4 µL dried at the tip): most of the old oven tip deposit was solids created by the clipping. Lumen dip: CoV 72% → 14%, and the run is no longer chaotic (1.9 / 2 / 2.001 / 2.1 mm/s → CoV 15 / 14 / 14 / 13%; before 2 vs 2.001 mm/s gave 72% vs 55%). Tip film (heated, distance from the open edge, ns = 120 / ×2 tip / uniform 200): 0–0.3 mm 6.5 / 6.0 / 6.2 µm, 0.3–1 mm 4.4 / 3.4 / 3.4 µm, 1–3 mm 2.50 / 2.42 / 2.42 µm, 3–6 mm 2.14 / 2.13 / 2.11 µm, so the tip now converges with the grid (before: 8.3 / 7.7 / 8.3 and 6.4 / 4.5 / 4.4 µm).
  - Remaining: oven (65 s) and silicone-drops (64 s) presets now run slightly over the 60 s target (more steps once the tip film is no longer artificially stiffened by spurious solids; ~10% overhead from the solids sweep). See the performance item.
- [ ] **More realistic graphics.**
  - [x] (v0.14.0) Translucent liquid with thickness-dependent opacity: a thin wet film is pale and shows the plastic through it, a thick one is deep blue (opacity 0.35 → 0.85 with the same log-thickness scale as the colour), and it turns opaque as it dries or cures. Rendered with premultiplied blending and a depth pre-pass, so only the front-most liquid layer is shaded (no order-dependent double layers on tubes or self-overlapping menisci).
  - [x] (v0.14.0) Specular highlights and a soft studio environment (dim sky, overhead softbox, two tall strip lights beside the viewer) reflected with Schlick fresnel (F0 0.02 for the liquid), so wet surfaces get long vertical highlights along the bore and brighter, more opaque edges at grazing view.
  - [x] (v0.14.0) Liquid bodies (plugs, filling bore, tip pool) look volumetric: their section on the cut-open plane is shaded by the depth of liquid behind it (Beer–Lambert style: deeper in the middle, lighter toward the walls); meniscus surfaces are see-through and glossy; the meniscus centre has a single normal.
  - [x] (v0.14.0) Cartridge plastic: lighter PP/PC with wrapped diffuse (light scattered in the plastic), darkening toward grazing view (longer path through the wall) and a faint glossy reflection. Bare cells now show the wall itself instead of a grey coating layer.
  - [x] (v0.14.0) Cured HA drawn as a thin glossy layer (gloss 0.4 vs 0.1 for a dry film), so it keeps a soft sheen with the strip-light highlights.
  - [x] (v0.14.0) `tools/ui-look.mjs`: 3D-view-only screenshots (oblique and side-on at the tip, at fill / plug / tip pool / end), render time, and before/after with `COATSIM_HTML=<old build>`.
  - Finding: the extra passes and the heavier shader cost ~1.6× per frame in software GL (82 vs 50 ms at 1600×950 in headless SwiftShader); on any GPU this is well under a millisecond, so the animation stays smooth.
  - [x] (v0.15.0) Translucent cartridge wall in the full view and a see-through cut-plane wall band. The bore wall is drawn solid only where it is seen from inside; where it is seen from outside, the outer plastic surface is drawn in two passes: what is behind is multiplied by a tinted transmittance T = tint^(path) × (1 − fresnel), with the path through the wall growing as 1/cos toward the silhouette (denser edges, as in a moulded part), then the light scattered in the slightly hazy PP/PC (∝ 1 − T) and the studio reflection are added. The cut-plane and section wall bands use the same material with a 4× longer path (looking along the wall), so they are milky but tinted by what lies behind. With "Cut open" off, the fill, plugs, tip pool and film now show through the plastic. `tools/ui-look.mjs` also captures the uncut part (whole and tip).
  - Finding: the old uncut view only looked see-through by accident: the coating and liquid bodies are drawn with a polygon offset toward the eye, so wherever they touched the wall they poked through the opaque near wall, unevenly (a white wall strip down one side of the taper). Render cost 78 → 86 ms/frame in software GL (two extra shell passes), negligible on a GPU.
  - [x] (v0.16.0) Soft shadows and ambient occlusion in the bore. Per pixel, rays from the bore wall and the film (3 for a soft key-light shadow, 4 over the hemisphere for ambient light, 1 along the reflection) are traced to where they meet the local elliptical bore; a ray escapes through the cut-open half, either end, the bevelled opening or above the section slice, and otherwise passes the clear PP/PC wall with 72% of its light. Escapes are blended over ~⅓ of the bore radius, so shadow edges are soft penumbrae, not steps between the few rays. A reflected ray that meets the wall shows the dim far wall instead of the studio lights (no bogus strip highlights deep in a closed bore). "Shadows in the bore" in the ⚙ view options switches it off; `tools/ui-look.mjs` reports the render time both ways and how much the shading changes.
  - Finding: inside an uncut cartridge the light now falls off with depth (bright at the open proximal end and at the bevelled opening, ~16% darker on average), which reads as a hollow tube; in the cut-open view the trough is shaded by how much of the cut it sees and the tip brightens toward the bevel. Cost in software GL 85 → 125 ms/frame at 1600×950 (well under 1 ms on a GPU). Liquid bodies (plugs, tip pool, fill) do not yet receive or cast bore shadows.
  - [ ] Smoother film fronts and contact lines (a thin meniscus ridge where a draining film ends; the opacity already fades over one cell).
  - Keep it fast (the animation must stay smooth), and screenshot before and after (`tools/ui-look.mjs`).
- [x] Confirmed by the owner: the withdraw pump restarts after the dwell and drains the cartridge before heated airflow/cure (as modelled)
- [ ] Get typical fill/withdraw pump rates from the owner
- [x] Make the lumen dip column drainage / tip pooling less sensitive to tiny parameter changes (see v0.6 robustness note). Fixed by the v0.13.0 solids transport: the sensitivity came from spurious solids at the pooled tip, not from the drainage itself

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
- [ ] Performance: typed-array kernels, optional multi-worker sweeps. Bring `saiccs_ha_oven` and `cartridge_silicone_drops` back under 60 s (65 s / 64 s at v0.13.0); `_lineSolve` (closures `pc`/`add`) is ~35% of the run time; local time stepping would make `grid.tipRefine` affordable
- [ ] Printable PDF run report
