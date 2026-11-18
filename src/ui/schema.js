// Parameter schemas that drive the setup forms and the parameter sweep tool.
// f(key, label, unit, min, max, step, help, extra)
//  extra.key: shown as a main control (with a slider) rather than under "More settings"
//  extra.sl: [lo, hi, 'log'|'lin'] slider range (defaults to min/max)
const f = (key, label, unit, min, max, step, help, extra = {}) => ({ key, label, unit, min, max, step, help, ...extra });
const sel = (key, label, options, help, extra = {}) => ({ key, label, options, help, kind: 'select', ...extra });

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
      f('taperLength', 'Taper length', 'mm', 1, 40, 0.5, 'Converging section that folds the lens.'),
      f('nozzleWidth', 'Nozzle inner width', 'mm', 0.5, 6, 0.05, ''),
      f('nozzleHeight', 'Nozzle inner height', 'mm', 0.5, 6, 0.05, ''),
      f('nozzleLength', 'Nozzle length', 'mm', 1, 30, 0.5, ''),
      f('tipWidth', 'Tip inner width', 'mm', 0.5, 6, 0.05, ''),
      f('tipHeight', 'Tip inner height', 'mm', 0.5, 6, 0.05, ''),
      f('tipBevelDeg', 'Tip bevel angle', '°', 0, 70, 1, 'Angle of the bevel cut at the nozzle tip (typically 35°; 0 = square cut).'),
      f('bevelClockDeg', 'Bevel orientation', '°', 0, 360, 1, 'Which side of the tip is the long side of the bevel.'),
      f('wall', 'Wall thickness', 'mm', 0.1, 3, 0.05, 'Used for the outer surface.'),
    ],
    defaults: { chamberLength: 12, chamberWidth: 5.6, chamberHeight: 4, taperLength: 14, nozzleWidth: 2.1, nozzleHeight: 1.7, nozzleLength: 10, tipWidth: 1.7, tipHeight: 1.35, tipBevelDeg: 35, bevelClockDeg: 270, wall: 0.6 },
  },
  custom: {
    name: 'Custom profile',
    fields: [
      f('wall', 'Wall thickness', 'mm', 0, 5, 0.05, 'Added to the profile for the outer surface.'),
      f('tipBevelDeg', 'Tip bevel angle', '°', 0, 70, 1, 'Angle of the bevel cut at the distal end (0 = square cut).'),
      f('bevelClockDeg', 'Bevel orientation', '°', 0, 360, 1, 'Which side of the tip is the long side of the bevel.'),
    ],
    defaults: { wall: 0.3, tipBevelDeg: 0, bevelClockDeg: 270, points: [[0, 1.5, 1.5], [10, 1.5, 1.5], [20, 0.8, 0.7], [30, 0.8, 0.7]] },
    hasPoints: true,
  },
  coupon: {
    name: 'Flat coupon',
    fields: [f('length', 'Length', 'mm', 2, 300, 1, ''), f('width', 'Width', 'mm', 1, 100, 1, '')],
    defaults: { length: 30, width: 10 },
  },
};

const env = [
  f('tilt', 'Axis tilt from vertical', '°', 0, 180, 1, '0 = vertical with s = 0 at the top; 90 = horizontal.'),
  f('tempC', 'Room / oven temperature', '°C', -10, 250, 1, 'Air temperature around the part; the part follows it with the heat-up lag.'),
  f('rpm', 'Part rotation', 'rpm', 0, 600, 1, 'Rotation about the part axis (0 = stationary).'),
  f('ambientAir', 'Ambient air speed', 'm/s', 0, 30, 0.1, 'Background air movement (evaporation).'),
];

