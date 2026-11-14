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

## Next
- [ ] Confirm SAICCS details with the owner (dispense method, nozzle speeds and temperatures, which opening the blow-off acts on) and calibrate the presets
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
