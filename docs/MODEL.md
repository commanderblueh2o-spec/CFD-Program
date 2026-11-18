# CoatSim model reference

All quantities are SI internally. The user interface shows mm, µm, mm/s and °C.

## 1. Surface grid
The part has a straight axis *s* ∈ [0, L] and an elliptical cross-section with semi-axes *a(s)*, *b(s)*. The coated wall is either the outer or the inner surface (lumen); for the outer surface of an IOL cartridge the wall thickness is added. Cells are indexed by axial station *i* and parametric angle φ_j. For each cell the code stores:
- the arc width *w* = |∂X/∂φ| Δφ, the area *A = w Δs*,
- the cross-section curvature κ_c = ab / (a² sin²φ + b² cos²φ)^{3/2},
- the unit normal *n* (pointing into the film: outward for outer surfaces, toward the axis for lumens) and the unit tangents *e_s* and *e_φ*.

The flat coupon uses a rectangular, non-periodic grid.

## 2. Film equation
```
∂h/∂t + ∇·q = S − E
q = M(−∇p + ρ g_t) + (h²/2μ) τ,       M = h³/(3μ)
p = −γ (∇²h + κ_c² h) − Π(h) − ρ (g·n) h
Π(h) = B[(h*/h)³ − (h*/h)²],          B = 2γ(1 − cos θ)/h*
```
- The κ_c² h term is the linearised curvature of the free surface on a cylinder. It drives Rayleigh–Plateau beading on fibres and collar formation in lumens.
- Π imposes the equilibrium contact angle θ on a precursor film of thickness h* (0.05 µm by default; Schwartz & Eley form).
- g·n > 0 means the film hangs below the surface (a ceiling), which is Rayleigh–Taylor unstable.
- τ is the interfacial air shear.

Solids height *m = hφ* is advected with the liquid flux, using the upwind solids fraction. Solvent evaporation stops when φ reaches φ_max.

## 3. Constitutive laws
- **Wetting:** Owens–Wendt–Rabel–Kaelble, cos θ = −1 + 2(√(γ_s^d γ_l^d) + √(γ_s^p γ_l^p))/γ_l, then Wenzel cos θ* = r cos θ.
- **Plasma activation:** adds Δγ_s^p = G·a·[f + (1−f)e^{−t/τ}] to the polar part, where *a* is activation (0–1, saturating at about 20 s), *f* is the permanent fraction and τ is the recovery time. Inside lumens, *a* decays as e^{−d/λ} with distance *d* from the treated opening.
- **Viscosity:** μ = μ₀ · exp[E_μ/R (1/T − 1/T₀)] · [(1 − φ₀/φ_m)/(1 − φ/φ_m)]^k · [α_g/(α_g − α)]^{1.5+α}, capped at 10⁹ Pa·s.
- **Evaporation:** E = E₀ · exp[ΔH_v/R (1/T₀ − 1/T)] · (1 − (φ/φ_m)⁴) · √(1 + U_air/0.15) · f_loc. Without airflow, f_loc = 1/(1 + d_end/3R_h) inside lumens, because vapour must diffuse out of the open ends.
- **Cure:**
  - thermal: dα/dt = (k₁ + k₂α^m)(1 − α)^n with Arrhenius k
  - UV: dα/dt = k_UV √(I/100 mW cm⁻²)(1 − α)^n, with I scaled by the wall transmission for lumens

## 4. Deposition and process laws
- **Dip, outer surface:** h = Ca^{2/3} / (1/(1.34 b) + 1/(0.94 ℓ_c)), limited by 0.8√(μU/ρg). This blends the fibre law (Quéré) with Landau–Levich–Derjaguin. *b* is the local radius of curvature, so flat sides of an oval get a thicker film than its sharp ends.
- **Dip withdrawal profiles:** the withdrawal speed U(x) may vary with withdrawn distance x (linear ramp or up to three steps). Time and position are related by t(x) = ∫dx/U (tabulated, Simpson rule), and each cell receives the LLD/fibre or Bretherton film for U at the moment it leaves the bath (inside a lumen: when the meniscus, a Jurin height above the bath, passes it). Drainage after deposition is then resolved by the film solver.
- **Moving meniscus in a lumen:** h = R·1.34Ca^{2/3}/(1 + 2.5·1.34Ca^{2/3}) (Aussillous & Quéré), with R the hydraulic radius.
- **Plug dynamics (vacuum withdraw, lumen drainage, air clearing):** Q = ΔP / ∫R′ds, using the exact elliptical-duct resistance R′ = 4μ(a² + b²)/(πa³b³). ΔP = applied pressure + ρ g_s L_plug − 2γcosθ/R_rear + 2γcosθ/R_front (front term only while the front is inside). The plug stops when Q → 0, which is capillary hold-up. During a dip, the meniscus sits a Jurin height 2γcosθ/(ρgR) above the bath.
- **Air in lumens:** U = U_in · A_in/A(s); τ = f·½ρU² with f = 16/Re (laminar) or 0.079 Re^{−1/4}. A trapped plug is pushed out by the jet stagnation pressure ½ρU_in². Liquid reaching an open end in an airflow is stripped once its height exceeds γ/(200τ).
- **Spray:** the flux per area is (Q·TE / 2πσ²) exp(−r²/2σ²) · max(0, n·d), where σ = ½·standoff·tan(cone/2), summed over the fixed nozzles spaced evenly around the part (parts do not rotate).
- **Orientation:** parts are stationary (no rotation). Gravity is fixed in the body frame by the stage tilt. An IOL cartridge is always vertical, proximal end up.
- **Drip-off:** an end cell held by capillarity is limited to 0.6 ℓ_c when gravity pulls outward. The excess is counted as dripped.

