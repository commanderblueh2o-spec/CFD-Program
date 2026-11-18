# CoatSim — coating flow & film-formation simulator

CoatSim is a browser-based CFD tool for exploring how **liquid coatings wet, flow, dry and cure** on medical-device parts, with a focus on **surgical catheters** and **IOL (intraocular lens) cartridges**. It simulates coating on the **outside or inside** of a part for these processes:

| Process | What is modelled |
|---|---|
| **Plasma activation** | Raises substrate polar surface energy (lower contact angle). Decays with depth inside lumens and recovers over time (hydrophobic recovery). |
| **Dip coating** | Constant, ramped or multi-step withdrawal speed. Outer surface: Landau–Levich–Derjaguin / fibre entrainment. Lumen: filling with capillary rise, column drainage, Bretherton film behind the receding meniscus, and capillary hold-up of short columns. |
| **Spray coating** | Traversing nozzles with a Gaussian footprint and incidence angle, set as one or more fixed nozzles spaced around the stationary part, with transfer efficiency and in-flight solvent loss. Lumen: radial-spray lance. |
| **Drip / pump insertion** | A fixed inserter nozzle fed by a peristaltic pump (rate and volume), discrete drops, or a bead laid by a moving needle; several nozzles can be spaced around the bore. Liquid that collects in a narrowing bore bridges into a plug, which drains, is pushed out by air, or stays held by capillarity. |
| **Fill, dwell & withdraw (pumps)** | SAICCS insertion. Coating is pumped into the proximal opening while a peristaltic withdraw pump on the tip pulls it through (priming). The withdraw pump stops, the cartridge fills and dwells (held by back-pressure), then it is pumped out. The pump fixes the flow, so the meniscus speed is Q/A(s): slow in the wide chamber, fast in the nozzle. That sets the Bretherton film along the bore. |
| **Vacuum withdraw** | Lumen filled, then a regulated vacuum pulls the plug through or back out. Poiseuille plug dynamics with capillary pressures, Bretherton film versus meniscus speed, then air draw. |
| **HACS airflow: heated down-draft and bevel blow-off** | Heated air set in SCFH (converted to jet velocity via the nozzle diameter, with the fraction entering the bore as a setting). The air cools along the bore through duct heat transfer, and the wall heats up with a thermal lag, which cures thermal coatings from the inside. Its pressure pushes liquid plugs out. Horizontal jets (also in SCFH, with their nozzle diameter) blow across the tip opening into the long side of the bevel (35° by default), angled with the bevel, so excess is ejected straight off the tip; a misalignment angle shows how off-axis jets also shear the coating on the bevel face. |
| **Flash-off / dwell** | Levelling, drainage, sag and drying under a set temperature, tilt and air speed. Parts never rotate. |
| **Cure** | Stationary thermal oven (the part heats up with a lag, then Arrhenius crosslinking) or UV (dose-driven). Viscosity rises to gelation and freezes the film. |

**Run it:** open `docs/index.html` in any modern browser. It's a single self-contained file that works offline with nothing to install. You can also host it with GitHub Pages: Settings → Pages → Deploy from branch → `main` / `/docs`.

## What you get

- **Animated process playback:** liquid is shown glossy blue (darker = thicker) and flows, then turns matte sand as it dries and amber as it cures. Air jets, the needle, the bath level and oven/UV glow are animated. Smooth interpolated playback at ½–4× speed, click a stage to jump to it, and record the animation to a video file.
- **Sliders** for coating viscosity, surface tension, solids, drying rate and cure speed (time to 90% at 110 °C, activation energy, or UV dose), and for the main settings of each process stage. **Live** mode re-runs automatically on a fast grid.

- **3D view** of the part coloured by dry or wet film thickness, solids fraction, cure or contact angle. It has a lumen cutaway, film-thickness exaggeration, process markers (bath level, applicator, meniscus), and playback through every stage.
- **Unwrapped surface map** (axial position × circumferential angle) with hover readout.
- **Profiles** along and around the part, and **time histories** of thickness, cure, viscosity and film volume.
- **Automatic findings:** incomplete coverage, coating pooled at the tip, axial gradients and sag, circumferential sag, Rayleigh–Plateau beading, edge beads, under-cure, residual solvent and solvent entrapment, and trapped liquid in lumens. Each comes with a suggested remedy.
- **Analytic cross-checks** (LLD and Bretherton predictions), dimensionless groups (Bond number, capillary length, capillary rise) and a mass balance.
- **Parameter sweeps:** vary any stage, coating, geometry or substrate parameter and chart thickness, uniformity and coverage.
- **A/B comparison:** pin a run as reference A, change settings and re-run to see the metric deltas, a plain-language list of changed settings, and a difference map of the final dry film (also for different grids or part lengths).
- **Save and load** setups, shareable links, and CSV/JSON/PNG export.

