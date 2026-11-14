// Parameter schemas that drive the setup forms and the parameter sweep tool.
// f(key, label, unit, min, max, step, help)
const f = (key, label, unit, min, max, step, help, extra = {}) => ({ key, label, unit, min, max, step, help, ...extra });
const sel = (key, label, options, help) => ({ key, label, options, help, kind: 'select' });

export const GEOMETRY_SCHEMAS = {
  catheter: {
    name: 'Catheter / tube',
    fields: [
      f('length', 'Length', 'mm', 2, 400, 1, 'Length of the modelled segment.'),
      f('od', 'Outer diameter', 'mm', 0.1, 20, 0.01, '1 Fr = 0.333 mm.'),
      f('id', 'Inner diameter', 'mm', 0.05, 19, 0.01, 'Lumen diameter.'),
      f('tipLength', 'Tip taper length', 'mm', 0, 100, 0.5, 'Distal taper at the s = L end (0 = none).'),
      f('tipOd', 'Tip outer diameter', 'mm', 0.1, 20, 0.01, ''),
      f('ovality', 'Ovality (b/a)', '', 0.3, 1, 0.01, 'Cross-section aspect ratio; 1 = round.'),
    ],
    defaults: { length: 60, od: 1.67, id: 1.1, tipLength: 0, tipOd: 1.67, ovality: 1 },
  },
  iol_cartridge: {
    name: 'IOL cartridge',
    fields: [
      f('chamberLength', 'Loading chamber length', 'mm', 1, 40, 0.5, ''),
      f('chamberWidth', 'Chamber inner width', 'mm', 1, 12, 0.1, ''),
      f('chamberHeight', 'Chamber inner height', 'mm', 0.5, 12, 0.1, ''),
      f('taperLength', 'Taper length', 'mm', 1, 40, 0.5, 'Converging section that folds/compresses the lens.'),
      f('nozzleWidth', 'Nozzle inner width', 'mm', 0.5, 6, 0.05, ''),
      f('nozzleHeight', 'Nozzle inner height', 'mm', 0.5, 6, 0.05, ''),
      f('nozzleLength', 'Nozzle length', 'mm', 1, 30, 0.5, ''),
      f('tipWidth', 'Tip inner width', 'mm', 0.5, 6, 0.05, ''),
      f('tipHeight', 'Tip inner height', 'mm', 0.5, 6, 0.05, ''),
      f('wall', 'Wall thickness', 'mm', 0.1, 3, 0.05, 'Used for the outer surface.'),
    ],
    defaults: { chamberLength: 12, chamberWidth: 5.6, chamberHeight: 4, taperLength: 14, nozzleWidth: 2.1, nozzleHeight: 1.7, nozzleLength: 10, tipWidth: 1.7, tipHeight: 1.35, wall: 0.6 },
  },
  custom: {
    name: 'Custom profile',
    fields: [f('wall', 'Wall thickness', 'mm', 0, 5, 0.05, 'Added to the profile for the outer surface.')],
    defaults: { wall: 0.3, points: [[0, 1.5, 1.5], [10, 1.5, 1.5], [20, 0.8, 0.7], [30, 0.8, 0.7]] },
    hasPoints: true,
  },
  coupon: {
    name: 'Flat coupon',
    fields: [f('length', 'Length', 'mm', 2, 300, 1, ''), f('width', 'Width', 'mm', 1, 100, 1, '')],
    defaults: { length: 30, width: 10 },
  },
};

const env = [
  f('tempC', 'Temperature', '°C', -10, 250, 1, 'Part/air temperature during the stage.'),
  f('tilt', 'Axis tilt from vertical', '°', 0, 180, 1, '0 = vertical with s = 0 at the top; 90 = horizontal.'),
  f('rpm', 'Part rotation', 'rpm', 0, 600, 1, 'Rotation about the part axis (averages gravity sag).'),
  f('ambientAir', 'Ambient air speed', 'm/s', 0, 30, 0.1, 'Background air movement (evaporation).'),
];