## 4a. Bevelled tips, bridging and air pressure
- **Bevel:** a cut plane at angle β from square removes cells whose axial position exceeds s_cut = L − (q_max − q)·tan β, where q is the coordinate across the tip toward the long side. Removed cells carry no liquid and have zero-flux faces. Liquid leaves at the last existing cell of each generator line, and the cross-jet acts within a set reach of the bevel edge. The bevel angle is quoted the usual way, as the angle between the bevel face and the axis (SAICCS cartridges ≈ 35°, which gives a cut about 1.4× the tip depth long; the long side is the cartridge floor, clock 270°). The horizontal jets travel parallel to the cut plane from the short side into the long side, so stripped liquid leaves straight off the tip.
- **Bridging:** when the liquid at an axial station fills more than 45% of the cross-section (film ≳ 0.25 R), the thin-film description is replaced by a liquid plug holding that volume. The plug moves under gravity, air pressure and capillary pressures (Section 4), sweeps up film lying beyond its menisci, and leaves a Bretherton film capped at 0.2 R (thicker tube films are unstable and stay with the plug).
- **Fill, dwell & withdraw:** the bore is held full (masked) through priming, filling and dwell. A positive-displacement withdraw pump then empties it at a fixed flow Q, so the receding meniscus moves at U = Q/A(s) independent of pressure. The film left is the Aussillous–Quéré thickness at that speed, capped at 0.2 R.
- **Tip pool:** in a bore, liquid draining into the last few mm (beyond 0.25 R thick) collects as a pool held by surface tension. Like the bridging rule, a pool in an open bevel cannot seal the bore, so the down-draft vents past it. The pool evaporates from its free surface. It drips only above the Tate volume 0.6·2πrγ/(ρg), and a cross-jet removes it when ½ρU² > 2γ/r. Otherwise it dries in place as a tip deposit, reported as a finding. Plugs reaching an opening empty into this pool unless the air pressure exceeds the capillary hold.
- **Evaporative cooling:** the part/film temperature obeys dT/dt = (T_air − T)/τ − q_e/(h_c τ), where q_e = ρ L_v E is the evaporative heat sink and h_c is the local air-side heat-transfer coefficient (duct Nu in bores, 8 + 12√U elsewhere). A wet film therefore sits near the wet-bulb temperature until it dries. Evaporation uses the local air speed in each cell.
- **Air jet from SCFH:** Q = SCFH × 7.866·10⁻⁶ m³/s × T_jet/293 K, U_jet = Q/(πd²/4). The flow entering the bore is the capture fraction × Q (default 0.2: most of a free jet spills around the opening). A blocked bore feels the pressure capture × ½ρU_jet².
- **Cross-jet misalignment:** a jet at angle ψ to the bevel face adds a shear of 4 τ_x sin ψ e^{−d/reach} toward the edge (τ_x = 0.0035 ρU²).

## 4b. Heat
Each cell carries a part temperature T_p that relaxes toward the local air temperature: dT_p/dt = (T_air − T_p)/τ, with τ the part heat-up time constant (default 30 s). Viscosity, evaporation and cure all use T_p.
- **Oven or room:** T_air is the stage temperature.
- **Heated down-draft into a bore:** T_air(x) = T_amb + (T_jet − T_amb) e^{−x/L_th}, with L_th = ṁc_p/(h·P). The heat-transfer coefficient h comes from Nu = 3.66 (laminar) or Dittus–Boelter (turbulent), and x is measured from the inlet.

## 5. Numerics
- Finite volumes with metric face widths.
- Delta-form, approximately factorised ADI: (I − ΔtJ_s)(I − ΔtJ_φ)δ = ΔtR(hⁿ). J contains the frozen-mobility fourth-order capillary operator, the positive part of the second-order disjoining and hydrostatic terms, and upwind-linearised gravity and shear advection. Lines are solved with pentadiagonal and cyclic-pentadiagonal (Sherman–Morrison–Woodbury) solvers.
- Explicit fluxes use a donor-limited mobility M_f = min(M̄, 2M_donor), so precursor cells next to thick drops cannot be pumped dry.
- Adaptive Δt from the relative change in h (25% target), an accuracy CFL ≤ 4, and stage limits. Small undershoots ahead of capillary fronts are clipped to h* and the clipped mass is tracked.

## 6. Outputs
Dry film thickness = m(1 − shrink·α). Statistics are area-weighted over the evaluation zone. Coverage is the area with a dry film of at least 25% of the median, or a user threshold. Defect detection rules are in `src/core/metrics.js`.