**Seeing the coating thickness:** in the 3D view the coating is its own layer on the grey wall. Where the bore is cut open, the cut faces show the coating and wall as bands. A full bore, plugs and the tip pool show as liquid filling the cross-section. **Thickness** magnifies the coating (far left = true scale; by default the thickest wet films are drawn at about a third of the bore radius, and the factor is shown), and **Section** slices the part across at any height so the coating shows as a ring.

**3D view controls (Fusion 360 style):** middle-drag to pan, Shift + middle-drag to orbit, scroll to zoom toward the cursor, and double-click the middle button (or F6) to fit. Home or H returns to the home view. Left-drag orbit and right-drag pan also work on trackpads, and a controls panel sits in the corner of the view.

## Geometries and materials

Catheter or tube (optional tapered tip, ovality and bevel), IOL cartridge (loading chamber → taper → nozzle with a bevelled tip, elliptical sections), a custom axial profile (typed in or imported from a CSV of measured positions and diameters, radii or width/height, with units read from the header), and a flat coupon. The substrate library covers PP, PC, PE, PTFE, FEP, Pebax, TPU, nylon, silicone, PVC, PEEK, stainless steel, nitinol and glass. The coating library covers hydrophilic HA (hyaluronic acid, aqueous, thermal crosslink), hydrophilic PVP (aqueous and IPA, UV), silicone dispersion and oils, PTFE dispersion, PU solution, UV acrylate, heparin solution and water. Every property can be edited.

## The physics in one paragraph

The coated surface is unwrapped into an (s, φ) grid that follows the part's real metric and curvature. The film thickness *h* obeys the lubrication equation *∂h/∂t + ∇·q = S − E* with flux *q = (h³/3μ)(−∇p + ρg_t) + (h²/2μ)τ*. The pressure *p = −γ(∇²h + κ_c²h) − Π(h) − ρ(g·n)h* contains capillarity (including the cross-section curvature that drives beading and lumen collars), a disjoining pressure that imposes the Owens–Wendt contact angle, and hydrostatics. Solids are transported with the flow, and solvent evaporates at a rate that depends on temperature, air speed and position in the lumen. Viscosity follows temperature, solids content (Krieger-type) and cure (Castro–Macosko), and cure follows Arrhenius or UV-dose kinetics. Time integration is a linearly implicit, approximately factorised ADI scheme in delta form, with implicit capillary and upwind advection terms, donor-limited mobility for positivity, and adaptive steps. See [`docs/MODEL.md`](docs/MODEL.md).

## Verification

`npm test` runs 24 checks against analytic results, including:

- capillary levelling decay rate (linear theory, within 0.5%)
- Jeffreys gravity drainage (within ~4%)
- Landau–Levich film at the bath line (within 1%)
- Bretherton film from vacuum withdraw (within 2%)
- mass and solids conservation
- spray capture
- UV first-order cure kinetics
- capillary rise and hold-up in lumens, and clearing by air
- plasma decay with depth
- Rayleigh–Plateau beading on thin fibres
- oven cure with part heat-up lag (integrated Arrhenius kinetics)
- heated down-draft wall heating and cure gradient along the bore
- cross-jet blow-off, and bevel-aligned versus misaligned jets
- bevel geometry mass conservation
- plug formation in a narrow bore and clearing by air
- fill/dwell/withdraw film versus Bretherton at the pump-set meniscus speed
- tip pool held by surface tension and blown out by bevel jets above the capillary hold, with volume conserved

`npm run presets` runs every preset headlessly, and `npm run ui-test` drives the built app in headless Chromium.

## Limits

It's a thin-film model. Films must be thin compared with the part radius and gently sloped. Contact lines are resolved only down to the grid size, and very thick puddles (comparable to the lumen radius) are approximate. Material values are typical literature values. **Calibrate** viscosity, surface tension, solids and evaporation rate against one measured film before trusting absolute thicknesses. The tool is strongest for comparing process options and explaining trends.

## Development

```
npm run build      # bundles src/ into docs/index.html (and dist/coatsim.html)
npm test           # verification suite (Node 18+, no dependencies)
npm run presets    # headless regression of all presets
```

Source: `src/core` (physics, no DOM; runs in Node and in a Web Worker) and `src/ui` (interface). See [`docs/ROADMAP.md`](docs/ROADMAP.md) for planned work.