export const STAGE_SCHEMAS = {
  plasma: {
    name: 'Plasma activation', color: 7,
    help: 'Atmospheric plasma raises the substrate polar surface energy (lower contact angle). Activation decays inside lumens with distance from the treated end and recovers with time (hydrophobic recovery).',
    fields: [
      f('duration', 'Treatment time', 's', 1, 600, 1, '~20 s reaches saturation.'),
      f('power', 'Relative power', '', 0, 1, 0.05, '0–1 relative activation.'),
      f('penetrationMm', 'Lumen penetration length', 'mm', 0.5, 100, 0.5, 'Decay length of activation inside a lumen.'),
      sel('fromEnd', 'Treated end(s)', [['both', 'Both ends'], ['start', 'Start (s = 0)'], ['end', 'End (s = L)']], 'Which opening the plasma plume enters.'),
      f('holdMinutes', 'Hold before coating', 'min', 0, 10000, 1, 'Delay to coating: drives hydrophobic recovery.'),
      ...env,
    ],
  },
  dip: {
    name: 'Dip coating', color: 1,
    help: 'Part immersed bottom-first and withdrawn at constant speed. Outer: Landau–Levich–Derjaguin / fibre law. Lumen: fills (with capillary rise), then drains, leaving a Bretherton film.',
    fields: [
      f('speed', 'Withdrawal speed', 'mm/s', 0.01, 100, 0.01, ''),
      f('immersionMm', 'Immersion depth', 'mm', 0.5, 1e9, 0.5, 'Measured from the bottom end (large = whole part).'),
      f('dwell', 'Dwell in bath', 's', 0, 600, 1, ''),
      f('drainAfter', 'Drain time after withdrawal', 's', 0, 3600, 1, ''),
      ...env,
    ],
  },
  spray: {
    name: 'Spray coating', color: 2,
    help: 'Traversing nozzle with a Gaussian spray footprint. Outer: incidence-weighted deposition on the rotating part. Lumen: radial-spray lance moving along the axis.',
    fields: [
      f('flowMlMin', 'Liquid flow rate', 'mL/min', 0.01, 100, 0.01, ''),
      f('transferEff', 'Transfer efficiency', '', 0.05, 1, 0.01, 'Fraction of spray reaching the target plane (bounce, overspray).'),
      f('standoffMm', 'Standoff distance', 'mm', 2, 300, 1, ''),
      f('coneDeg', 'Spray cone angle', '°', 2, 120, 1, ''),
      f('traverseMmS', 'Traverse speed', 'mm/s', 0.1, 500, 0.1, ''),
      f('passes', 'Passes', '', 1, 50, 1, ''),
      f('startMm', 'Traverse start', 'mm', -100, 500, 0.5, ''),
      f('endMm', 'Traverse end', 'mm', -100, 1e9, 0.5, ''),
      f('clockDeg', 'Nozzle clock angle', '°', 0, 360, 1, '90 = from above (horizontal part).'),
      f('inFlightEvapPct', 'In-flight solvent loss', '%', 0, 90, 1, ''),
      f('lanceSigmaMm', 'Lance spray width (lumen)', 'mm', 0.1, 20, 0.1, 'Axial footprint for inner spraying.'),
      f('drainAfter', 'Settle time after spraying', 's', 0, 3600, 1, ''),
      ...env,
    ],
  },
  drip: {
    name: 'Drip insertion', color: 3,
    help: 'Dispensing needle inside/at the part: discrete drops at positions between start and end, or a continuous bead laid while the needle travels.',
    fields: [
      sel('mode', 'Mode', [['drops', 'Discrete drops'], ['bead', 'Continuous bead (needle travel)']], ''),
      f('dropUl', 'Drop volume', 'µL', 0.05, 100, 0.05, ''),
      f('count', 'Number of drops', '', 1, 50, 1, ''),
      f('interval', 'Interval between drops', 's', 0.05, 120, 0.05, ''),
      f('beadUlS', 'Bead dispense rate', 'µL/s', 0.01, 100, 0.01, ''),
      f('needleMmS', 'Needle travel speed', 'mm/s', 0.1, 200, 0.1, ''),
      f('startMm', 'Start position', 'mm', 0, 500, 0.5, ''),
      f('endMm', 'End position', 'mm', 0, 500, 0.5, ''),
      f('clockDeg', 'Clock angle (blank = gravity)', '°', 0, 360, 1, 'Where drops land; blank = lowest point inside / top outside.', { optional: true }),
      f('drainAfter', 'Spreading time after dispensing', 's', 0, 3600, 1, ''),
      ...env,
    ],
  },
  vacuum: {
    name: 'Vacuum withdraw', color: 4,
    help: 'Lumen filled with coating, then a regulated vacuum pulls the liquid plug out. The receding meniscus leaves a Bretherton film whose thickness grows with speed as Ca^(2/3); air then keeps flowing.',
    fields: [
      f('pressureKpa', 'Vacuum (below ambient)', 'kPa', 0.01, 100, 0.01, ''),
      f('fillLengthMm', 'Fill length', 'mm', 0.5, 1e9, 0.5, 'Lumen length initially filled (from the fill end).'),
      sel('fromEnd', 'Fill end', [['start', 'Start (s = 0)'], ['end', 'End (s = L)']], ''),
      sel('direction', 'Withdraw', [['through', 'Through the far end'], ['back', 'Back out of the fill end']], ''),
      f('maxSpeedMmS', 'Meniscus speed limit', 'mm/s', 0, 1000, 0.1, 'Flow restrictor / controller limit (0 = none).'),
      f('airTime', 'Air draw after clearing', 's', 0, 3600, 1, ''),
      ...env,
    ],
  },
  airflow: {
    name: 'Airflow (HACS)', color: 5,
    help: 'Horizontal air jet aimed into the lumen (or along the outside). Interfacial shear drives the film downstream and evaporation increases. In a converging cartridge the air accelerates toward the nozzle.',
    fields: [
      f('duration', 'Duration', 's', 0.5, 3600, 0.5, ''),
      f('nozzleSpeed', 'Air nozzle exit speed', 'm/s', 0, 200, 0.5, ''),
      f('angleDeg', 'Nozzle angle to axis', '°', 0, 89, 1, '0 = blowing straight down the axis.'),
      f('offsetMm', 'Nozzle height offset', 'mm', 0, 20, 0.1, 'Offset of the jet from the lumen axis.'),
      sel('fromEnd', 'Blowing from', [['start', 'Start (s = 0)'], ['end', 'End (s = L)']], ''),
      ...env,
    ],
  },
  dwell: {
    name: 'Flash-off / dwell', color: 6,
    help: 'Rest period: the film levels, drains and dries under the set environment.',
    fields: [f('duration', 'Duration', 's', 0.5, 36000, 1, ''), ...env],
  },
  cure: {
    name: 'Cure', color: 8,
    help: 'Thermal oven (Arrhenius kinetics) or UV exposure (dose-driven). Viscosity rises toward gelation, freezing the film.',
    fields: [
      sel('mode', 'Cure mode', [['thermal', 'Thermal'], ['uv', 'UV']], 'Must match the coating chemistry to have an effect.'),
      f('duration', 'Duration', 's', 1, 36000, 1, ''),
      f('uvIntensity', 'UV intensity', 'mW/cm²', 0, 5000, 1, ''),
      f('uvTransmission', 'UV transmission to lumen', '', 0, 1, 0.01, 'Fraction transmitted through the wall for inner surfaces.'),
      ...env,
    ],
  },
};

