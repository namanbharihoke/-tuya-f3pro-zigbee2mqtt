'use strict';

/**
 * ===============================================================================
 * TUYA F3 PRO TOUCHPANEL ZIGBEE2MQTT CONVERTER - COMMUNITY VERSION
 * ===============================================================================
 *
 * Model: Tuya F3 PRO Touch Panel (_TZE284_idn2htgu)
 * Status: FULLY WORKING for Home Assistant automation integration
 *
 * ✅ WHAT WORKS (100% functional):
 * - All 4 relay switches (L1-L4) with LED indicators
 * - All 4 dimmer groups (G1-G4) with brightness and color temperature control
 * - 2 curtain controllers with position and state control
 * - 8 scene buttons with action detection
 * - Backlight control
 * - ALL 20+ text fields for custom naming (L1-L4, G1-G4, scenes, curtains)
 *   * Perfect Z2M entity updates and Home Assistant automation integration
 *   * Two-way synchronization between panel and Z2M
 *   * Multiple field name formats supported (l1_name, switch_1_name, etc.)
 *
 * ⚠️  KNOWN LIMITATION:
 * - Text fields show rectangles on physical panel display (firmware font limitation)
 * - Text data is transmitted correctly and Z2M integration is perfect
 * - This is acceptable for Home Assistant automation purposes
 *
 * 🔧 CUSTOMIZATION FOR OTHER MANUFACTURERS:
 * Change line 45 fingerprint to match your device:
 * fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE284_YOUR_MANUFACTURER_ID'}]
 *
 * 📝 DPID MAPPING (verified through extensive testing):
 * - L1-L4 switches: 121-124 (control), 137-140 (names)
 * - G1-G4 dimmers: 102,103,105,107 (brightness), 109-112 (color temp), 125-128 (names)
 * - Curtains: 113-114 (position), 133-134 (state), 129-132 (names)
 * - Scenes: 1-8 (actions), 141,32,143-148 (names) *Note: Scene 2 uses DPID 32, not 142
 * - LEDs: 117-120, Backlight: 149
 *
 * 🧪 TESTED ENCODING APPROACHES (10 methods tested):
 * ✅ UTF-16LE (current): Perfect Z2M integration, rectangles on panel
 * ❌ ASCII, UTF-8, hex variants: Chinese characters or blank display
 * ❌ Tuya STRING datatype: Integration conflicts
 *
 * 📚 COMMUNITY CONTRIBUTION:
 * This converter represents months of reverse engineering, packet capture analysis,
 * and systematic testing. Feel free to adapt for similar Tuya touchpanels.
 *
 * 🔗 INSTALLATION:
 * 1. Save as external converter in Zigbee2MQTT
 * 2. Add to configuration.yaml external_converters list
 * 3. Restart Zigbee2MQTT
 * 4. Re-interview your touchpanel device
 *
 * ===============================================================================
 */

const exposes = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const tuya = require('zigbee-herdsman-converters/lib/tuya');

const e = exposes.presets;
const ea = exposes.access;

// ===============================================================================
// EMBEDDED SHARED LOGIC (previously external dependencies)
// ===============================================================================

/** UTF-16LE encoding for text fields - WORKING METHOD */
function encodeUtf16leFixed16(str) {
  const s = String(str ?? '').slice(0, 8);
  const buf = Buffer.alloc(16, 0x00);
  for (let i = 0; i < s.length && (i * 2 + 1) < 16; i++) {
    const code = s.charCodeAt(i);
    buf[i * 2] = code & 0xFF;
    buf[i * 2 + 1] = (code >> 8) & 0xFF;
  }
  return buf;
}

/** Decode text fields from panel responses */
function decodeTuyaText(payload) {
  if (typeof payload === 'string') {
    return payload.slice(0, 8);
  }
  const b = Buffer.from(payload ?? []);
  let out = '';
  for (let i = 0; i + 1 < b.length && i < 16; i += 2) {
    const code = b[i] | (b[i + 1] << 8);
    if (code === 0x0000) break;
    out += String.fromCharCode(code);
  }
  return out;
}

