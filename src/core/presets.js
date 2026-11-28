// Ready-made process recipes. Lengths mm, speeds mm/s, times s, temperatures C.

export const IOL_CARTRIDGE = {
  type: 'iol_cartridge', chamberLength: 12, chamberWidth: 5.6, chamberHeight: 4.0,
  taperLength: 14, nozzleWidth: 2.1, nozzleHeight: 1.7, nozzleLength: 10, tipWidth: 1.7, tipHeight: 1.35, wall: 0.6, tipBevelDeg: 35, bevelClockDeg: 270,
};

export const PRESETS = [
  {
    id: 'saiccs_ha_heated',
    name: 'SAICCS — HA: plasma → fill, dwell & withdraw → HACS heated air (30 SCFH @ 60 °C) + bevel blow-off',
    description: 'Stationary vertical cartridge, wide proximal end up. After plasma, the inserter nozzle pumps HA coating into the proximal end while the withdraw pump on the tip pulls it through; the withdraw pump stops, the cartridge fills and dwells ~30 s, then the coating is withdrawn through the tip. HACS heated air then dries and crosslinks the film while horizontal nozzles aligned with the bevel blow out the excess.',
    geometry: { ...IOL_CARTRIDGE }, surface: 'inner', substrate: 'pp', coating: 'ha_thermal',
    grid: { ns: 120, nphi: 32 }, heatUpSeconds: 25,
    stages: [
      { type: 'plasma', label: 'Plasma activation', duration: 20, power: 1, penetrationMm: 10, fromEnd: 'both', holdMinutes: 1, tilt: 0 },
      { type: 'fill', label: 'Fill, dwell & withdraw', fillFrom: 'start', primeS: 5, fillMlMin: 1.2, dwellS: 30, withdrawMlMin: 1.2, airTime: 2, tilt: 0 },
      { type: 'airflow', label: 'HACS: heated air + bevel blow-off', duration: 600, airFlowScfh: 30, airTempC: 60, nozzleDiaMm: 2, captureFrac: 0.2, fromEnd: 'start', crossJetScfh: 5, crossJetDiaMm: 1.5, crossJetEnd: 'end', crossJetReachMm: 1.5, crossJetAngleDeg: 0, tilt: 0 },
      { type: 'dwell', label: 'Cool down', duration: 60, tilt: 0 },
    ],
    metrics: { zone: [1, 34] },
  },
  {
    id: 'saiccs_ha_oven',
    name: 'IOL cartridge — HA: fill, dwell & withdraw → bevel blow-off → stationary oven cure',
    description: 'Same fill/dwell/withdraw insertion, ambient-air purge with bevel blow-off, then the cartridge cures standing still in an 80 °C oven (the part heats up with a thermal lag).',
    geometry: { ...IOL_CARTRIDGE }, surface: 'inner', substrate: 'pp', coating: 'ha_thermal',
    grid: { ns: 120, nphi: 32 }, heatUpSeconds: 40,
    stages: [
      { type: 'plasma', label: 'Plasma activation', duration: 20, power: 1, penetrationMm: 10, fromEnd: 'both', holdMinutes: 1, tilt: 0 },
      { type: 'fill', label: 'Fill, dwell & withdraw', fillFrom: 'start', primeS: 5, fillMlMin: 1.2, dwellS: 30, withdrawMlMin: 1.2, airTime: 2, tilt: 0 },
      { type: 'airflow', label: 'Air purge + bevel blow-off', duration: 30, airFlowScfh: 30, airTempC: 25, nozzleDiaMm: 2, captureFrac: 0.2, fromEnd: 'start', crossJetScfh: 5, crossJetDiaMm: 1.5, crossJetEnd: 'end', crossJetReachMm: 1.5, tilt: 0 },
      { type: 'cure', label: 'Oven cure 80 °C', mode: 'thermal', duration: 900, tempC: 80, tilt: 0, ambientAir: 0.5 },
    ],
    metrics: { zone: [1, 34] },
  },
  {
    id: 'saiccs_ha_stream',
    name: 'SAICCS — HA: single pumped stream (no withdraw pump) → HACS — for comparison',
    description: 'What happens without the fill/dwell/withdraw step: the coating is pumped into the proximal end and simply runs down one side of the bore before HACS.',
    geometry: { ...IOL_CARTRIDGE }, surface: 'inner', substrate: 'pp', coating: 'ha_thermal',
    grid: { ns: 120, nphi: 32 }, heatUpSeconds: 25,
    stages: [
      { type: 'plasma', label: 'Plasma activation', duration: 20, power: 1, penetrationMm: 10, fromEnd: 'both', holdMinutes: 1, tilt: 0 },
      { type: 'drip', label: 'Pump dispense (proximal end)', mode: 'pump', startMm: 1.5, pumpUlS: 5, pumpVolumeUl: 12, lines: 1, tilt: 0, drainAfter: 20 },
      { type: 'airflow', label: 'HACS: heated air + bevel blow-off', duration: 600, airFlowScfh: 30, airTempC: 60, nozzleDiaMm: 2, captureFrac: 0.2, fromEnd: 'start', crossJetScfh: 5, crossJetDiaMm: 1.5, crossJetEnd: 'end', crossJetReachMm: 1.5, tilt: 0 },
    ],
    metrics: { zone: [1, 34] },
  },
  {
    id: 'cartridge_vacuum',
    name: 'IOL cartridge lumen — vacuum withdraw + UV (PVP)',
    description: 'Stationary vertical cartridge filled from the chamber end; a regulated vacuum pulls the plug down through the nozzle at 2 mm/s, then air drying and UV cure.',
    geometry: { ...IOL_CARTRIDGE }, surface: 'inner', substrate: 'pp', coating: 'pvp_water',
    grid: { ns: 120, nphi: 32 },
    stages: [
      { type: 'plasma', label: 'Plasma activation', duration: 20, power: 1, penetrationMm: 10, fromEnd: 'both', holdMinutes: 1, tilt: 0 },
      { type: 'vacuum', label: 'Vacuum withdraw', pressureKpa: 3, fillLengthMm: 36, fromEnd: 'start', direction: 'through', maxSpeedMmS: 2, airTime: 20, tilt: 0 },
      { type: 'dwell', label: 'Flash-off', duration: 90, tilt: 0 },
      { type: 'cure', label: 'UV cure', mode: 'uv', duration: 30, uvIntensity: 100, uvTransmission: 0.6, tilt: 0 },
    ],
    metrics: { zone: [1, 35] },
  },
  {
    id: 'cartridge_silicone_drops',
    name: 'IOL cartridge lumen — silicone lubricant drops, oven cure',
    description: 'Drops of silicone dispersion dispensed into an untreated PP cartridge, blown through and heat cured stationary in an oven.',
    geometry: { ...IOL_CARTRIDGE }, surface: 'inner', substrate: 'pp', coating: 'silicone_disp',
    grid: { ns: 120, nphi: 32 },
    stages: [
      { type: 'drip', label: 'Drip insertion', mode: 'drops', dropUl: 3, count: 3, interval: 2, startMm: 4, endMm: 20, tilt: 0, drainAfter: 10 },
      { type: 'airflow', label: 'Air purge', duration: 20, airFlowScfh: 20, nozzleDiaMm: 2, fromEnd: 'start', tilt: 0 },
      { type: 'cure', label: 'Oven cure', mode: 'thermal', duration: 900, tempC: 135, tilt: 0 },
    ],
    metrics: { zone: [1, 35] },
  },
  {
    id: 'catheter_ha_dip',
    name: 'Catheter shaft — HA hydrophilic dip, oven cure',
    description: 'Vertical dip in an HA coating, drain and flash, then crosslink in an 80 °C oven.',
    geometry: { type: 'catheter', length: 60, od: 1.67, id: 1.1, tipLength: 6, tipOd: 1.1 }, surface: 'outer', substrate: 'pebax', coating: 'ha_thermal',
    grid: { ns: 120, nphi: 24 }, heatUpSeconds: 20,
    stages: [
      { type: 'plasma', label: 'Plasma activation', duration: 20, power: 1, tilt: 0 },
      { type: 'dip', label: 'Dip', speed: 2, dwell: 5, drainAfter: 20, tilt: 0 },
      { type: 'dwell', label: 'Flash-off', duration: 120, tilt: 0 },
      { type: 'cure', label: 'Oven cure 80 °C', mode: 'thermal', duration: 900, tempC: 80, tilt: 0 },
    ],
    metrics: { zone: [2, 58] },
  },
  {
    id: 'catheter_dip_hydrophilic',
    name: 'Catheter shaft (5 Fr Pebax) — hydrophilic dip, outer',
    description: 'Vertical dip of a 60 mm shaft segment with a tapered tip, drain, flash and UV cure.',
    geometry: { type: 'catheter', length: 60, od: 1.67, id: 1.1, tipLength: 6, tipOd: 1.1 }, surface: 'outer', substrate: 'pebax', coating: 'pvp_water',
    grid: { ns: 120, nphi: 24 },
    stages: [
      { type: 'dip', label: 'Dip', speed: 3, dwell: 5, drainAfter: 20, tilt: 0 },
      { type: 'dwell', label: 'Flash-off', duration: 120, tilt: 0 },
      { type: 'cure', label: 'UV cure', mode: 'uv', duration: 60, uvIntensity: 80, tilt: 0 },
    ],
    metrics: { zone: [2, 58] },
  },
  {
    id: 'catheter_lumen_dip',
    name: 'Catheter lumen — dip fill and gravity drain, inner',
    description: 'Inner lumen of a 1.1 mm ID shaft dip coated vertically: shows capillary rise, column drainage and Bretherton film deposition.',
    geometry: { type: 'catheter', length: 60, od: 1.67, id: 1.1 }, surface: 'inner', substrate: 'pebax', coating: 'pvp_ipa',
    grid: { ns: 120, nphi: 20 },
    stages: [
      { type: 'dip', label: 'Dip', speed: 2, dwell: 5, drainAfter: 20, tilt: 0 },
      { type: 'airflow', label: 'Lumen air purge', duration: 20, airFlowScfh: 10, nozzleDiaMm: 2, fromEnd: 'start', tilt: 0 },
      { type: 'cure', label: 'UV cure', mode: 'uv', duration: 40, uvIntensity: 100, uvTransmission: 0.5, tilt: 0 },
    ],
    metrics: { zone: [2, 58] },
  },
  {
    id: 'catheter_spray_pu',
    name: 'Catheter shaft — spray, polyurethane topcoat',
    description: 'Stationary vertical shaft sprayed by three traversing nozzles spaced around it, flashed and air dried.',
    geometry: { type: 'catheter', length: 60, od: 2.0, id: 1.4 }, surface: 'outer', substrate: 'tpu', coating: 'pu_thf',
    grid: { ns: 120, nphi: 24 },
    stages: [
      { type: 'spray', label: 'Spray', flowMlMin: 3, transferEff: 0.6, standoffMm: 40, coneDeg: 25, traverseMmS: 30, passes: 4, startMm: -5, endMm: 65, nozzles: 3, tilt: 0, drainAfter: 5 },
      { type: 'dwell', label: 'Air dry', duration: 120, tilt: 0, ambientAir: 0.5 },
    ],
    metrics: { zone: [3, 57] },
  },
  {
    id: 'mandrel_silicone_dip',
    name: 'Guidewire / mandrel (0.36 mm) — silicone dip, beading risk',
    description: 'Thin 0.014" wire dip coated in silicone dispersion: small radius drives Rayleigh–Plateau beading unless the film sets fast.',
    geometry: { type: 'catheter', length: 30, od: 0.36, id: 0.2 }, surface: 'outer', substrate: 'ss304', coating: 'silicone_disp',
    grid: { ns: 150, nphi: 12 },
    stages: [
      { type: 'dip', label: 'Dip', speed: 15, dwell: 2, drainAfter: 10, tilt: 0 },
      { type: 'dwell', label: 'Flash-off', duration: 60, tilt: 0 },
      { type: 'cure', label: 'Oven cure', mode: 'thermal', duration: 600, tempC: 150, tilt: 0 },
    ],
    metrics: { zone: [1, 29] },
  },
  {
    id: 'coupon_lld',
    name: 'Reference — flat coupon dip (Landau–Levich check)',
    description: 'Flat PP coupon withdrawn from silicone oil: compare the simulated film with the LLD law and Jeffreys drainage.',
    geometry: { type: 'coupon', length: 30, width: 10 }, surface: 'outer', substrate: 'pp', coating: 'silicone_oil_350',
    grid: { ns: 120, nphi: 8 },
    stages: [ { type: 'dip', label: 'Dip', speed: 1, dwell: 1, drainAfter: 10, tilt: 0 } ],
    metrics: { zone: [2, 28] },
  },
];

export function getPreset(id) {
  const p = PRESETS.find((x) => x.id === id) || PRESETS[0];
  return JSON.parse(JSON.stringify(p));
}