export const COATING_OVERRIDES = [
  f('mu0', 'Viscosity', 'Pa·s', 1e-4, 100, 1e-4, 'At 25 °C, as applied.'),
  f('d', 'Surface tension – dispersive', 'mN/m', 5, 80, 0.1, ''),
  f('p', 'Surface tension – polar', 'mN/m', 0, 60, 0.1, ''),
  f('rho', 'Density', 'kg/m³', 600, 2500, 1, ''),
  f('solids', 'Solids (volume fraction)', '', 0.001, 1, 0.001, ''),
  f('evap0', 'Solvent evaporation rate', 'µm/s', 0, 10, 0.001, 'Flat film, still air, 25 °C.'),
  f('thick', 'Thickening exponent', '', 0, 10, 0.1, 'How fast viscosity rises as solvent leaves.'),
  f('shrink', 'Cure shrinkage', '', 0, 0.5, 0.01, ''),
];

export const SUBSTRATE_OVERRIDES = [
  f('d', 'Surface energy – dispersive', 'mN/m', 5, 80, 0.1, ''),
  f('p', 'Surface energy – polar', 'mN/m', 0, 60, 0.1, ''),
];

export const FIELDS = [
  { key: 'dry', label: 'Dry film thickness', unit: 'µm' },
  { key: 'wet', label: 'Wet film thickness', unit: 'µm' },
  { key: 'phi', label: 'Solids fraction', unit: '' },
  { key: 'alpha', label: 'Degree of cure', unit: '' },
  { key: 'theta', label: 'Contact angle', unit: '°' },
];