function scaleNumber(v, inMin, inMax, outMin, outMax) {
  return Math.round(((Number(v) - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin);
}

/** Brightness % (1..100) <-> Tuya 1..102 with LED gating */
function dimmerPct(gateKey) {
  return {
    from: (v) => scaleNumber(v, 1, 102, 1, 100),
    to: (v, meta) => {
      const gate = (meta?.state?.[gateKey]) ?? 'ON';
      if (gate !== 'ON') return undefined;
      return scaleNumber(v, 1, 100, 1, 102);
    },
  };
}

/** Color temp % (0..100) passthrough with LED gating */
function dimmerConverter(gateKey) {
  return {
    from: (v) => Number(v),
    to: (v, meta) => {
      const gate = (meta?.state?.[gateKey]) ?? 'ON';
      if (gate !== 'ON') return undefined;
      return Number(v);
    },
  };
}

/** Curtain position scaler with auto 0–100 vs 0–1000 detection */
function makeCurtainScaler() {
  const st = { scale: 100, invert: false };
  return {
    from: (v) => {
      const raw = Number(v);
      st.scale = raw > 100 ? 1000 : 100;
      let pct = st.scale === 1000 ? Math.round(raw / 10) : raw;
      pct = Math.max(0, Math.min(100, pct));
      if (st.invert) pct = 100 - pct;
      return pct;
    },
    to: (v) => {
      let pct = Math.max(0, Math.min(100, Number(v)));
      if (st.invert) pct = 100 - pct;
      return st.scale === 1000 ? pct * 10 : pct;
    },
    st,
  };
}

/** LED anti-fight lock (per device, per index) */
const LOCK_MS = 1200;
const ledLock = new WeakMap();
function _getLock(dev) {
  let s = ledLock.get(dev);
  if (!s) { s = { desired: {}, until: {} }; ledLock.set(dev, s); }
  return s;
}
function lockLed(dev, idx, val) {
  const s = _getLock(dev);
  s.desired[idx] = val;
  s.until[idx] = Date.now() + LOCK_MS;
}
function isLockedAgainst(dev, idx, incomingVal) {
  const s = _getLock(dev);
  const until = s.until[idx] || 0;
  if (Date.now() > until) return false;
  const desired = s.desired[idx];
  return desired && desired !== incomingVal;
}

/** Recent-write squelch */
const WRITE_SQUELCH_MS = 2500;
const recentWrite = new WeakMap();

function noteWrite(dev, dpId, val) {
  let m = recentWrite.get(dev);
  if (!m) { m = new Map(); recentWrite.set(dev, m); }
  m.set(dpId, { val, until: Date.now() + WRITE_SQUELCH_MS });
}
function isRecentWrite(dev, dpId, val) {
  const m = recentWrite.get(dev);
  if (!m) return false;
  const rec = m.get(dpId);
  if (!rec) return false;
  if (Date.now() > rec.until) return false;
  return rec.val === val;
}

/** UI quiet window: suppress noisy echoes after backlight/name/screen bursts */
const UI_QUIET_DEFAULT_MS = 5000;
const uiQuiet = new WeakMap();
function beginUiQuiet(dev, ms = UI_QUIET_DEFAULT_MS) {
  const until = Date.now() + ms;
  const prev = uiQuiet.get(dev) || 0;
  uiQuiet.set(dev, Math.max(prev, until));
}
function inUiQuiet(dev) {
  const until = uiQuiet.get(dev) || 0;
  return Date.now() < until;
}

// ===============================================================================
// DPID MAPPINGS - VERIFIED THROUGH PACKET CAPTURE AND TESTING
// ===============================================================================

// Text field name DPIDs - Multiple field name formats supported
const DPID_L_NAME = {
  l1_name: 137, l2_name: 138, l3_name: 139, l4_name: 140,  // Short names
  switch_1_name: 137, switch_2_name: 138, switch_3_name: 139, switch_4_name: 140  // Tuya API names
};
const DPID_G_NAME = {
  g1_name: 125, g2_name: 126, g3_name: 127, g4_name: 128,  // Short names
  light_switch_name_1: 125, light_switch_name_2: 126, light_switch_name_3: 127, light_switch_name_4: 128  // Tuya API names
};
const DPID_C_NAME = {
  curtain1_name: 129, curtain2_name: 130, curtain3_name: 131, curtain4_name: 132,  // Short names
  curtain_switch_name_1: 129, curtain_switch_name_2: 130, curtain_switch_name_3: 131, curtain_switch_name_4: 132  // Tuya API names
};
const DPID_S_NAME = {
  scene1_name: 141, scene2_name: 32, scene3_name: 143, scene4_name: 144,  // Short names - NOTE: Scene 2 is DPID 32!
  scene5_name: 145, scene6_name: 146, scene7_name: 147, scene8_name: 148,
  scene_1_name: 141, scene_2_name: 32, scene_3_name: 143, scene_4_name: 144,  // Tuya API names
  scene_5_name: 145, scene_6_name: 146, scene_7_name: 147, scene_8_name: 148,
};
const NAME_DPIDS = {...DPID_L_NAME, ...DPID_G_NAME, ...DPID_C_NAME, ...DPID_S_NAME};

// All control DPIDs for write-squelch tracking
const DPID_MAP = {
  state_l1:121, state_l2:122, state_l3:123, state_l4:124,
  brightness_g1:102, brightness_g2:103, brightness_g3:105, brightness_g4:107,
  color_temp_g1:109, color_temp_g2:110, color_temp_g3:111, color_temp_g4:112,
  backlight_switch:149,
  led_switch1:117, led_switch2:118, led_switch3:119, led_switch4:120,
  curtain_1_position:113, curtain_2_position:114,
  curtain_1_state:133, curtain_2_state:134,
  ...NAME_DPIDS,
};

// ===============================================================================
// CURTAIN CONTROL LOGIC
// ===============================================================================

const c1 = makeCurtainScaler();
const c2 = makeCurtainScaler();
const ocMap = { c1: {invert: true}, c2: {invert: true} };
const ocTarget = (isOpen, which) => (ocMap[which]?.invert ? (isOpen ? 0 : 100) : (isOpen ? 100 : 0));
const curtainStateFrom = (v) => (v===0||v==='0'||v==='open') ? 'OPEN' : (v===2||v==='2'||v==='close') ? 'CLOSED' : 'STOPPED';

// ===============================================================================
// UI QUIET AND NOISE FILTERING
// ===============================================================================

// Triggers that start UI quiet period
const QUIET_TRIGGER_IDS = new Set([149, 102,103,105,107, 109,110,111,112, 121,122,123,124]);

// Keys to filter out from responses (reduce noise)
const noisyKeys = new Set([
  'group_status','relay_status','state',
  'switch_1_name','switch_2_name','switch_3_name','switch_4_name',
  'light_switch_name_1','light_switch_name_2','light_switch_name_3','light_switch_name_4',
  'curtain_switch_name_1','name_encoding','name_pack','name_terminator',
  'scene_1_name','scene_2_name','scene_3_name','scene_4_name','scene_5_name',
]);

function dropUnknownCurtains(obj) {
  for (const k of Object.keys(obj)) {
    if (k.startsWith('curtain_3_') || k.startsWith('curtain_4_')) delete obj[k];
  }
}

// ===============================================================================
// FROMZIGBEE CONVERTER - HANDLES INCOMING DATA FROM PANEL
// ===============================================================================

const fzLocalDatapoints = {
  ...tuya.fz.datapoints,
  convert: (model, msg, publish, options, meta) => {
    const res0 = tuya.fz.datapoints.convert(model, msg, publish, options, meta) || {};
    const res = {...res0};

    // DP 149 is emitted by the panel's radar wake/idle handlers. Preserve the
    // existing backlight_switch property for backwards-compatible control,
    // while also publishing the incoming state as read-only occupancy.
    //
    // ON/1  = radar wake-up / presence
    // OFF/0 = radar idle / no presence
    if (Object.prototype.hasOwnProperty.call(res, 'backlight_switch')) {
      res.occupancy = res.backlight_switch === 'ON';
    }

    // Convert scene actions to standard action format
    for (let i = 1; i <= 8; i++) {
      const k = `action_scene_${i}`;
      if (Object.prototype.hasOwnProperty.call(res, k)) { res.action = `scene_${i}`; break; }
    }

    // Filter out noise and unused features
    for (const k of noisyKeys) { if (k in res) delete res[k]; }
    dropUnknownCurtains(res);

    // Process individual datapoints for special handling
    const dps = msg.data?.dpValues || msg.dpValues || msg.dataPoints || [];
    if (Array.isArray(dps)) {
      const reverse = new Map(Object.entries(NAME_DPIDS).map(([k, v]) => [v, k]));
      for (const dp of dps) {
        const id = dp.dp ?? dp.datapoint ?? dp.dpId ?? dp.id;
        const rawVal = dp.data ?? dp.value ?? dp.dpValue;

        // Start UI quiet period for backlight, dimmers, switches, or text fields
        if (QUIET_TRIGGER_IDS.has(id) || reverse.has(id)) beginUiQuiet(meta.device);

        // Decode text field names using UTF-16LE
        if (reverse.has(id)) {
          const key = reverse.get(id);
          res[key] = decodeTuyaText(rawVal ?? '');
        }

        // Suppress recently written values to prevent echo loops
        const nVal = typeof rawVal === 'number' ? rawVal : (Number(rawVal) || rawVal);
        if (isRecentWrite(meta.device, id, nVal)) {
          for (const [k, dpId] of Object.entries(DPID_MAP)) {
            if (dpId === id && k in res) delete res[k];
          }
        }
      }
    }

    // IMPORTANT: Allow brightness/color temp data during UI quiet
    // Previous versions blocked this, causing automation failures
    // Keeping this section for reference but disabled

    // LED anti-fight protection
    for (let idx = 1; idx <= 4; idx++) {
      const k = `led_switch${idx}`;
      if (Object.prototype.hasOwnProperty.call(res, k)) {
        if (isLockedAgainst(meta.device, idx, res[k])) delete res[k];
      }
    }

    // Skip unchanged values to reduce MQTT traffic
    if (meta && meta.state) {
      for (const k of Object.keys(res)) {
        if (Object.prototype.hasOwnProperty.call(meta.state, k) && meta.state[k] === res[k]) {
          delete res[k];
        }
      }
    }

    return Object.keys(res).length ? res : undefined;
  },
};

// ===============================================================================
// TOZIGBEE CONVERTERS - HANDLE OUTGOING COMMANDS TO PANEL
// ===============================================================================

const tzLocal = {
  // Main converter for all panel controls
  filtered: {
    key: [
      'state_l1','state_l2','state_l3','state_l4',
      'brightness_g1','brightness_g2','brightness_g3','brightness_g4',
      'color_temp_g1','color_temp_g2','color_temp_g3','color_temp_g4',
      'backlight_switch','led_switch1','led_switch2','led_switch3','led_switch4',
      'curtain_1_position','curtain_2_position','curtain_1_state','curtain_2_state',
      ...Object.keys(NAME_DPIDS),
    ],
    convertSet: async (entity, key, value, meta) => {
      if (meta && meta.message && Object.prototype.hasOwnProperty.call(meta.message, 'state')) {
        delete meta.message.state;
      }

      // TEXT FIELD HANDLING - UTF-16LE encoding (WORKING METHOD)
      if (NAME_DPIDS[key] != null) {
        const next = String(value).slice(0, 8); // Max 8 characters
        if (meta.state?.[key] === next) return {state: {[key]: next}};

        // Encode text using UTF-16LE format - proven to work with Z2M integration
        const buf = encodeUtf16leFixed16(next);
        await tuya.sendDataPointRaw(entity, NAME_DPIDS[key], buf);
        noteWrite(meta.device, NAME_DPIDS[key], buf.toString('hex'));
        beginUiQuiet(meta.device);
        return {state: {[key]: next}};
      }

      // LED switch handling with anti-fight lock
      if (key.startsWith('led_switch')) {
        const idx = Number(key.slice(-1));
        const v = (String(value).toUpperCase() === 'ON') ? 'ON' : 'OFF';
        lockLed(meta.device, idx, v);
      }

      // Track recent writes for echo suppression
      const dpId = DPID_MAP[key];
      let recVal = value;
      if (typeof recVal !== 'number') {
        const n = Number(recVal);
        recVal = Number.isNaN(n) ? recVal : n;
      }
      if (dpId != null) noteWrite(meta.device, dpId, recVal);

      // Use standard Tuya datapoint converter for non-text fields
      return tuya.tz.datapoints.convertSet(entity, key, value, meta);
    },
  },

  // Special curtain state control via position
  curtain_state_via_position: {
    key: ['curtain_1_state', 'curtain_2_state'],
    convertSet: async (entity, key, value, meta) => {
      const isC1 = key === 'curtain_1_state';
      const posDp = isC1 ? 113 : 114;
      const stateDp = isC1 ? 133 : 134;
      const which = isC1 ? 'c1' : 'c2';
      const val = String(value).toUpperCase();

      if (val === 'OPEN') {
        const tgt = ocTarget(true, which);
        await tuya.sendDataPointValue(entity, posDp, tgt);
        noteWrite(meta.device, posDp, tgt);
      } else if (val === 'CLOSED' || val === 'CLOSE') {
        const tgt = ocTarget(false, which);
        await tuya.sendDataPointValue(entity, posDp, tgt);
        noteWrite(meta.device, posDp, tgt);
      } else {
        await tuya.sendDataPointEnum(entity, stateDp, 1); // STOP
        noteWrite(meta.device, stateDp, 1);
      }
      return {state: {[key]: (val === 'CLOSE') ? 'CLOSED' : val}};
    },
  },
};

// ===============================================================================
// MAIN CONVERTER DEFINITION
// ===============================================================================

const definition = {
  // IMPORTANT: Update this fingerprint to match your specific device manufacturer(s)
  // Multiple manufacturer IDs confirmed for identical F3 PRO panels:
  fingerprint: [
    {modelID: 'TS0601', manufacturerName: '_TZE284_idn2htgu'},  // Primary manufacturer ID
    // ADD YOUR MANUFACTURER ID HERE if different:
    // {modelID: 'TS0601', manufacturerName: '_TZE284_your_id_here'},
  ],
  model: 'F3PRO_TouchPanel',
  vendor: 'Tuya',
  description: 'F3 PRO Touchpanel with full text field support, curtain control, and dimmer management',

  fromZigbee: [fzLocalDatapoints],
  toZigbee: [tzLocal.curtain_state_via_position, tzLocal.filtered],

  // Event handler to manage UI quiet periods
  onEvent: async (type, data, device) => {
    try {
      if (type !== 'message' || !data) return;
      const dps = data.data?.dpValues || data.dpValues || data.dataPoints || [];
      if (!Array.isArray(dps) || dps.length === 0) return;
      for (const dp of dps) {
        const id = dp.dp ?? dp.datapoint ?? dp.dpId ?? dp.id;
        if (id === 149 || QUIET_TRIGGER_IDS.has(id)) beginUiQuiet(device);
      }
    } catch (_) {}
  },

  // Complete expose definition for Home Assistant integration
  exposes: [
    // Relay switches L1-L4
    exposes.binary('state_l1', ea.STATE_SET, 'ON', 'OFF').withDescription('L1 relay switch'),
    exposes.binary('state_l2', ea.STATE_SET, 'ON', 'OFF').withDescription('L2 relay switch'),
    exposes.binary('state_l3', ea.STATE_SET, 'ON', 'OFF').withDescription('L3 relay switch'),
    exposes.binary('state_l4', ea.STATE_SET, 'ON', 'OFF').withDescription('L4 relay switch'),

    // Scene actions
    e.action(['scene_1','scene_2','scene_3','scene_4','scene_5','scene_6','scene_7','scene_8']).withDescription('Scene button pressed'),

    // Dimmer groups G1-G4 with brightness and color temperature
    e.numeric('brightness_g1', ea.STATE_SET).withUnit('%').withValueMin(1).withValueMax(100).withDescription('G1 brightness'),
    e.numeric('color_temp_g1', ea.STATE_SET).withUnit('%').withValueMin(0).withValueMax(100).withDescription('G1 color temperature'),
    e.numeric('brightness_g2', ea.STATE_SET).withUnit('%').withValueMin(1).withValueMax(100).withDescription('G2 brightness'),
    e.numeric('color_temp_g2', ea.STATE_SET).withUnit('%').withValueMin(0).withValueMax(100).withDescription('G2 color temperature'),
    e.numeric('brightness_g3', ea.STATE_SET).withUnit('%').withValueMin(1).withValueMax(100).withDescription('G3 brightness'),
    e.numeric('color_temp_g3', ea.STATE_SET).withUnit('%').withValueMin(0).withValueMax(100).withDescription('G3 color temperature'),
    e.numeric('brightness_g4', ea.STATE_SET).withUnit('%').withValueMin(1).withValueMax(100).withDescription('G4 brightness'),
    e.numeric('color_temp_g4', ea.STATE_SET).withUnit('%').withValueMin(0).withValueMax(100).withDescription('G4 color temperature'),

    // Curtain controls
    e.numeric('curtain_1_position', ea.STATE_SET).withValueMin(0).withValueMax(100).withDescription('Curtain 1 position %'),
    e.enum('curtain_1_state', ea.STATE_SET, ['OPEN','STOPPED','CLOSED']).withDescription('Curtain 1 state control'),
    e.numeric('curtain_2_position', ea.STATE_SET).withValueMin(0).withValueMax(100).withDescription('Curtain 2 position %'),
    e.enum('curtain_2_state', ea.STATE_SET, ['OPEN','STOPPED','CLOSED']).withDescription('Curtain 2 state control'),

    // Radar presence (read only). DP 149 is shared with the panel backlight
    // state, so this represents radar-active/display-awake until its idle timer.
    e.occupancy().withDescription('Radar activity derived from DP 149; clears when the panel enters radar idle'),

    // Panel controls
    exposes.binary('backlight_switch', ea.STATE_SET, 'ON', 'OFF').withDescription('Panel backlight'),
    exposes.binary('led_switch1', ea.STATE_SET, 'ON', 'OFF').withDescription('LED switch 1'),
    exposes.binary('led_switch2', ea.STATE_SET, 'ON', 'OFF').withDescription('LED switch 2'),
    exposes.binary('led_switch3', ea.STATE_SET, 'ON', 'OFF').withDescription('LED switch 3'),
    exposes.binary('led_switch4', ea.STATE_SET, 'ON', 'OFF').withDescription('LED switch 4'),

    // TEXT FIELDS - WORKING for Z2M/Home Assistant integration (rectangles on panel display)
    // Short name format
    exposes.text('l1_name', ea.STATE_SET).withDescription('L1 switch custom name'),
    exposes.text('l2_name', ea.STATE_SET).withDescription('L2 switch custom name'),
    exposes.text('l3_name', ea.STATE_SET).withDescription('L3 switch custom name'),
    exposes.text('l4_name', ea.STATE_SET).withDescription('L4 switch custom name'),
    exposes.text('g1_name', ea.STATE_SET).withDescription('G1 dimmer custom name'),
    exposes.text('g2_name', ea.STATE_SET).withDescription('G2 dimmer custom name'),
    exposes.text('g3_name', ea.STATE_SET).withDescription('G3 dimmer custom name'),
    exposes.text('g4_name', ea.STATE_SET).withDescription('G4 dimmer custom name'),
    exposes.text('curtain1_name', ea.STATE_SET).withDescription('Curtain 1 custom name'),
    exposes.text('curtain2_name', ea.STATE_SET).withDescription('Curtain 2 custom name'),
    exposes.text('curtain3_name', ea.STATE_SET).withDescription('Curtain 3 custom name'),
    exposes.text('curtain4_name', ea.STATE_SET).withDescription('Curtain 4 custom name'),
    exposes.text('scene1_name', ea.STATE_SET).withDescription('Scene 1 custom name'),
    exposes.text('scene2_name', ea.STATE_SET).withDescription('Scene 2 custom name'),
    exposes.text('scene3_name', ea.STATE_SET).withDescription('Scene 3 custom name'),
    exposes.text('scene4_name', ea.STATE_SET).withDescription('Scene 4 custom name'),
    exposes.text('scene5_name', ea.STATE_SET).withDescription('Scene 5 custom name'),
    exposes.text('scene6_name', ea.STATE_SET).withDescription('Scene 6 custom name'),
    exposes.text('scene7_name', ea.STATE_SET).withDescription('Scene 7 custom name'),
    exposes.text('scene8_name', ea.STATE_SET).withDescription('Scene 8 custom name'),

    // Tuya API compatible name format (same functionality, different field names)
    exposes.text('switch_1_name', ea.STATE_SET).withDescription('Switch 1 name (Tuya API format)'),
    exposes.text('switch_2_name', ea.STATE_SET).withDescription('Switch 2 name (Tuya API format)'),
    exposes.text('switch_3_name', ea.STATE_SET).withDescription('Switch 3 name (Tuya API format)'),
    exposes.text('switch_4_name', ea.STATE_SET).withDescription('Switch 4 name (Tuya API format)'),
    exposes.text('light_switch_name_1', ea.STATE_SET).withDescription('Light switch 1 name (Tuya API format)'),
    exposes.text('light_switch_name_2', ea.STATE_SET).withDescription('Light switch 2 name (Tuya API format)'),
    exposes.text('light_switch_name_3', ea.STATE_SET).withDescription('Light switch 3 name (Tuya API format)'),
    exposes.text('light_switch_name_4', ea.STATE_SET).withDescription('Light switch 4 name (Tuya API format)'),
    exposes.text('scene_1_name', ea.STATE_SET).withDescription('Scene 1 name (Tuya API format)'),
    exposes.text('scene_2_name', ea.STATE_SET).withDescription('Scene 2 name (Tuya API format)'),
    exposes.text('scene_3_name', ea.STATE_SET).withDescription('Scene 3 name (Tuya API format)'),
    exposes.text('scene_4_name', ea.STATE_SET).withDescription('Scene 4 name (Tuya API format)'),
    exposes.text('scene_5_name', ea.STATE_SET).withDescription('Scene 5 name (Tuya API format)'),
    exposes.text('scene_6_name', ea.STATE_SET).withDescription('Scene 6 name (Tuya API format)'),
    exposes.text('scene_7_name', ea.STATE_SET).withDescription('Scene 7 name (Tuya API format)'),
    exposes.text('scene_8_name', ea.STATE_SET).withDescription('Scene 8 name (Tuya API format)'),
  ],

  meta: {
    multiEndpoint: true,
    disableDefaultResponse: true,
    publishDuplicateTransaction: false,
    tuyaDatapoints: [
      // Relay switches
      [121,'state_l1',tuya.valueConverter.onOff],
      [122,'state_l2',tuya.valueConverter.onOff],
      [123,'state_l3',tuya.valueConverter.onOff],
      [124,'state_l4',tuya.valueConverter.onOff],

      // Scene actions
      [1,'action_scene_1',tuya.valueConverter.raw],
      [2,'action_scene_2',tuya.valueConverter.raw],
      [3,'action_scene_3',tuya.valueConverter.raw],
      [4,'action_scene_4',tuya.valueConverter.raw],
      [5,'action_scene_5',tuya.valueConverter.raw],
      [6,'action_scene_6',tuya.valueConverter.raw],
      [7,'action_scene_7',tuya.valueConverter.raw],
      [8,'action_scene_8',tuya.valueConverter.raw],

      // Dimmer groups with LED gating
      [102,'brightness_g1',dimmerPct('led_switch1')],
      [103,'brightness_g2',dimmerPct('led_switch2')],
      [105,'brightness_g3',dimmerPct('led_switch3')],
      [107,'brightness_g4',dimmerPct('led_switch4')],
      [109,'color_temp_g1',dimmerConverter('led_switch1')],
      [110,'color_temp_g2',dimmerConverter('led_switch2')],
      [111,'color_temp_g3',dimmerConverter('led_switch3')],
      [112,'color_temp_g4',dimmerConverter('led_switch4')],

      // Curtain controls
      [113,'curtain_1_position',{from:c1.from,to:c1.to}],
      [114,'curtain_2_position',{from:c2.from,to:c2.to}],
      [133,'curtain_1_state',{from:curtainStateFrom,to:(v)=>v}],
      [134,'curtain_2_state',{from:curtainStateFrom,to:(v)=>v}],

      // Panel controls
      [149,'backlight_switch',tuya.valueConverter.onOff],
      [117,'led_switch1',tuya.valueConverter.onOff],
      [118,'led_switch2',tuya.valueConverter.onOff],
      [119,'led_switch3',tuya.valueConverter.onOff],
      [120,'led_switch4',tuya.valueConverter.onOff],

      // Text fields - selective tuyaDatapoints to avoid conflicts with custom handler
      // Only include non-conflicting DPIDs for fromZigbee reading
      [137,'l1_name',tuya.valueConverter.raw],
      [139,'l3_name',tuya.valueConverter.raw],
      [140,'l4_name',tuya.valueConverter.raw],
      [125,'g1_name',tuya.valueConverter.raw],
      [127,'g3_name',tuya.valueConverter.raw],
      [128,'g4_name',tuya.valueConverter.raw],
      [129,'curtain1_name',tuya.valueConverter.raw],
      [130,'curtain2_name',tuya.valueConverter.raw],
      [131,'curtain3_name',tuya.valueConverter.raw],
      [132,'curtain4_name',tuya.valueConverter.raw],
      [143,'scene3_name',tuya.valueConverter.raw],
      [144,'scene4_name',tuya.valueConverter.raw],
      [145,'scene5_name',tuya.valueConverter.raw],
      [146,'scene6_name',tuya.valueConverter.raw],
      [147,'scene7_name',tuya.valueConverter.raw],
      [148,'scene8_name',tuya.valueConverter.raw],
      // Note: Some DPIDs commented out to prevent conflicts with custom toZigbee handler
      // All text fields still work through the custom converter
    ],
  },

  configure: async (device, coordinatorEndpoint) => {
    const ep = device.getEndpoint(1);
    await reporting.bind(ep, coordinatorEndpoint, ['genBasic','genGroups','genScenes']);
  },
};

module.exports = definition;
