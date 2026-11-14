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

## Next
- [x] Confirmed by the owner: the withdraw pump restarts after the dwell and drains the cartridge before heated airflow/cure (as modelled)
- [ ] Get typical fill/withdraw pump rates from the owner

## Done (v0.5) — wall excess and tip pooling (owner observation)
- [x] Wall excess drains to the tip and pools, held by surface tension (won't drain on its own); bevel jets blow it out above ~2γ/r dynamic pressure (~16 m/s for this tip); otherwise it dries as a tip deposit
- [x] Evaporative cooling (wet film near wet-bulb in hot air) and local air speed / heat transfer per cell
- [x] Plug and fill volume bookkeeping made exactly conservative (incl. implicit fluxes into held cells)

Findings: with HACS at 20 m/s bevel jets the tip pool is cleared; the oven route keeps draining after the blow-off and pools ~3.5 µL at the tip (≈80 µm dry deposit). Evaporative cooling delays heating of the wet film, so cure after 10 min at 60 °C is ~72%.

Earlier finding (wall excess after draining, before evaporative cooling): the drained cartridge still carries ~34 µL (65–105 µm wet) on its walls. Under 60 °C HACS air ~70% of it dries in place within ~1 min, and ~7 µL is pushed down and blown off at the bevel. Levers on the dry film: withdraw rate (10 vs 20 µL/s → −25%), air flow (60 vs 30 SCFH → −14%); a 60 s unheated pre-blow changes little (−4%) for 300 mPa·s HA.
- [ ] Calibrate the HA preset against a measured SAICCS cartridge (coating volume, dry thickness, coverage, cure time)
- [ ] Withdrawal speed profiles for dip coating (ramps and multi-step) to counter drainage gradients
- [ ] Simultaneous inner + outer surface run (both walls of a tube in one simulation)
- [ ] Marangoni stresses from solids-dependent surface tension (edge and picture-frame effects)
- [ ] Side-by-side comparison of two runs (A/B) with difference maps
- [ ] Multi-coat processes: base coat + top coat, each with its own coating properties
- [ ] Calibration helper: fit viscosity or evaporation rate to a measured dry thickness
- [ ] Moisture-cure kinetics (RTV silicones), oxygen inhibition for UV acrylates
- [ ] Performance: typed-array kernels, optional multi-worker sweeps
- [ ] Import an axial profile from CSV (e.g. measured cartridge bore)
- [ ] Printable PDF run report
