// Material and coating property databases plus wetting relations.
// Surface energies in mN/m (split into dispersive "d" and polar "p" parts, Owens–Wendt),
// viscosity in Pa·s, density in kg/m^3. Values are representative literature/typical
// values intended for exploration; replace with measured data for quantitative work.

export const SUBSTRATES = {
  pp: { name: 'Polypropylene (PP)', d: 30.1, p: 0.0, plasmaGain: 32, recoveryHours: 24, permanentFrac: 0.45, note: 'Typical IOL cartridge material' },
  pc: { name: 'Polycarbonate (PC)', d: 35.0, p: 7.0, plasmaGain: 25, recoveryHours: 48, permanentFrac: 0.5 },
  ldpe: { name: 'Polyethylene (LDPE)', d: 31.0, p: 0.0, plasmaGain: 30, recoveryHours: 24, permanentFrac: 0.4 },
  ptfe: { name: 'PTFE', d: 18.6, p: 0.5, plasmaGain: 10, recoveryHours: 72, permanentFrac: 0.6, note: 'Liner / lubricious tubing' },
  fep: { name: 'FEP', d: 17.9, p: 0.3, plasmaGain: 10, recoveryHours: 72, permanentFrac: 0.6 },
  pebax: { name: 'Pebax (PEBA)', d: 34.0, p: 6.0, plasmaGain: 25, recoveryHours: 24, permanentFrac: 0.5, note: 'Common catheter shaft' },
  tpu: { name: 'Thermoplastic polyurethane', d: 37.0, p: 6.0, plasmaGain: 22, recoveryHours: 24, permanentFrac: 0.5, note: 'Common catheter shaft' },
  nylon12: { name: 'Nylon 12', d: 35.0, p: 5.0, plasmaGain: 22, recoveryHours: 48, permanentFrac: 0.5 },
  pdms: { name: 'Silicone (PDMS)', d: 19.0, p: 0.8, plasmaGain: 35, recoveryHours: 3, permanentFrac: 0.1, note: 'Fast hydrophobic recovery' },
  pvc: { name: 'PVC', d: 39.5, p: 1.5, plasmaGain: 20, recoveryHours: 48, permanentFrac: 0.5 },
  peek: { name: 'PEEK', d: 37.0, p: 6.0, plasmaGain: 22, recoveryHours: 96, permanentFrac: 0.6 },
  ss304: { name: 'Stainless steel 304 (cleaned)', d: 32.0, p: 14.0, plasmaGain: 25, recoveryHours: 12, permanentFrac: 0.3, note: 'Mandrels, hypotubes' },
  nitinol: { name: 'Nitinol (oxide)', d: 33.0, p: 15.0, plasmaGain: 25, recoveryHours: 12, permanentFrac: 0.3 },
  glass: { name: 'Borosilicate glass', d: 30.0, p: 40.0, plasmaGain: 5, recoveryHours: 12, permanentFrac: 0.5 },
};