export const STAGE_SCHEMAS = {
  plasma: {
    name: 'Plasma activation', color: 7,
    help: 'Atmospheric plasma raises the substrate polar surface energy (lower contact angle). Inside a bore the effect fades with distance from the treated opening and recovers over time.',
    fields: [
      f('duration', 'Treatment time', 's', 1, 600, 1, '~20 s reaches saturation.', { main: true, sl: [1, 60, 'lin'] }),
      f('power', 'Relative power', '', 0, 1, 0.05, '0–1 relative activation.', { main: true }),
      f('penetrationMm', 'Reach inside the bore', 'mm', 0.5, 100, 0.5, 'Decay length of activation inside a lumen.', { main: true, sl: [1, 40, 'lin'] }),
      sel('fromEnd', 'Treated opening(s)', [['both', 'Both ends'], ['start', 'Start (s = 0)'], ['end', 'End (s = L)']], ''),
      f('holdMinutes', 'Hold before coating', 'min', 0, 10000, 1, 'Delay to coating: hydrophobic recovery.'),
      ...env,
    ],
  },
  dip: {
    name: 'Dip coating', color: 1,
    help: 'Part dipped bottom-first and withdrawn from the bath. Faster withdrawal = thicker film (∝ speed^2/3). A speed profile that slows toward the end thins the lower part and counters the thickening there from drainage.',
    fields: [
      sel('mode', 'Withdrawal profile', [['constant', 'Constant speed'], ['ramp', 'Linear ramp'], ['steps', 'Multi-step']], 'How the withdrawal speed changes along the immersed length.'),
      f('speed', 'Withdrawal speed (start)', 'mm/s', 0.01, 100, 0.01, 'Speed as the top of the immersed part leaves the bath (the only speed for a constant profile).', { main: true, sl: [0.05, 50, 'log'] }),
      f('speed2', 'Second-step speed', 'mm/s', 0.01, 100, 0.01, 'Speed after the first switch point.', { main: true, sl: [0.05, 50, 'log'], modes: ['steps'] }),
      f('switch1Pct', 'First switch point', '% withdrawn', 0, 100, 1, 'Share of the immersed length withdrawn before changing to the second speed.', { modes: ['steps'] }),
      f('switch2Pct', 'Second switch point', '% withdrawn', 0, 100, 1, 'Change to the end speed here (100 = two steps only).', { modes: ['steps'] }),
      f('speedEnd', 'End speed', 'mm/s', 0.01, 100, 0.01, 'Speed as the bottom end leaves the bath.', { main: true, sl: [0.05, 50, 'log'], modes: ['ramp', 'steps'] }),
      f('drainAfter', 'Drain time', 's', 0, 3600, 1, 'Time hanging after withdrawal.', { main: true, sl: [0, 300, 'lin'] }),
      f('immersionMm', 'Immersion depth', 'mm', 0.5, 1e9, 0.5, 'From the bottom end (blank = whole part).'),
      f('dwell', 'Dwell in bath', 's', 0, 600, 1, ''),
      ...env,
    ],
  },
  spray: {
    name: 'Spray coating', color: 2,
    help: 'Traversing spray nozzle (outside) or radial spray lance (inside a bore).',
    fields: [
      f('flowMlMin', 'Liquid flow rate', 'mL/min', 0.01, 100, 0.01, '', { main: true, sl: [0.05, 20, 'log'] }),
      f('passes', 'Passes', '', 1, 50, 1, '', { main: true, sl: [1, 20, 'lin'] }),
      f('traverseMmS', 'Traverse speed', 'mm/s', 0.1, 500, 0.1, '', { main: true, sl: [1, 200, 'log'] }),
      f('transferEff', 'Transfer efficiency', '', 0.05, 1, 0.01, ''),
      f('standoffMm', 'Standoff distance', 'mm', 2, 300, 1, ''),
      f('coneDeg', 'Spray cone angle', '°', 2, 120, 1, ''),
      f('startMm', 'Traverse start', 'mm', -100, 500, 0.5, ''),
      f('endMm', 'Traverse end', 'mm', -100, 1e9, 0.5, ''),
      f('clockDeg', 'Nozzle clock angle', '°', 0, 360, 1, '90 = from above (horizontal part).'),
      f('inFlightEvapPct', 'In-flight solvent loss', '%', 0, 90, 1, ''),
      f('lanceSigmaMm', 'Lance spray width (bore)', 'mm', 0.1, 20, 0.1, ''),
      f('drainAfter', 'Settle time', 's', 0, 3600, 1, ''),
      ...env,
    ],
  },
  drip: {
    name: 'Drip / needle insertion', color: 3,
    help: 'A dispensing needle lays drops or a continuous bead between the start and end positions. Several needles can be spaced around the bore.',
    fields: [
      sel('mode', 'Mode', [['pump', 'Pump through a fixed nozzle'], ['bead', 'Continuous bead (needle travels)'], ['drops', 'Discrete drops']], '', { main: true }),
      f('pumpUlS', 'Pump rate', 'µL/s', 0.05, 200, 0.05, 'Peristaltic pump delivery rate.', { main: true, sl: [0.5, 50, 'log'], mode: 'pump' }),
      f('pumpVolumeUl', 'Volume dispensed', 'µL', 0.1, 1000, 0.1, '', { main: true, sl: [1, 100, 'log'], mode: 'pump' }),
      f('lines', 'Nozzles / beads around the bore', '', 1, 12, 1, 'Number of nozzles or bead lines spaced evenly around the circumference.', { main: true, sl: [1, 8, 'lin'] }),
      f('beadUlS', 'Dispense rate', 'µL/s', 0.01, 100, 0.01, '', { main: true, sl: [0.1, 20, 'log'], mode: 'bead' }),
      f('needleMmS', 'Needle travel speed', 'mm/s', 0.1, 200, 0.1, '', { main: true, sl: [0.5, 50, 'log'], mode: 'bead' }),
      f('dropUl', 'Drop volume', 'µL', 0.05, 100, 0.05, '', { main: true, sl: [0.2, 20, 'log'], mode: 'drops' }),
      f('count', 'Number of drops', '', 1, 50, 1, '', { main: true, sl: [1, 12, 'lin'], mode: 'drops' }),
      f('interval', 'Interval between drops', 's', 0.05, 120, 0.05, '', { mode: 'drops' }),
      f('startMm', 'Nozzle / start position', 'mm', 0, 500, 0.5, 'Axial position (s) of the nozzle, or where the needle starts.'),
      f('endMm', 'End position', 'mm', 0, 500, 0.5, '', { modes: ['bead', 'drops'] }),
      f('clockDeg', 'Clock angle (blank = gravity)', '°', 0, 360, 1, 'Where liquid lands; blank = lowest point inside / top outside.', { optional: true }),
      f('drainAfter', 'Spreading time', 's', 0, 3600, 1, '', { main: true, sl: [0, 120, 'lin'] }),
      ...env,
    ],
  },
  fill: {
    name: 'Fill, dwell & withdraw (pumps)', color: 4,
    help: 'The inserter pumps coating into one opening while a withdraw pump on the other opening pulls it through (priming). The withdraw pump stops, the bore fills and the coating dwells, held by back-pressure in the withdraw line; then it is pumped out. The receding meniscus leaves a film that is thicker where it moves faster (narrow sections).',
    fields: [
      f('dwellS', 'Dwell (cartridge full)', 's', 0, 600, 1, 'Time the coating sits in the full cartridge.', { main: true, sl: [0, 120, 'lin'] }),
      f('withdrawUlS', 'Withdraw pump rate', 'µL/s', 0.1, 500, 0.1, 'Sets the meniscus speed (rate ÷ local cross-section): faster = thicker film.', { main: true, sl: [1, 100, 'log'] }),
      f('fillUlS', 'Fill pump rate', 'µL/s', 0.1, 500, 0.1, '', { main: true, sl: [1, 100, 'log'] }),
      f('primeS', 'Prime (flow-through) time', 's', 0, 300, 1, 'Withdraw pump running while the inserter fills.', { main: true, sl: [0, 30, 'lin'] }),
      sel('fillFrom', 'Coating enters at', [['start', 'Start (s = 0, proximal)'], ['end', 'End (s = L)']], ''),
      f('fillLevelMm', 'Liquid level below the opening', 'mm', 0, 100, 0.5, '0 = filled to the brim.'),
      f('airTime', 'Hold after emptying', 's', 0, 600, 1, ''),
      ...env,
    ],
  },
  vacuum: {
    name: 'Vacuum withdraw', color: 4,
    help: 'Bore filled with coating, then a regulated vacuum pulls the liquid out. Slower meniscus = thinner film.',
    fields: [
      f('pressureKpa', 'Vacuum (below ambient)', 'kPa', 0.01, 100, 0.01, '', { main: true, sl: [0.1, 80, 'log'] }),
      f('maxSpeedMmS', 'Meniscus speed limit', 'mm/s', 0, 1000, 0.1, 'Flow restrictor / controller limit (0 = none).', { main: true, sl: [0, 50, 'lin'] }),
      f('airTime', 'Air draw after clearing', 's', 0, 3600, 1, '', { main: true, sl: [0, 120, 'lin'] }),
      f('fillLengthMm', 'Fill length', 'mm', 0.5, 1e9, 0.5, ''),
      sel('fromEnd', 'Fill end', [['start', 'Start (s = 0)'], ['end', 'End (s = L)']], ''),
      sel('direction', 'Withdraw', [['through', 'Through the far end'], ['back', 'Back out of the fill end']], ''),
      ...env,
    ],
  },
  airflow: {
    name: 'HACS airflow — heated down-draft / blow-off', color: 5,
    help: 'Heated air blowing down into the bore dries and crosslinks the coating (and pushes out any liquid plug); horizontal jets aligned with the tip bevel blow out the excess at the tip.',
    fields: [
      f('duration', 'Duration', 's', 0.5, 7200, 0.5, '', { main: true, sl: [1, 1800, 'log'] }),
      f('airFlowScfh', 'Down-draft air flow', 'SCFH', 0, 200, 1, 'Standard cubic feet per hour through the down-draft nozzle (0 = off).', { main: true, sl: [0, 80, 'lin'] }),
      f('airTempC', 'Air temperature', '°C', -10, 300, 1, 'Heated air dries and cures thermal coatings inside the bore.', { main: true, sl: [20, 120, 'lin'] }),
      f('crossJetScfh', 'Horizontal bevel jets', 'SCFH', 0, 100, 0.5, 'Flow per horizontal nozzle. The jets blow across the tip opening into the long side of the bevel, angled with the bevel, so excess coating is ejected straight off the tip (0 = off).', { main: true, sl: [0, 20, 'lin'] }),
      f('crossJetAngleDeg', 'Jet misalignment to bevel', '°', 0, 90, 1, '0 = jets angled to match the bevel (the intended set-up); larger angles also shear the coating on the bevel face.', { main: true, sl: [0, 60, 'lin'] }),
      f('nozzleDiaMm', 'Down-draft nozzle diameter', 'mm', 0.2, 20, 0.1, 'Converts SCFH to jet velocity.'),
      f('crossJetDiaMm', 'Horizontal nozzle diameter', 'mm', 0.2, 20, 0.1, 'Converts SCFH to jet velocity.'),
      f('captureFrac', 'Fraction of down-draft entering the bore', '', 0.02, 1, 0.01, 'How much of the jet goes into the cartridge rather than spilling around it.'),
      sel('crossJetEnd', 'Blow-off at', [['end', 'End (s = L)'], ['start', 'Start (s = 0)'], ['none', 'None']], ''),
      f('crossJetReachMm', 'Blow-off reach', 'mm', 0.2, 20, 0.1, 'How far from the opening the cross-jet acts.'),
      sel('fromEnd', 'Axial jet enters at', [['start', 'Start (s = 0)'], ['end', 'End (s = L)']], ''),
      f('angleDeg', 'Jet angle to axis', '°', 0, 89, 1, ''),
      f('offsetMm', 'Jet offset from axis', 'mm', 0, 20, 0.1, ''),
      ...env,
    ],
  },
  dwell: {
    name: 'Flash-off / dwell', color: 6,
    help: 'Rest period: the film levels, drains and dries.',
    fields: [f('duration', 'Duration', 's', 0.5, 36000, 1, '', { main: true, sl: [1, 1800, 'log'] }), ...env],
  },
  cure: {
    name: 'Cure (oven / UV)', color: 8,
    help: 'Thermal oven (part heats up with a lag, then Arrhenius crosslinking) or UV exposure.',
    fields: [
      sel('mode', 'Cure mode', [['thermal', 'Thermal oven'], ['uv', 'UV']], 'Must match the coating chemistry.', { main: true }),
      f('tempC', 'Oven temperature', '°C', -10, 300, 1, '', { main: true, sl: [25, 200, 'lin'] }),
      f('duration', 'Duration', 's', 1, 36000, 1, '', { main: true, sl: [10, 3600, 'log'] }),
      f('uvIntensity', 'UV intensity', 'mW/cm²', 0, 5000, 1, '', { main: true, sl: [5, 1000, 'log'], cure: 'uv' }),
      f('uvTransmission', 'UV transmission into bore', '', 0, 1, 0.01, '', { cure: 'uv' }),
      f('tilt', 'Axis tilt from vertical', '°', 0, 180, 1, ''),
      f('rpm', 'Part rotation', 'rpm', 0, 600, 1, ''),
      f('ambientAir', 'Oven air speed', 'm/s', 0, 30, 0.1, ''),
    ],
  },
};

export const SUBSTRATE_OVERRIDES = [
  f('d', 'Surface energy – dispersive', 'mN/m', 5, 80, 0.1, ''),
  f('p', 'Surface energy – polar', 'mN/m', 0, 60, 0.1, ''),
];

export const FIELDS = [
  { key: 'state', label: 'Coating state (animation)', unit: '' },
  { key: 'dry', label: 'Dry film thickness', unit: 'µm' },
  { key: 'wet', label: 'Wet film thickness', unit: 'µm' },
  { key: 'alpha', label: 'Degree of cure', unit: '' },
  { key: 'temp', label: 'Part temperature', unit: '°C' },
  { key: 'phi', label: 'Solids fraction', unit: '' },
  { key: 'theta', label: 'Contact angle', unit: '°' },
  { key: 'diff', label: 'Final dry film − reference A', unit: 'µm', needsRef: true },
];
