// DRAWINGS: four Excalidraw scenes, one per sharing level.
//
// Elements carry the fields Excalidraw's restore path expects; ids are fixed
// strings so a scene is byte-identical run to run. The seeder renders a
// preview SVG for the three element kinds used here (rectangle, text, arrow).

function box(id, x, y, w, h, text, seed, stroke = '#1e1e1e') {
  const el = {
    id, type: 'rectangle', x, y, width: w, height: h, angle: 0,
    strokeColor: stroke, backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, roundness: { type: 3 }, seed, version: 1, versionNonce: seed + 1,
    isDeleted: false, boundElements: [{ type: 'text', id: `${id}-t` }], updated: 1, link: null, locked: false,
  };
  const label = {
    id: `${id}-t`, type: 'text', x: x + 8, y: y + h / 2 - 12, width: w - 16, height: 24, angle: 0,
    strokeColor: stroke, backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, roundness: null, seed: seed + 2, version: 1, versionNonce: seed + 3,
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
    text, originalText: text, fontSize: 16, fontFamily: 1, textAlign: 'center', verticalAlign: 'middle',
    containerId: id, lineHeight: 1.25, baseline: 18, autoResize: true,
  };
  return [el, label];
}

function arrow(id, from, to, seed) {
  const [x1, y1] = from; const [x2, y2] = to;
  return {
    id, type: 'arrow', x: x1, y: y1, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, roundness: { type: 2 }, seed, version: 1, versionNonce: seed + 1,
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
    points: [[0, 0], [x2 - x1, y2 - y1]], lastCommittedPoint: null,
    startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', elbowed: false,
  };
}

function note(id, x, y, text, seed, width = 520) {
  return {
    id, type: 'text', x, y, width, height: 60, angle: 0,
    strokeColor: '#6b6b6b', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, roundness: null, seed, version: 1, versionNonce: seed + 1,
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
    text, originalText: text, fontSize: 14, fontFamily: 1, textAlign: 'left', verticalAlign: 'top',
    containerId: null, lineHeight: 1.25, baseline: 15, autoResize: true,
  };
}

const scene = (elements) => ({ elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null } });

export function generate() {
  const draws = [];

  draws.push({
    id: 'draw-ps3-telemetry', tier: 'client', title: 'PS3 telemetry after the changeover', icon: '🗺️',
    tags: ['pumphouse', 'architecture'], offset: -21,
    scene: scene([
      ...box('a-field', 40, 160, 190, 80, 'Field instruments\nLT-101, FT-201, PT-301', 101),
      ...box('a-rtu', 320, 160, 170, 80, 'New RTU\n(PS3 kiosk)', 201),
      ...box('a-radio', 580, 160, 170, 80, 'Radio link\n(mast extended)', 301),
      ...box('a-scada', 840, 160, 210, 80, 'SCADA head-end\n(Meridian control room)', 401),
      ...box('a-gen', 320, 320, 170, 70, 'Standby generator\nGEN.RUN', 501),
      ...box('a-old', 40, 20, 190, 60, 'Old RTU\n(parked until H3)', 601, '#9a2c04'),
      arrow('a-1', [230, 200], [320, 200], 701),
      arrow('a-2', [490, 200], [580, 200], 801),
      arrow('a-3', [750, 200], [840, 200], 901),
      arrow('a-4', [405, 320], [405, 240], 1001),
      note('a-n', 40, 430, 'Rev B: loop checks run level, then flow, then pressure. The delivery valve XV-401 holds its last position on loss of comms (TQ-004).', 1101, 640),
    ]),
  });

  draws.push({
    id: 'draw-standby-option-b', tier: 'team', title: 'Standby scheme, option B (solar and battery)', icon: '🔋',
    tags: ['island', 'scheme'], offset: -17,
    scene: scene([
      ...box('b-grid', 40, 40, 180, 70, 'Grid supply', 101),
      ...box('b-ats', 320, 140, 200, 80, 'Transfer switch\n(ATS)', 201),
      ...box('b-board', 620, 140, 190, 80, 'PS3 main board', 301),
      ...box('b-pumps', 900, 140, 190, 80, 'P-101 duty\nP-102 standby', 401),
      ...box('b-pv', 40, 300, 180, 70, 'Solar canopy\n60 kWp', 501),
      ...box('b-inv', 320, 300, 200, 70, 'Inverter', 601),
      ...box('b-bat', 320, 440, 200, 80, 'Battery\n350 kWh (LFP)', 701),
      ...box('b-gen', 620, 300, 190, 70, 'Diesel generator\n(retired)', 801, '#9a2c04'),
      arrow('b-1', [220, 75], [320, 165], 901),
      arrow('b-2', [520, 180], [620, 180], 1001),
      arrow('b-3', [810, 180], [900, 180], 1101),
      arrow('b-4', [220, 335], [320, 335], 1201),
      arrow('b-5', [420, 440], [420, 370], 1301),
      arrow('b-6', [420, 300], [420, 220], 1401),
      note('b-n', 620, 420, 'One pump through a four-hour outage needs 260 kWh delivered. 350 kWh nameplate gives 4.6 h at night (Battery autonomy formula).', 1501, 460),
    ]),
  });

  draws.push({
    id: 'draw-loop-order', tier: 'private', title: 'Loop check order, rev B', icon: '🧭',
    tags: ['pumphouse', 'loop-check'], offset: -22,
    scene: scene([
      ...box('c-1', 40, 120, 160, 70, '1. Level\nLT-101', 101),
      ...box('c-2', 260, 120, 160, 70, '2. Flow\nFT-201', 201),
      ...box('c-3', 480, 120, 160, 70, '3. Pressure\nPT-301', 301),
      ...box('c-4', 700, 120, 180, 70, '4. Valve fail-safe\nXV-401', 401),
      ...box('c-5', 940, 120, 160, 70, 'Hold point H3\nhandover', 501),
      arrow('c-a', [200, 155], [260, 155], 601),
      arrow('c-b', [420, 155], [480, 155], 701),
      arrow('c-c', [640, 155], [700, 155], 801),
      arrow('c-d', [880, 155], [940, 155], 901),
      note('c-n', 40, 240, 'Why this order: never run a pump on a level signal nobody has proven. Lena caught it in rev A, where pressure came first.', 1001, 640),
    ]),
  });

  draws.push({
    id: 'draw-reading-path', tier: 'public', title: 'How a reading reaches the control room', icon: '📡',
    tags: ['telemetry', 'explainer'], offset: -86,
    scene: scene([
      ...box('d-1', 40, 100, 160, 80, 'Sensor\n(4 to 20 mA)', 101),
      ...box('d-2', 260, 100, 160, 80, 'RTU\nscales and logs', 201),
      ...box('d-3', 480, 100, 160, 80, 'Radio\nevery 10 s', 301),
      ...box('d-4', 700, 100, 160, 80, 'SCADA\nalarms, trends', 401),
      ...box('d-5', 920, 100, 160, 80, 'Operator\ndecides', 501),
      arrow('d-a', [200, 140], [260, 140], 601),
      arrow('d-b', [420, 140], [480, 140], 701),
      arrow('d-c', [640, 140], [700, 140], 801),
      arrow('d-d', [860, 140], [920, 140], 901),
      note('d-n', 40, 220, 'A loop check proves each arrow: inject a known value at the sensor end and read the same value on the operator screen.', 1001, 640),
    ]),
  });

  return { draws };
}