// Coating liquids.
//  gamma: [d, p] mN/m; mu0: Pa·s at 25 C; rho kg/m^3
//  solids: initial solids volume fraction (1 = solvent-free)
//  phiMax: solids fraction at which the film is solvent-free/packed
//  evap0: solvent evaporation rate of a flat free film, still air, 25 C [um/s]
//  dHvap: solvent heat of vaporisation [kJ/mol] (temperature dependence of evaporation)
//  EaMu: viscosity activation energy [kJ/mol]
//  thick: exponent of solids-driven thickening (Krieger-type)
//  cure: cure model and kinetic constants
//  shrink: volumetric cure shrinkage of the dry film (fraction)
export const COATINGS = {
  pvp_water: {
    name: 'Hydrophilic PVP (aqueous/ethanol, UV)', d: 24, p: 14, mu0: 0.05, rho: 980, solids: 0.06, phiMax: 0.95,
    evap0: 0.12, dHvap: 42, EaMu: 18, thick: 4,
    cure: { model: 'uv', kUV: 0.15, nUV: 1, alphaGel: 0.3 }, shrink: 0.05,
    note: 'Lubricious hydrophilic topcoat typical of catheters and IOL cartridges',
  },
  ha_thermal: {
    name: 'Hydrophilic HA (aqueous, thermal crosslink)', d: 26, p: 30, mu0: 0.3, rho: 1005, solids: 0.025, phiMax: 0.92,
    evap0: 0.045, dHvap: 42, EaMu: 20, thick: 3.5,
    cure: { model: 'thermal', A1: 1.4e7, Ea1: 70, A2: 0, Ea2: 70, m: 1, n: 1, alphaGel: 0.35 }, shrink: 0.1,
    note: 'Hyaluronic-acid based lubricious coating, crosslinked by heat (~100–120 °C)',
  },
  pvp_ipa: {
    name: 'Hydrophilic PVP (IPA, UV)', d: 19, p: 4, mu0: 0.02, rho: 830, solids: 0.05, phiMax: 0.95,
    evap0: 0.25, dHvap: 45, EaMu: 18, thick: 4,
    cure: { model: 'uv', kUV: 0.15, nUV: 1, alphaGel: 0.3 }, shrink: 0.05,
  },
  silicone_disp: {
    name: 'Silicone dispersion (heptane, heat cure)', d: 20.5, p: 0.5, mu0: 0.012, rho: 720, solids: 0.10, phiMax: 0.98,
    evap0: 0.6, dHvap: 36, EaMu: 15, thick: 3.5,
    cure: { model: 'thermal', A1: 4.7e5, Ea1: 60, A2: 0, Ea2: 60, m: 1, n: 1.5, alphaGel: 0.5 }, shrink: 0.02,
    note: 'Silicone lubricant coatings for needles, catheters and cartridges',
  },
  silicone_oil_350: {
    name: 'Silicone oil 350 cSt (lubricant)', d: 20.8, p: 0.2, mu0: 0.34, rho: 970, solids: 1.0, phiMax: 1.0,
    evap0: 0, dHvap: 40, EaMu: 14, thick: 0, cure: { model: 'none' }, shrink: 0,
  },
  silicone_oil_1000: {
    name: 'Silicone oil 1000 cSt (lubricant)', d: 20.8, p: 0.2, mu0: 0.97, rho: 970, solids: 1.0, phiMax: 1.0,
    evap0: 0, dHvap: 40, EaMu: 14, thick: 0, cure: { model: 'none' }, shrink: 0,
  },
  ptfe_disp: {
    name: 'PTFE aqueous dispersion (sinter)', d: 22, p: 8, mu0: 0.02, rho: 1450, solids: 0.40, phiMax: 0.64,
    evap0: 0.05, dHvap: 42, EaMu: 16, thick: 2.5,
    cure: { model: 'thermal', A1: 2.0e7, Ea1: 90, A2: 0, Ea2: 90, m: 1, n: 1, alphaGel: 0.2 }, shrink: 0.15,
  },
  pu_thf: {
    name: 'Polyurethane solution (THF, air dry)', d: 24, p: 3, mu0: 0.10, rho: 900, solids: 0.10, phiMax: 0.97,
    evap0: 1.0, dHvap: 32, EaMu: 16, thick: 5,
    cure: { model: 'none' }, shrink: 0,
  },
  acrylate_uv: {
    name: 'UV-curable acrylate (100% solids)', d: 30, p: 6, mu0: 0.30, rho: 1100, solids: 1.0, phiMax: 1.0,
    evap0: 0, dHvap: 40, EaMu: 30, thick: 0,
    cure: { model: 'uv', kUV: 0.4, nUV: 1, alphaGel: 0.15 }, shrink: 0.08,
  },
  heparin_aq: {
    name: 'Heparin aqueous solution', d: 22, p: 38, mu0: 0.003, rho: 1005, solids: 0.02, phiMax: 0.9,
    evap0: 0.04, dHvap: 42, EaMu: 16, thick: 3, cure: { model: 'none' }, shrink: 0,
  },
  water: {
    name: 'Water (reference)', d: 21.8, p: 51.0, mu0: 0.00089, rho: 997, solids: 0.0, phiMax: 0.9,
    evap0: 0.04, dHvap: 42, EaMu: 16, thick: 0, cure: { model: 'none' }, shrink: 0,
  },
};

export const GAS_R = 8.314;

export function totalSurfaceTension(c) { return (c.d + c.p) * 1e-3; } // N/m

// Owens–Wendt–Rabel–Kaelble: cos(theta) = -1 + 2(sqrt(gs_d gl_d) + sqrt(gs_p gl_p))/gl
export function contactAngleOWRK(sub, liq) {
  const gl = liq.d + liq.p;
  let c = -1 + (2 * (Math.sqrt(sub.d * liq.d) + Math.sqrt(sub.p * liq.p))) / gl;
  c = Math.max(-1, Math.min(1, c));
  return Math.acos(c);
}

// Wenzel roughness correction. r >= 1.
export function wenzel(theta, r) {
  const c = Math.max(-1, Math.min(1, r * Math.cos(theta)));
  return Math.acos(c);
}

// Effective substrate after plasma activation: polar component increased by `gain*dose`,
// relaxing toward a permanent fraction with hydrophobic-recovery time constant.
export function activatedSubstrate(sub, activation, hoursSince) {
  if (!activation || activation <= 0) return { ...sub };
  const recov = sub.permanentFrac + (1 - sub.permanentFrac) * Math.exp(-hoursSince / sub.recoveryHours);
  return { ...sub, p: sub.p + sub.plasmaGain * activation * recov };
}

export function resolveCoating(spec) {
  const base = COATINGS[spec.coating] || COATINGS.pvp_water;
  const o = spec.coatingOverrides || {};
  const c = { ...base, ...o, cure: { ...base.cure, ...(o.cure || {}) } };
  return c;
}

export function resolveSubstrate(spec) {
  const base = SUBSTRATES[spec.substrate] || SUBSTRATES.pp;
  return { ...base, ...(spec.substrateOverrides || {}) };
}
