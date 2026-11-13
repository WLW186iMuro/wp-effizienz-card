/* WP Effizienz-Rechner – Buderus WLW186i mit 7-kW-Außeneinheit
 * Außeneinheit WLW-7 MB AR (WLW186i-7 AR), Inneneinheit WLW186i-12 TP70. Kennwerte aus der Buderus-Planungsunterlage 2024/04.
 * Regler verschieben, Anlagenschema und COP rechnen live mit. Der Rechenkern ist ein Port des Simulators von
 * Matthias Röckl (https://bosch-buderus-wp.github.io/, MIT-Lizenz, Copyright (c) 2026 Matthias Röckl; siehe NOTICE.md),
 * ergänzt um die Wärmeabgabe der Fußbodenheizung (Deckung der Heizlast) und das Takten unter der Mindestleistung.
 * Nutzung:   type: custom:wp-simulator-card
 * Optional:  title, storage_key, defaults: { ... }, entities: { ... }, controls: { <regler>: { min, max, step } },
 *            shift: { room: 1.5, offset: 1.3, ref: 21 }   (Parallelverschiebung der Heizkurve in K Vorlauf je K)
 *            heizgrenze: legacy   (altes Verhalten bis 3.3.0: eine Heizgrenze für Gebäude und WP)
 */
const WPS_VERSION = "3.5.3";
/* Stand der gespeicherten Reglerwerte. Nur erhöhen, wenn die Karte die Anlagenwerte neu aus EMS-ESP laden soll. */
const WPS_STORE_V = "3.2.1";

/* ===== Rechenkern (Port des Bosch/Buderus-WP-Simulators, bosch-buderus-wp.github.io/simulator) ===== */
const WPS_PROFILES = {
  /* Buderus Planungsunterlage WLW176i/186i AR (2024/04): Tabelle 8.3.1 und Bild 9 (Max./Min. Heizleistung W35) */
  "7 kW": { th: { "-20": [5.0, 2.0], "-15": [5.9, 2.2], "-10": [5.86, 2.23], "-7": [6.71, 2.36], "2": [7.09, 2.83, 2.87, 4.06],
                  "7": [7.97, 3.07, 2.84, 4.85, 7.45], "15": [9.9, 0], "20": [10.0, 0] },
            min: { "-20": 2.0, "-15": 1.3, "-10": 1.55, "-7": 1.75, "2": 1.85, "7": 1.65, "15": 2.0, "20": 2.2 },
            el: [300, 2510, 0.1195], cop: [0.56, 0.008, 0.015], as: 0.8 },
};
/* Parallelverschiebung der Heizkurve (an der Anlage gemessen, per Karten-Konfiguration shift: {...} anpassbar):
   RSHIFT = K Vorlauf je K Raumsoll, OSHIFT = K Vorlauf je K Temperaturanhebung, RREF = Bezugs-Raumsoll
   SPLIT = Heizgrenze Gebäude (Heizlastlinie) und Heizgrenze WP (Heizbetrieb aus) getrennt; false = altes Verhalten */
const WPS_C = { cp: 4180, CD: 0.9, TE: 7, TC: 4, SH: 10, OVERHEAD: 1.03, DP_REF: 150, LIFT_REF: 47.6, RSHIFT: 1.5, OSHIFT: 1.3, RREF: 21, PC0_SWITCH: 5, PC0_LEARN_LO: 4, PC0_LEARN_HI: 5, SPLIT: true };

const wpsClamp = (x, a, b) => Math.max(a, Math.min(b, x));
const wpsK = (c) => c + 273.15;

function wpsAnchors(model) {
  const th = (WPS_PROFILES[model] || WPS_PROFILES["7 kW"]).th;
  return Object.keys(th).map((k) => ({ Ta: +k, d: th[k] })).sort((a, b) => a.Ta - b.Ta);
}

function wpsCap35(Ta, model) {
  const p = wpsAnchors(model).map((a) => ({ Ta: a.Ta, kW: a.d[0] }));
  const n = p.length;
  if (Ta <= p[0].Ta) return Math.max(0, p[0].kW + ((p[1].kW - p[0].kW) / (p[1].Ta - p[0].Ta)) * (Ta - p[0].Ta));
  for (let i = 0; i < n - 1; i++) {
    if (Ta >= p[i].Ta && Ta <= p[i + 1].Ta) return p[i].kW + ((Ta - p[i].Ta) / (p[i + 1].Ta - p[i].Ta)) * (p[i + 1].kW - p[i].kW);
  }
  return Math.max(0, p[n - 1].kW + ((p[n - 1].kW - p[n - 2].kW) / (p[n - 1].Ta - p[n - 2].Ta)) * (Ta - p[n - 1].Ta));
}

/* Vorlaufsoll: Gerade zwischen (NAT | Auslegung) und (20 °C | Fußpunkt),
   parallel verschoben um RSHIFT × (Raumsoll − RREF) + OSHIFT × Temperaturanhebung, begrenzt auf Min. Vorlauf … 60 °C */
function wpsFlowTarget(Ta, p) {
  const t = (Ta - p.nat) / Math.max(1e-6, 20 - p.nat);
  const base = p.vlNat + t * (p.vl20 - p.vlNat);
  const shift = WPS_C.RSHIFT * ((p.rsoll ?? WPS_C.RREF) - WPS_C.RREF) + WPS_C.OSHIFT * (p.offs ?? 0);
  return wpsClamp(base + shift, Math.max(15, p.minflow ?? 15), 60);
}

/* Gebäudeheizlast nach DIN EN 12831, linear bis zur Heizgrenze des Gebäudes
   (im alten Verhalten: bis zur Heizgrenze der WP) */
function wpsLoadW(Ta, p) {
  const lim = WPS_C.SPLIT ? (p.limB ?? p.limit) : p.limit;
  return Math.max(0, p.loadKw) * 1000 * Math.max(0, (lim - Ta) / Math.max(1, lim - p.nat));
}
/* Heizbetrieb der WP aktiv? Ab der Heizgrenze der WP ist die Heizung aus. */
function wpsHeatOn(Ta, p) { return !WPS_C.SPLIT || Ta < p.limit; }

function wpsCOP(Tflow, Ta, model) {
  const Te = Ta - WPS_C.TE, Tc = Tflow + WPS_C.TC;
  const lift = wpsK(Tc) - wpsK(Te);
  const [eta, f, g = 0] = (WPS_PROFILES[model] || WPS_PROFILES["7 kW"]).cop;
  return eta * (1 + f * (WPS_C.LIFT_REF - lift)) * (1 + g * (Tflow - 35)) * (wpsK(Tc) / lift);
}

function wpsCapMax(Ta, Tflow, model) {
  const c35 = wpsCap35(Ta, model);
  const a7 = wpsCap35(7, model);
  const w55 = (WPS_PROFILES[model] || WPS_PROFILES["7 kW"]).th["7"][4];
  const k = w55 && a7 > 0 ? (1 - w55 / a7) / 20 : 0;
  return Math.max(0, c35 * (1 - k * (Tflow - 35)));
}

/* Mindestheizleistung (kleinste Verdichterdrehzahl) laut Bild 9, Kurve 1 */
function wpsCapMin(Ta, Tflow, model) {
  const mn = (WPS_PROFILES[model] || WPS_PROFILES["7 kW"]).min;
  const p = Object.keys(mn).map((k) => ({ Ta: +k, kW: mn[k] })).sort((a, b) => a.Ta - b.Ta);
  if (Ta <= p[0].Ta) return p[0].kW;
  if (Ta >= p[p.length - 1].Ta) return p[p.length - 1].kW;
  for (let i = 0; i < p.length - 1; i++) {
    if (Ta >= p[i].Ta && Ta <= p[i + 1].Ta) return p[i].kW + ((Ta - p[i].Ta) / (p[i + 1].Ta - p[i].Ta)) * (p[i + 1].kW - p[i].kW);
  }
  return p[p.length - 1].kW;
}

function wpsModCalib(Ta, model) {
  const an = [];
  for (const a of wpsAnchors(model)) {
    const d = a.d;
    if (d.length >= 4) {
      const mopt = d[2] / d[0];
      const r = d[3] / d[1];
      an.push({ Ta: a.Ta, mopt, alpha: Math.max(0, (r - 1) / ((1 - mopt) * (1 - mopt))) });
    }
  }
  const ip = (key) => {
    if (!an.length) return null;
    if (Ta <= an[0].Ta) return an[0][key];
    if (Ta >= an[an.length - 1].Ta) return an[an.length - 1][key];
    for (let i = 0; i < an.length - 1; i++) {
      if (Ta >= an[i].Ta && Ta <= an[i + 1].Ta) return an[i][key] + ((Ta - an[i].Ta) / (an[i + 1].Ta - an[i].Ta)) * (an[i + 1][key] - an[i][key]);
    }
    return an[an.length - 1][key];
  };
  const m = ip("mopt"), al = ip("alpha");
  return { mopt: m == null ? 0.5 : wpsClamp(m, 0.4, 0.7), alpha: al == null ? 1 : wpsClamp(al, 0.3, 2.5) };
}

/* PC0-Durchfluss (Heizen) aus der Pumpenmodulation – identisch mit dem Helfer „WP Primärkreis Durchfluss berechnet“
   (Stand 10.11.2026): unter 50 %: 610 + 6,2 × % (Gerade durch ca. 865 l/h bei 41 % und 921 l/h bei 50 %),
   ab 50 %: max(126 + 15,9 × %, −486 + 23,9 × %). Frühere Fassungen: 747 + 3,5 × %, dann 722 + 3,5 × %. */
const WPS_PC0_A = 610, WPS_PC0_B = 6.2;
function wpsPc0Flow(mod) {
  if (!(mod > 0)) return 0;
  return mod < 50 ? WPS_PC0_A + WPS_PC0_B * mod : Math.max(126 + 15.9 * mod, -486 + 23.9 * mod);
}
/* Umkehrung: Modulation zu einem Durchfluss (l/h) */
function wpsPc0Mod(flow) {
  if (!(flow > 0)) return 0;
  if (flow < wpsPc0Flow(50)) return wpsClamp((flow - WPS_PC0_A) / WPS_PC0_B, 0, 50);
  const a = (flow - 126) / 15.9, b = (flow + 486) / 23.9;
  return Math.min(a, b);
}

/* Gesamtzustand für eine Außentemperatur. p.pc0Live (l/h) ersetzt den gerechneten PC0-Durchfluss.
   PC1: p.flow150 ist der gemessene Durchfluss, umgerechnet auf 150 mbar; Durchfluss ~ Wurzel(Pumpensolldruck). */
function wpsCompute(p) {
  const Ta = p.ta, model = p.model, cp = WPS_C.cp;
  const mH = (p.flow150 / 3600) * Math.sqrt(Math.max(20, p.pressure) / WPS_C.DP_REF);
  const T0 = wpsFlowTarget(Ta, p);
  /* Gelieferte Wärme: Gebäudeheizlast, solange der Heizbetrieb der WP aktiv ist */
  const Q = wpsHeatOn(Ta, p) ? wpsLoadW(Ta, p) : 0;
  const spread = Math.max(0.5, p.spread);
  /* PC0 regelt auf die Spreizung. Die Pumpe ist linear (Durchfluss = a + b × Modulation),
     die WP fährt sie im Heizbetrieb aber nicht unter die Mindestmodulation – unter 5 °C Lufttemperatur höher (Frostschutz). */
  const modMin = Ta < WPS_C.PC0_SWITCH ? (p.pc0modmin ?? 41) : (p.pc0modwarm ?? 35);
  const fMin = wpsPc0Flow(modMin), fMax = wpsPc0Flow(100);
  const capMinW = wpsCapMin(Ta, T0, model) * 1000;
  /* Unter der Mindestleistung taktet die WP: sie läuft mit Mindestleistung, Laufzeitanteil = Q / Qmin */
  const Qrun = Q > 0 ? Math.max(Q, capMinW) : 0;
  const duty = Q > 0 ? Q / Qrun : 0;
  const live = Q > 0 && p.pc0Live > 0;
  const mP = Q > 0 ? (live ? p.pc0Live / 3600 : wpsClamp(Qrun / (cp * spread), fMin / 3600, fMax / 3600)) : 0;
  const pc0mod = Q > 0 ? wpsPc0Mod(mP * 3600) : 0;

  const dTh = Q / Math.max(1e-9, mH * cp);
  const dTp = Qrun / Math.max(1e-9, mP * cp);
  const TR = T0 - dTh;
  let TC3, TC0;
  if (mP <= 1e-6) { TC3 = T0; TC0 = TR; }
  else if (mP >= mH) { TC3 = T0; TC0 = T0 - dTp; }
  else { TC3 = TR + dTp; TC0 = TR; }

  const copBase = wpsCOP(TC3, Ta, model);
  const capMaxW = wpsCapMax(Ta, T0, model) * 1000;
  const modCap = wpsClamp(Qrun / Math.max(1e-9, capMaxW), 0, 1);

  const prof = WPS_PROFILES[model] || WPS_PROFILES["7 kW"];
  const el = prof.el;
  const baseW = Math.max(0, el[2] * el[1] - el[0]);
  let pelRun = Qrun / Math.max(1e-9, copBase);
  if (p.effMod) {
    const c = wpsModCalib(Ta, model);
    pelRun = (pelRun + baseW) * (1 + (prof.as ?? 1) * c.alpha * Math.pow(modCap - c.mopt, 2)) * WPS_C.OVERHEAD;
  }
  /* Taktverluste nach EN 14825 (Cd = 0,9) */
  const plf = duty > 0 && duty < 1 ? duty / (WPS_C.CD * duty + 1 - WPS_C.CD) : 1;
  const pel = Q > 0 ? (pelRun * duty) / plf : 0;
  const cop = Q > 0 ? Q / pel : 0;
  const modEl = pelRun / el[1];
  const Te = Ta - WPS_C.TE;
  return {
    Ta, T0, TR, TC3, TC0, Q, pel, cop, capMaxW, capMinW, modCap, modEl,
    mod: modCap, duty, cycling: Q > 0 && duty < 0.999,
    pc0: mP * 3600, pc1: mH * 3600, pc0mod, pc0live: live,
    evap: Te, suction: Te + WPS_C.SH, tr1: Te + WPS_C.SH + 0.85 * (TC3 + WPS_C.TC - Te),
  };
}
/* ===== Karte: Effizienz-Rechner ===== */
/* Eingebaute Beispielwerte (WLW186i-7 AR mit TP70, Fußbodenheizung). Heizlast, Normaußentemperatur, Durchfluss usw. bitte über
   „defaults:“ in der Karten-Konfiguration auf die eigene Anlage setzen; Einstellungen der Wärmepumpe lädt „Aus EMS-ESP laden“.
   flow150 = gemessener PC1-Durchfluss (794 l/h bei 250 mbar) umgerechnet auf 150 mbar; wird live aus EMS-ESP gelernt. */
const WPS_DEFAULTS = {
  model: "7 kW", nat: -12, vl20: 22, vlNat: 31, rsoll: 22, offs: -2, minflow: 22, loadKw: 4.1, limB: 13, limit: 13,
  spread: 4.5, pressure: 250, flow150: 615, pc0modmin: 41, pc0modwarm: 35, pc0a: 126, pc0b: 15.9, ti: 22, ta: 5.9, modMode: "electrical", effMod: true,
};

/* Schlüssel, Bezeichnung, min, max, Schritt, Nachkommastellen, Einheit, Gruppe */
const WPS_CONTROLS = [
  ["ta", "Außentemperatur (gedämpft)", -20, 22, 0.1, 1, "°C", "Rahmen"],
  ["ti", "Raumtemperatur (real gewünscht)", 18, 24, 0.5, 1, "°C", "Rahmen"],
  ["nat", "Normaußentemperatur", -20, 0, 0.1, 1, "°C", "Rahmen"],
  ["loadKw", "Gebäudeheizlast bei NAT", 1, 15, 0.1, 1, "kW", "Rahmen"],
  ["limB", "Heizgrenze Gebäude (Heizlast = 0)", 8, 20, 0.5, 1, "°C", "Rahmen"],
  ["pc0modmin", "Min. Modulation PC0 unter 5 °C", 10, 100, 1, 0, "%", "Rahmen"],
  ["pc0modwarm", "Min. Modulation PC0 ab 5 °C", 10, 100, 1, 0, "%", "Rahmen"],
  ["vl20", "Fußpunkt (VL bei 20 °C)", 22, 40, 0.5, 1, "°C", "Einstellungen"],
  ["vlNat", "Auslegungstemperatur (VL bei NAT)", 25, 55, 0.5, 1, "°C", "Einstellungen"],
  ["rsoll", "Raumsoll EMS-ESP", 15, 25, 0.5, 1, "°C", "Einstellungen"],
  ["offs", "Temperaturanhebung", -5, 5, 1, 0, "K", "Einstellungen"],
  ["minflow", "Min. Vorlauftemperatur", 15, 30, 1, 0, "°C", "Einstellungen"],
  ["limit", "Heizgrenze", 10, 20, 1, 0, "°C", "Einstellungen"],
  ["spread", "Spreizung TC3–TC0", 2, 10, 0.5, 1, "K", "Einstellungen"],
  ["pressure", "Pumpensolldruck PC1", 150, 750, 50, 0, "mbar", "Einstellungen"],
];
const WPS_TUNE = ["vl20", "vlNat", "rsoll", "offs", "minflow", "limit", "spread", "pressure"];

const WPS_ENTITIES = {
  outdoor: "sensor.thermostat_dampedoutdoortemp",
  tl2: "sensor.boiler_hptl2",
  s_nat: "number.thermostat_minexttemp",
  s_vl20: "number.thermostat_hc1_baseflowtemp",
  s_vlNat: "number.thermostat_hc1_designtemp",
  s_rsoll: "number.thermostat_hc1_seltemp",
  s_offs: "number.thermostat_hc1_offsettemp",
  s_minflow: "number.thermostat_hc1_minflowtemp",
  s_limit: "number.thermostat_summertemp",
  s_spread: "number.boiler_tempdiffheat",
  s_pressure: "number.boiler_hpsetdiffpress",
  pumpmod: "sensor.boiler_heatingpumpmod",
  activity: "sensor.boiler_hpactivity",
  pc0flow: "sensor.wp_primarkreis_durchfluss_berechnet",
  pc1flow: "sensor.boiler_pc1flow",
  target: "sensor.thermostat_hc1_targetflowtemp",
};
/* Regler, die „Aus EMS-ESP laden“ aus der Anlage übernimmt.
   Die Sommertemperatur setzt beide Heizgrenzen (Gebäude und WP); danach lassen sie sich getrennt verschieben. */
const WPS_SYNC = { ta: "outdoor", nat: "s_nat", vl20: "s_vl20", vlNat: "s_vlNat", rsoll: "s_rsoll", offs: "s_offs", minflow: "s_minflow",
                   limit: "s_limit", limB: "s_limit", spread: "s_spread", pressure: "s_pressure" };
const WPS_ENT_LABELS = {
  outdoor: "Außentemperatur (gedämpft)", tl2: "Außenlufteintritt TL2", s_nat: "Normaußentemperatur", s_vl20: "Fußpunkt",
  s_vlNat: "Auslegungstemperatur", s_rsoll: "Raumsoll (gewählte Raumtemperatur)", s_offs: "Temperaturanhebung",
  s_minflow: "Min. Vorlauftemperatur", s_limit: "Heizgrenze (Sommertemperatur)", s_spread: "Spreizung TC3/TC0", s_pressure: "Pumpensolldruck PC1",
  pumpmod: "Modulation PC0 (live)", activity: "Kompressoraktivität", pc0flow: "Durchfluss PC0 (gemessen/berechnet)",
  pc1flow: "Durchfluss PC1 (gemessen)", target: "Berechnete Vorlauftemperatur HK1",
};

const WPS_COL = { curve: "#1e88e5", need: "#90caf9", load: "#43a047", cap: "#ef6c00", min: "#c18a1a", cop: "#00897b", bv: "#8e24aa" };
/* Linien im Diagramm: Schlüssel, Bezeichnung, gestrichelt. Ein Klick auf die Legende blendet die Linie aus. */
const WPS_SERIES = [
  ["curve", "Heizkurve", false], ["need", "benötigter Vorlauf", true], ["load", "Heizlast", false],
  ["cap", "Max. WP", false], ["min", "Min. WP", true], ["cop", "COP", false],
];
const WPS_CW = 680, WPS_CH = 300, WPS_M = { t: 10, r: 44, b: 38, l: 42 };
const WPS_FBH_N = 1.1; /* Heizkörperexponent Fußbodenheizung */

const wpsFmt = (v, d = 1) =>
  v === null || v === undefined || isNaN(v) ? "–" :
  Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });

function wpsTempColor(t) {
  const f = wpsClamp((t - 20) / 25, 0, 1);
  const a = [66, 165, 245], b = [239, 83, 80];
  return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * f)).join(",")})`;
}

/* Wärmeabgabe der Fußbodenheizung: Bezugspunkt = Vorlauf der Anlage bei NAT deckt genau die Heizlast.
   Ist der Heizbetrieb der WP aus (über ihrer Heizgrenze), gibt die Fußbodenheizung nichts ab. */
function wpsFbh(p, ref, Ta) {
  const cp = WPS_C.cp;
  const mHref = (ref.flow150 / 3600) * Math.sqrt(Math.max(20, ref.pressure) / WPS_C.DP_REF);
  const Qd = Math.max(0.1, p.loadKw) * 1000;
  const TmD = ref.vlNat - Qd / (2 * mHref * cp);           /* mittlere Wassertemperatur am Auslegungspunkt */
  const dD = Math.max(1, TmD - p.ti);
  const Q = wpsLoadW(Ta, p);
  const on = wpsHeatOn(Ta, p);
  const mH = (p.flow150 / 3600) * Math.sqrt(Math.max(20, p.pressure) / WPS_C.DP_REF);
  const T0 = wpsFlowTarget(Ta, p);
  const Tm = T0 - Q / (2 * mH * cp);
  const emit = on ? Qd * Math.pow(Math.max(0, Tm - p.ti) / dD, WPS_FBH_N) : 0;
  const TmReq = p.ti + dD * Math.pow(Math.max(0, Q) / Qd, 1 / WPS_FBH_N);
  const T0req = Q > 0 ? TmReq + Q / (2 * mH * cp) : null;
  return { Q, emit, on, cov: Q > 0 ? emit / Q : null, T0req, Tm };
}

const WPS_CSS = `
  :host { display:block; }
  ha-card { overflow:hidden; }
  .head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:6px 10px;
          padding:8px 12px; border-bottom:1px solid var(--divider-color); }
  .title { display:flex; align-items:center; gap:8px; font-size:15px; font-weight:600; color:var(--primary-text-color); }
  .title ha-icon { --mdc-icon-size:18px; color:var(--secondary-text-color); }
  .actions { display:flex; gap:6px; flex-wrap:wrap; }
  .btn { display:flex; align-items:center; gap:4px; padding:3px 9px 3px 7px; border-radius:999px; font-size:12px; font-weight:600;
         border:1px solid var(--divider-color); background:none; color:var(--secondary-text-color); cursor:pointer; font-family:inherit; }
  .btn ha-icon { --mdc-icon-size:15px; }
  .btn.on { color:var(--primary-color); border-color:var(--primary-color); background:rgba(3,169,244,.08); }
  .btn:disabled { opacity:.4; cursor:default; }
  .grid2 { display:grid; grid-template-columns:minmax(0,1fr); border-bottom:1px solid var(--divider-color); }
  .grid2:last-child { border-bottom:none; }
  @media (min-width:900px) {
    .grid2 { grid-template-columns:minmax(300px,1fr) minmax(0,1.35fr); }
    .grid2.r { grid-template-columns:minmax(0,1.35fr) minmax(300px,1fr); }
    .grid2 > .sec:first-child { border-right:1px solid var(--divider-color); }
  }
  @media (max-width:899px) { .grid2 > .sec:first-child { border-bottom:1px solid var(--divider-color); } }
  .sec { padding:8px 12px; min-width:0; }
  .sec h3 { margin:0 0 4px; font-size:12.5px; font-weight:600; color:var(--secondary-text-color); display:flex; align-items:center; gap:6px; }
  .sec h3 ha-icon { --mdc-icon-size:15px; }
  .sec h3 .btn { margin-left:auto; }
  .grp { font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--secondary-text-color); margin:6px 0 1px; }
  .grp:first-child { margin-top:0; }
  .row { display:grid; grid-template-columns:minmax(0,1fr) 66px minmax(90px,140px); align-items:center; gap:8px; min-height:24px; }
  .row label { font-size:12.5px; color:var(--primary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .row .v { text-align:right; font-variant-numeric:tabular-nums; font-size:12.5px; color:var(--primary-text-color); }
  .row input[type=range] { width:100%; accent-color:var(--primary-color); margin:0; height:16px; }
  .row.live label::after { content:" · EMS-ESP"; color:var(--primary-color); font-weight:600; font-size:11px; }
  .row.idle label, .row.idle .v { opacity:.45; }
  .row.used label { font-weight:600; }
  .row .v.chg { color:var(--primary-color); font-weight:600; }
  .adv { font-size:12px; color:var(--secondary-text-color); display:flex; flex-wrap:wrap; gap:4px 14px; padding-top:6px; }
  .adv label { display:flex; align-items:center; gap:5px; cursor:pointer; }
  .legend { display:flex; flex-wrap:wrap; gap:2px 12px; font-size:11px; color:var(--secondary-text-color); margin-bottom:2px; }
  .legend span { display:flex; align-items:center; gap:5px; cursor:pointer; user-select:none; -webkit-user-select:none; }
  .legend span.off { opacity:.4; text-decoration:line-through; }
  .legend i { display:inline-block; width:16px; height:0; border-top:3px solid; }
  .legend i.dash { border-top-style:dashed; }
  .chartwrap { position:relative; touch-action:pan-y; }
  svg { display:block; width:100%; height:auto; }
  #diag { max-width:640px; margin:0 auto; }
  .ax text { fill:var(--secondary-text-color); font-size:13px; }
  .ax line { stroke:var(--divider-color); }
  .grid line { stroke:var(--divider-color); stroke-opacity:.55; }
  .axt { fill:var(--secondary-text-color); font-size:13px; }
  /* Werte zur markierten Außentemperatur: feste Zeile unter dem Diagramm, verdeckt keine Linien */
  .tip { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:1px 16px; margin-top:4px; padding:5px 8px;
         border:1px solid var(--divider-color); border-radius:8px; font-size:11.5px; line-height:1.45; color:var(--primary-text-color); }
  .tip div { display:flex; justify-content:space-between; gap:10px; white-space:nowrap; }
  .tip b { font-weight:600; }
  .tip .tv { font-variant-numeric:tabular-nums; }
  .dlbl { fill:var(--primary-text-color); font-size:13px; font-variant-numeric:tabular-nums; }
  .dlbl.b { font-weight:700; }
  .dsec { fill:var(--secondary-text-color); font-size:14px; font-weight:600; }
  .box { fill:var(--secondary-background-color); stroke:var(--divider-color); }
  .hx { fill:var(--card-background-color); stroke-width:3; }
  .pipe { fill:none; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:12 8;
          animation:wps-flow var(--dur,2s) linear infinite; }
  @keyframes wps-flow { to { stroke-dashoffset:-40; } }
  .air { fill:none; stroke:#42a5f5; stroke-width:4; stroke-dasharray:12 8; stroke-linecap:round; animation:wps-flow 2.5s linear infinite; }
  .buf { fill:var(--card-background-color); stroke:var(--primary-text-color); stroke-width:2; }
  .copbox { display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:4px 10px; font-size:12.5px;
            color:var(--primary-text-color); padding:5px 8px; border:1px solid var(--divider-color); border-radius:8px;
            max-width:480px; margin:4px auto 0; }
  .frac { display:inline-flex; flex-direction:column; align-items:center; font-size:11.5px; }
  .frac span:first-child { border-bottom:1px solid var(--primary-text-color); padding:0 3px 1px; }
  .frac span:last-child { padding:1px 3px 0; }
  .kpi { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin:2px 0 6px; }
  .kpi .big { font-size:32px; font-weight:700; line-height:1; color:var(--primary-text-color); font-variant-numeric:tabular-nums; }
  .kpi .lbl { font-size:12px; color:var(--secondary-text-color); }
  .kpi .delta { font-size:13px; font-weight:600; font-variant-numeric:tabular-nums; }
  .delta.up { color:var(--success-color, #43a047); } .delta.down { color:var(--error-color, #e53935); }
  .kv { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:1px 10px; font-size:12px; font-variant-numeric:tabular-nums; }
  .kv span:nth-child(odd) { color:var(--secondary-text-color); }
  .kv span:nth-child(even) { text-align:right; color:var(--primary-text-color); }
  .cov { height:6px; border-radius:3px; background:var(--divider-color); margin:6px 0 2px; overflow:hidden; position:relative; }
  .cov i { position:absolute; left:0; top:0; bottom:0; border-radius:3px; }
  .covtxt { font-size:12px; }
  .best { margin-top:8px; padding:6px 8px; border-radius:8px; background:var(--secondary-background-color); font-size:12px; }
  .best b { font-size:14px; }
  .best .bp { color:var(--secondary-text-color); margin:2px 0 4px; }
  .warn { margin-top:6px; padding:4px 8px; border-radius:6px; font-size:12px; color:var(--warning-color,#ffa726);
          background:rgba(255,167,38,.1); display:none; }
  .warn.show { display:block; }
  .credit { font-size:11px; color:var(--secondary-text-color); margin-top:8px; line-height:1.35; }
  .credit a { color:var(--primary-color); text-decoration:none; }
  .credit a:hover { text-decoration:underline; }
  .note { font-size:11px; color:var(--secondary-text-color); margin-top:6px; line-height:1.35; }
  .note summary { cursor:pointer; font-weight:600; font-size:12px; user-select:none; -webkit-user-select:none; }
  .note[open] summary { margin-bottom:3px; }
  @media (max-width:520px) { .row { grid-template-columns:minmax(0,1fr) 62px; } .row input[type=range] { grid-column:1 / -1; } }
  @media (prefers-reduced-motion: reduce) { .pipe, .air { animation:none; } }
`;

/* Schlüssel, die „Als Standard speichern“ sichert */
const WPS_STD_KEYS = WPS_CONTROLS.map((r) => r[0]).concat(["effMod"]);

class WpSimulatorCard extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign({}, config || {});
    const sh = this._config.shift || {};
    if (sh.room !== undefined) WPS_C.RSHIFT = +sh.room;
    if (sh.offset !== undefined) WPS_C.OSHIFT = +sh.offset;
    if (sh.ref !== undefined) WPS_C.RREF = +sh.ref;
    /* heizgrenze: legacy -> altes Verhalten (eine Heizgrenze für Gebäude und WP, Regler „Heizgrenze Gebäude“ entfällt) */
    WPS_C.SPLIT = String(this._config.heizgrenze || "").toLowerCase() !== "legacy";
    this._ent = Object.assign({}, WPS_ENTITIES, this._config.entities || {});
    /* Regler: eingebaut, optional überschrieben durch controls: { key: { min, max, step } } */
    const ov = this._config.controls || {};
    this._controls = WPS_CONTROLS.filter((r) => WPS_C.SPLIT || r[0] !== "limB").map((r) => {
      const o = ov[r[0]] || {}, c = r.slice();
      if (r[0] === "limit" && WPS_C.SPLIT) c[1] = "Heizgrenze WP (Heizbetrieb aus ab)";
      if (o.min !== undefined) c[2] = +o.min;
      if (o.max !== undefined) c[3] = +o.max;
      if (o.step !== undefined) c[4] = +o.step;
      return c;
    });
    this._storeKey = "wp-effizienz-card:" + (this._config.storage_key || "default");
    this._stdKey = this._storeKey + ":standard";
    this._defaults = this._mkDefaults();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this._storeKey) || "null"); } catch (e) { saved = null; }
    this._p = this._snapAll(Object.assign({}, this._defaults, (saved && saved.p) || {}));
    this._best = (saved && saved.best) || null;
    this._pc0Auto = !(saved && saved.pc0Auto === false);
    this._taAuto = !(saved && saved.taAuto === false);
    /* Wertezeile unter dem Diagramm: Standard an, die Wahl bleibt im Browser gespeichert */
    this._tipOn = !(saved && saved.tipOn === false);
    /* Ausgeblendete Linien im Diagramm */
    this._hide = Object.assign({}, (saved && saved.hide) || {});
    /* Beim ersten Öffnen (und nach einer Änderung am Speicherstand) die aktuellen Anlagenwerte laden */
    this._loadPending = !(saved && saved.p && saved.v === WPS_STORE_V);
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._build();
    this._sig = null;
    if (this._hass) this.hass = this._hass;
    else this._recalc();
  }

  /* Standardwerte = eingebaut, überschrieben von Karten-Konfiguration, überschrieben von „Als Standard speichern“ */
  _mkDefaults() {
    let user = null;
    try { user = JSON.parse(localStorage.getItem(this._stdKey) || "null"); } catch (e) { user = null; }
    return Object.assign({}, WPS_DEFAULTS, this._config.defaults || {}, user || {});
  }

  /* Wert auf Bereich und Schrittweite des Reglers bringen */
  _snap(k, v) {
    const c = this._ctl(k);
    if (!c || v === null || v === undefined || isNaN(v)) return v;
    const [, , min, max, step] = c;
    const s = Math.round((wpsClamp(v, min, max) - min) / step) * step + min;
    return +wpsClamp(s, min, max).toFixed(4);
  }
  _snapAll(p) {
    for (const c of this._controls) if (p[c[0]] !== undefined) p[c[0]] = this._snap(c[0], p[c[0]]);
    return p;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) return;
    let sig = "";
    for (const id of Object.values(this._ent)) { const s = hass.states[id]; sig += (s ? s.state : "x") + "|"; }
    if (sig === this._sig) return;
    this._sig = sig;
    if (this._loadPending && this._num("s_vlNat") !== null) {
      this._loadPending = false;
      this._loadFromEms();
      return;
    }
    this._autoTa();
    this._autoPc0();
    this._autoPc1();
    this._recalc(); /* Referenz und „Anlage“-Markierungen aktualisieren */
  }

  getCardSize() { return 14; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }
  static getStubConfig() { return {}; }
  static getConfigForm() {
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        { name: "entities", type: "expandable", title: "Entitäten (Anlagenwerte)",
          schema: Object.keys(WPS_ENTITIES).map((k) => ({ name: k, selector: { entity: {} } })) },
      ],
      computeLabel: (s) => ({ title: "Titel", entities: "Entitäten" }[s.name] || WPS_ENT_LABELS[s.name] || s.name),
      computeHelper: (s) => (WPS_ENTITIES[s.name] ? `Leer = ${WPS_ENTITIES[s.name]}` : undefined),
    };
  }

  /* --- Hilfen --- */
  _st(k) { return this._hass ? this._hass.states[this._ent[k]] : undefined; }
  _num(k) {
    const s = this._st(k);
    if (!s) return null;
    const v = parseFloat(s.state);
    return isNaN(v) ? null : v;
  }
  _save() {
    try { localStorage.setItem(this._storeKey, JSON.stringify({ v: WPS_STORE_V, p: this._p, best: this._best, pc0Auto: this._pc0Auto, taAuto: this._taAuto, tipOn: this._tipOn, hide: this._hide })); } catch (e) { /* egal */ }
  }
  _$(id) { return this.shadowRoot.getElementById(id); }
  _txt(el, t) { if (el && el.textContent !== t) el.textContent = t; }
  _ctl(k) { return (this._controls || WPS_CONTROLS).find((r) => r[0] === k); }
  _flash(id, text) {
    const b = this._$(id); if (!b) return;
    const span = b.querySelector("span"); if (!span) return;
    const old = span.textContent; span.textContent = text; b.classList.add("on");
    clearTimeout(this["_ft" + id]);
    this["_ft" + id] = setTimeout(() => { span.textContent = old; b.classList.remove("on"); }, 1800);
  }

  /* Anlagenwerte (EMS-ESP) – Bezugspunkt für die Fußbodenheizung und Markierung geänderter Regler */
  _plant() {
    const o = {};
    for (const [k, ek] of Object.entries(WPS_SYNC)) o[k] = this._num(ek);
    return o;
  }
  _plantParams() {
    const a = this._plant(), pp = Object.assign({}, this._p);
    for (const k of WPS_TUNE) if (a[k] !== null && a[k] !== undefined) pp[k] = a[k];
    if (a.nat !== null && a.nat !== undefined) pp.nat = a.nat;
    return pp;
  }
  /* Referenz: Vorlauf der Anlage (inkl. Raumsoll und Temperaturanhebung) bei NAT */
  _ref() {
    const pp = this._plantParams(), a = this._plant(), d = this._defaults;
    return { vlNat: wpsFlowTarget(pp.nat, pp), pressure: a.pressure ?? d.pressure, flow150: this._p.flow150 };
  }

  _heating() { return /heiz/i.test(String((this._st("activity") || {}).state || "")); }

  /* Gedämpfte Außentemperatur live in den Regler übernehmen, bis der Regler von Hand verschoben wird */
  _autoTa() {
    if (!this._taAuto) return false;
    const v = this._num("outdoor");
    if (v === null) return false;
    const s = this._snap("ta", v);
    if (this._p.ta === s) return false;
    this._p.ta = s;
    const el = this._$("i-ta"); if (el) el.value = s;
    this._save();
    return true;
  }

  /* Regler für die Mindestmodulation PC0, den die Simulation bei der eingestellten Außentemperatur verwendet */
  _pc0KeySim() { return this._p.ta < WPS_C.PC0_SWITCH ? "pc0modmin" : "pc0modwarm"; }
  /* Regler, in den der Live-Wert gehört: nach der ECHTEN Lufttemperatur (TL2, sonst gedämpfte Außentemperatur) */
  _pc0KeyLive() {
    const t = this._num("tl2") ?? this._num("outdoor");
    if (t === null) return null;
    /* Übergangsbereich 4–5 °C: die WP schaltet dort um, Werte sind nicht eindeutig -> nicht lernen */
    return t < WPS_C.PC0_LEARN_LO ? "pc0modmin" : t >= WPS_C.PC0_LEARN_HI ? "pc0modwarm" : null;
  }
  /* PC0-Modulation live aus EMS-ESP übernehmen (nur im Heizbetrieb, ohne Anlaufspitzen) */
  _autoPc0() {
    if (!this._pc0Auto) return false;
    const m = this._num("pumpmod");
    if (m === null || m <= 0 || m >= 90 || !this._heating()) return false;
    const k = this._pc0KeyLive();
    if (!k || this._p[k] === m) return false;
    this._p[k] = m;
    const el = this._$("i-" + k); if (el) el.value = m;
    this._save();
    return true;
  }

  /* PC1-Durchfluss live aus EMS-ESP lernen: gemessener Wert beim Pumpensolldruck der Anlage, umgerechnet auf 150 mbar.
     Für einen anderen Pumpensolldruck im Rechner wird daraus mit der Wurzel-Regel zurückgerechnet. */
  _autoPc1() {
    const f = this._num("pc1flow"), pr = this._num("s_pressure");
    if (f === null || f < 50 || pr === null || pr <= 0) return false;
    const v = Math.round((f * Math.sqrt(WPS_C.DP_REF / pr)) / 5) * 5;
    if (this._p.flow150 === v) return false;
    this._p.flow150 = v;
    this._save();
    return true;
  }

  /* Realer PC0-Durchfluss: nur wenn die Karte die aktuelle Situation zeigt (Heizbetrieb, Außentemperatur = Anlage) */
  _livePc0() {
    if (!this._pc0Auto || !this._heating()) return null;
    const out = this._num("outdoor");
    if (out === null || Math.abs(out - this._p.ta) > 0.5) return null;
    const v = this._num("pc0flow");
    return v !== null && v > 0 ? v : null;
  }

  _loadFromEms() {
    this._pc0Auto = true;
    this._taAuto = true;
    const a = this._plant();
    for (const k of Object.keys(WPS_SYNC)) {
      if (a[k] === null) continue;
      this._p[k] = this._ctl(k) ? this._snap(k, a[k]) : a[k];
    }
    this._autoPc0();
    this._autoPc1();
    this._syncInputs(); this._save(); this._recalc();
  }

  _saveStandard() {
    const d = {};
    for (const k of WPS_STD_KEYS) d[k] = this._p[k];
    try { localStorage.setItem(this._stdKey, JSON.stringify(d)); } catch (e) { /* egal */ }
    this._defaults = this._mkDefaults();
    this._flash("b-setstd", "Gespeichert ✓");
  }

  /* Wertezeile unter dem Diagramm ein-/ausblenden */
  _applyTipToggle() {
    const b = this._$("b-tip"), tip = this._$("tip");
    if (b) {
      b.classList.toggle("on", this._tipOn);
      b.title = this._tipOn ? "Werte unter dem Diagramm ausblenden" : "Werte unter dem Diagramm einblenden";
    }
    if (tip) tip.style.display = this._tipOn ? "" : "none";
  }

  /* Legende: ausgeblendete Linien durchgestrichen darstellen */
  _applyLegend() {
    this.shadowRoot.querySelectorAll(".legend span").forEach((el) => el.classList.toggle("off", !!this._hide[el.dataset.s]));
  }

  /* --- Aufbau --- */
  _build() {
    const p = this._p;
    let rows = "", grp = "";
    for (const [k, lbl, min, max, step, , , g] of this._controls) {
      if (g !== grp) { rows += `<div class="grp">${g === "Rahmen" ? "Rahmenbedingungen" : "Einstellungen der Wärmepumpe"}</div>`; grp = g; }
      rows += `<div class="row" id="r-${k}"><label for="i-${k}">${lbl}</label><span class="v" id="v-${k}"></span>
        <input type="range" id="i-${k}" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${p[k]}"></div>`;
    }
    const legend = WPS_SERIES.map(([k, lbl, dash]) =>
      `<span data-s="${k}" title="Klicken: Linie ein-/ausblenden"><i${dash ? ' class="dash"' : ""} style="border-color:${WPS_COL[k]}"></i>${lbl}</span>`).join("");
    const limNote = WPS_C.SPLIT
      ? `Heizgrenzen: „Aus EMS-ESP laden“ setzt beide auf die Sommertemperatur der Anlage. „Heizgrenze Gebäude“ legt fest, bis zu welcher Außentemperatur das Haus Wärme braucht (Heizlastlinie). „Heizgrenze WP“ ist die Einstellung der Anlage: ab dieser Außentemperatur ist der Heizbetrieb aus; sie ändert den COP bei tieferen Temperaturen nicht. Altes Verhalten (eine gemeinsame Heizgrenze): in der Kartenkonfiguration heizgrenze: legacy eintragen.`
      : `Heizgrenze: altes Verhalten (heizgrenze: legacy) – die Heizgrenze bestimmt zugleich die Heizlastlinie des Gebäudes.`;

    this.shadowRoot.innerHTML = `<style>${WPS_CSS}</style>
    <ha-card>
      <div class="head">
        <div class="title"><ha-icon icon="mdi:heat-pump-outline"></ha-icon><span>${this._config.title || "Wärmepumpe – Effizienz-Rechner"}</span></div>
        <div class="actions">
          <button class="btn" id="b-load"><ha-icon icon="mdi:download"></ha-icon><span>Aus EMS-ESP laden</span></button>
          <button class="btn" id="b-reset" title="Regler auf die gespeicherten Standardwerte setzen"><ha-icon icon="mdi:restore"></ha-icon><span>Standardwerte</span></button>
          <button class="btn" id="b-setstd" title="Aktuelle Reglerstellung als neue Standardwerte speichern"><ha-icon icon="mdi:content-save-outline"></ha-icon><span>Als Standard speichern</span></button>
        </div>
      </div>
      <div class="grid2">
      <div class="sec">
        ${rows}
        <div class="adv">
          <label><input type="checkbox" id="i-eff" ${p.effMod ? "checked" : ""}> Effizienz abhängig von Modulation</label>
        </div>
      </div>
      <div class="sec">
        <h3><ha-icon icon="mdi:chart-bell-curve-cumulative"></ha-icon>Heizkurve, Heizlast &amp; COP
          <button class="btn" id="b-tip"><ha-icon icon="mdi:format-list-bulleted"></ha-icon><span>Werte</span></button></h3>
        <div class="legend">${legend}</div>
        <div class="chartwrap" id="cw"><svg id="chart" viewBox="0 0 ${WPS_CW} ${WPS_CH}"></svg></div>
        <div class="tip" id="tip"></div>
      </div>
      </div>
      <div class="grid2 r">
      <div class="sec">
        <h3><ha-icon icon="mdi:pipe"></ha-icon>Anlagenschema</h3>
        <svg id="diag" viewBox="0 0 760 300" role="img" aria-label="Anlagenschema"></svg>
        <div class="copbox">COP =
          <span class="frac"><span>Erzeugte Wärmeleistung</span><span>Eingesetzte elektrische Leistung</span></span> =
          <span class="frac"><span id="cop-q"></span><span id="cop-p"></span></span> = <b id="cop-v"></b></div>
      </div>
      <div class="sec">
        <h3><ha-icon icon="mdi:speedometer"></ha-icon>Effizienz</h3>
        <div class="kpi"><span class="big" id="k-cop">–</span><span class="lbl">COP</span><span class="delta" id="k-delta"></span></div>
        <div class="kv">
          <span>Wärmeleistung</span><span id="k-q"></span>
          <span>Elektrische Leistung</span><span id="k-p"></span>
          <span>Strom pro Tag (24 h)</span><span id="k-day"></span>
          <span>Verdichter (Anteil an Max.-Leistung)</span><span id="k-mod"></span>
          <span>Vorlauf eingestellt / benötigt</span><span id="k-vl"></span>
          <span>Vorlauf-Soll Anlage (EMS-ESP)</span><span id="k-tgt"></span>
          <span>TC3 (Verflüssiger)</span><span id="k-tc3"></span>
          <span>PC0 Durchfluss / Modulation</span><span id="k-pc0"></span>
          <span>PC1 Durchfluss</span><span id="k-pc1"></span>
          <span>Spreizung TC3–TC0 (Ergebnis)</span><span id="k-spr"></span>
        </div>
        <div class="cov"><i id="k-covbar"></i></div>
        <div class="covtxt" id="k-cov"></div>
        <div class="warn" id="warn"></div>
        <div class="best" id="best"></div>
        <details class="note"><summary>Erläuterungen</summary>Δ = Vergleich mit den aktuellen Anlagenwerten aus EMS-ESP bei gleicher Außentemperatur.
          Diagramm: Ein Klick auf einen Eintrag der Legende blendet die Linie aus oder ein. Die Werte unter dem Diagramm gelten für die gestrichelte senkrechte Linie; „Werte“ blendet sie aus.
          ${limNote}
          PC1-Durchfluss: gemessen von EMS-ESP beim Pumpensolldruck der Anlage (wird laufend übernommen, solange PC1 läuft). Stellst du im Rechner einen anderen Pumpensolldruck ein, wird der Durchfluss mit der Wurzel-Regel umgerechnet (Durchfluss ~ √Druck).
          Heizkurve: Gerade durch Fußpunkt und Auslegung, parallel verschoben durch Raumsoll und Temperaturanhebung (an deiner Anlage gemessen), nach unten begrenzt durch die Min. Vorlauftemperatur. EMS-ESP meldet den Vorlauf-Soll nur in ganzen Grad.
          „Raumtemperatur (real gewünscht)“ gilt nur für die Wärmeabgabe der Fußbodenheizung; sie wird so gerechnet, dass der Vorlauf der Anlage bei NAT genau die Heizlast deckt.
          Die Außentemperatur folgt der gedämpften Außentemperatur aus EMS-ESP; verschiebst du den Regler, bleibt dein Wert bis „Aus EMS-ESP laden“.
          PC0-Mindestmodulation: Die Simulation nimmt den Regler, der zur eingestellten Außentemperatur passt (fett, der andere ist ausgegraut). Den Live-Wert aus EMS-ESP übernimmt die Karte im Heizbetrieb in den Regler, der zur echten Lufttemperatur TL2 passt (unter 4 °C bzw. ab 5 °C; dazwischen schaltet die WP um, dort wird nichts übernommen).
          PC0-Durchfluss: im Heizbetrieb bei aktueller Außentemperatur der Wert aus „WP Primärkreis Durchfluss berechnet“, sonst dieselbe Formel wie im Helfer (unter 50 %: 610 + 6,2 l/h je %, ab 50 %: max(126 + 15,9 × %, −486 + 23,9 × %)). Ändert sich die Formel im Helfer, muss sie in der Karte (WPS_PC0_A/WPS_PC0_B) mitgezogen werden.
          Ein Bestwert zählt nur, wenn die Heizlast zu mindestens 98 % gedeckt ist. „Als Standard speichern“ merkt sich die Reglerstellung in diesem Browser.
          Kennwerte: WLW-7 MB AR laut Buderus-Planungsunterlage 2024/04. Unter der Mindestleistung taktet die WP; Taktverluste nach EN 14825 sind eingerechnet.</details>
        <div class="credit">Dieser Rechner basiert auf dem Simulator von <a href="https://bosch-buderus-wp.github.io/" target="_blank" rel="noopener noreferrer">Matthias Röckl (bosch-buderus-wp.github.io)</a> und wurde für diese Karte angepasst: eingebunden in Home Assistant mit Live-Werten aus EMS-ESP und um die Wärmeabgabe der Fußbodenheizung sowie das Takten unter der Mindestleistung erweitert.</div>
      </div>
      </div>
    </ha-card>`;

    const r = this.shadowRoot;
    r.querySelectorAll('input[type=range]').forEach((el) => el.addEventListener("input", () => {
      this._p[el.dataset.k] = parseFloat(el.value);
      if (/^pc0mod/.test(el.dataset.k)) this._pc0Auto = false;
      if (el.dataset.k === "ta") this._taAuto = false;
      this._save(); this._recalc();
    }));
    this._$("i-eff").addEventListener("change", (e) => { this._p.effMod = e.target.checked; this._save(); this._recalc(); });
    this._$("b-load").addEventListener("click", () => this._loadFromEms());
    this._$("b-tip").addEventListener("click", () => {
      this._tipOn = !this._tipOn;
      this._save();
      this._applyTipToggle();
      if (this._tipOn) this._drawTip(this._hoverTa != null ? this._hoverTa : this._p.ta);
    });
    r.querySelectorAll(".legend span").forEach((el) => el.addEventListener("click", () => {
      const k = el.dataset.s;
      this._hide[k] = !this._hide[k];
      this._save();
      this._applyLegend();
      this._drawChart();
    }));
    this._$("b-reset").addEventListener("click", () => {
      this._defaults = this._mkDefaults();
      const keep = this._p.flow150; /* gelernter PC1-Durchfluss bleibt */
      this._p = this._snapAll(Object.assign({}, this._defaults));
      if (keep) this._p.flow150 = keep;
      this._pc0Auto = false;
      this._taAuto = true;
      this._autoTa();
      this._syncInputs(); this._save(); this._recalc();
      this._flash("b-reset", "Zurückgesetzt ✓");
    });
    this._$("b-setstd").addEventListener("click", () => this._saveStandard());
    r.addEventListener("click", (ev) => {
      for (const n of ev.composedPath()) {
        if (n === r) break;
        if (n.id === "b-best" && this._best) {
          Object.assign(this._p, this._best.p);
          this._snapAll(this._p);
          this._syncInputs(); this._save(); this._recalc();
          return;
        }
        if (n.id === "b-bestclr") { this._best = null; this._save(); this._recalc(); return; }
      }
    });
    const svg = this._$("chart");
    svg.addEventListener("pointermove", (e) => this._hover(e));
    svg.addEventListener("pointerleave", () => { this._hoverTa = null; this._drawTip(this._p.ta); });
    this._applyTipToggle();
    this._applyLegend();
    this._built = true;
  }

  _syncInputs() {
    for (const [k] of this._controls) { const el = this._$("i-" + k); if (el) el.value = this._p[k]; }
    this._$("i-eff").checked = !!this._p.effMod;
  }

  /* --- Berechnung & Ausgabe --- */
  _recalc() {
    if (!this._built) return;
    const p = this._p, plant = this._plant();
    for (const [k, , , , , dec, unit] of this._controls) {
      const el = this._$("v-" + k);
      this._txt(el, `${wpsFmt(p[k], dec)} ${unit}`);
      const pv = plant[k];
      const differs = WPS_TUNE.includes(k) && pv !== null && pv !== undefined && Math.abs(pv - p[k]) > 1e-6;
      el.classList.toggle("chg", differs);
      el.title = pv !== null && pv !== undefined ? `Anlage: ${wpsFmt(pv, dec)} ${unit}` : "";
    }
    const kSim = this._pc0KeySim(), kLive = this._pc0KeyLive();
    for (const k of ["pc0modmin", "pc0modwarm"]) {
      const row = this._$("r-" + k);
      if (!row) continue;
      row.classList.toggle("used", k === kSim);
      row.classList.toggle("idle", k !== kSim);
      row.classList.toggle("live", this._pc0Auto && k === kLive && this._num("pumpmod") !== null);
    }
    const rta = this._$("r-ta");
    if (rta) rta.classList.toggle("live", this._taAuto && this._num("outdoor") !== null);
    const live = this._livePc0();
    const pc = live ? Object.assign({}, p, { pc0Live: live }) : p;
    this._s = wpsCompute(pc);
    this._f = wpsFbh(p, this._ref(), p.ta);
    /* Vergleichsrechnung mit den Anlagenwerten bei gleicher Außentemperatur */
    const pa = Object.assign({}, pc);
    for (const k of WPS_TUNE) if (plant[k] !== null && plant[k] !== undefined) pa[k] = plant[k];
    this._sPlant = wpsCompute(pa);
    this._trackBest();
    this._drawChart();
    this._drawDiagram();
    this._drawEff();
  }

  _bestKey() {
    const p = this._p;
    return [p.ta.toFixed(1), p.ti, p.nat, p.loadKw, WPS_C.SPLIT ? p.limB : "-", p.flow150, p.pc0modmin, p.pc0modwarm, p.effMod ? 1 : 0].join("|");
  }

  _trackBest() {
    const s = this._s, f = this._f;
    if (!(s.Q > 0) || f.cov === null || f.cov < 0.98) return;
    const key = this._bestKey();
    if (this._best && this._best.key !== key) this._best = null;
    if (!this._best || s.cop > this._best.cop + 1e-9) {
      const bp = {};
      for (const k of WPS_TUNE) bp[k] = this._p[k];
      this._best = { key, cop: s.cop, p: bp };
      this._save();
    }
  }

  _drawChart() {
    const p = this._p, ref = this._ref(), W = WPS_CW, H = WPS_CH, M = WPS_M;
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const xMin = Math.min(-20, Math.floor(p.nat - 5)), xMax = 22;
    const N = 84, data = [];
    let maxKw = Math.max(7, p.loadKw);
    for (let i = 0; i < N; i++) {
      const Ta = xMin + (i / (N - 1)) * (xMax - xMin);
      const flow = wpsFlowTarget(Ta, p);
      const st = wpsCompute(Object.assign({}, p, { ta: Ta }));
      const fb = wpsFbh(p, ref, Ta);
      /* Heizlast-Linie = Wärmebedarf des Gebäudes (auch über der Heizgrenze der WP) */
      const d = { Ta, flow, need: fb.T0req, load: wpsLoadW(Ta, p) / 1000, cap: st.capMaxW / 1000, min: st.capMinW / 1000,
                  cop: st.Q > 0 ? st.cop : null };
      maxKw = Math.max(maxKw, d.load, d.cap, d.min, d.cop || 0);
      data.push(d);
    }
    const yMax = Math.ceil(maxKw / 2) * 2;
    const x = (v) => M.l + ((v - xMin) / (xMax - xMin)) * iw;
    const yL = (v) => M.t + ih - ((wpsClamp(v, 10, 60) - 10) / 50) * ih;
    const yR = (v) => M.t + ih - (v / yMax) * ih;
    this._cx = { x, yL, yR, xMin, xMax, iw };

    let bv = null;
    for (let i = 0; i < data.length - 1; i++) {
      const fa = data[i].cap - data[i].load, fb = data[i + 1].cap - data[i + 1].load;
      if (fa === 0 || fa * fb < 0) {
        const t = fa === 0 ? 0 : Math.abs(fa) / (Math.abs(fa) + Math.abs(fb));
        bv = { Ta: data[i].Ta + t * (data[i + 1].Ta - data[i].Ta), kW: data[i].cap + t * (data[i + 1].cap - data[i].cap) };
        break;
      }
    }
    this._bv = bv;

    const path = (fx, fy, key) => {
      let out = "", pen = false;
      for (const d of data) {
        if (key && (d[key] === null || d[key] === undefined)) { pen = false; continue; }
        out += `${pen ? "L" : "M"}${fx(d).toFixed(1)} ${fy(d).toFixed(1)}`; pen = true;
      }
      return out;
    };
    /* Linie zeichnen, sofern sie nicht über die Legende ausgeblendet ist */
    const h = this._hide || {};
    const ln = (k, attrs, d) => (h[k] ? "" : `<path fill="none" stroke="${WPS_COL[k]}" ${attrs} d="${d}"/>`);
    let g = `<g class="grid">`;
    for (let t = Math.ceil(xMin / 5) * 5; t <= 20; t += 5) g += `<line x1="${x(t)}" x2="${x(t)}" y1="${M.t}" y2="${M.t + ih}"/>`;
    for (let v = 10; v <= 60; v += 10) g += `<line x1="${M.l}" x2="${M.l + iw}" y1="${yL(v)}" y2="${yL(v)}"/>`;
    g += `</g><g class="ax"><line x1="${M.l}" x2="${M.l + iw}" y1="${M.t + ih}" y2="${M.t + ih}"/>`;
    for (let t = Math.ceil(xMin / 5) * 5; t <= 20; t += 5) g += `<text x="${x(t)}" y="${M.t + ih + 17}" text-anchor="middle">${t}°</text>`;
    for (let v = 10; v <= 60; v += 10) g += `<text x="${M.l - 8}" y="${yL(v) + 4}" text-anchor="end">${v}</text>`;
    const stepR = yMax > 12 ? 4 : 2;
    for (let v = 0; v <= yMax; v += stepR) g += `<text x="${M.l + iw + 8}" y="${yR(v) + 4}">${v}</text>`;
    g += `</g>
      <text class="axt" x="${M.l + iw / 2}" y="${H - 4}" text-anchor="middle">Außentemperatur (°C)</text>
      <text class="axt" transform="translate(13 ${M.t + ih / 2}) rotate(-90)" text-anchor="middle">Vorlauftemperatur (°C)</text>
      <text class="axt" transform="translate(${W - 8} ${M.t + ih / 2}) rotate(90)" text-anchor="middle">Leistung (kW) / COP</text>`;
    g += ln("min", 'stroke-width="2" stroke-dasharray="6 4"', path((d) => x(d.Ta), (d) => yR(d.min)));
    g += ln("cap", 'stroke-width="2.5"', path((d) => x(d.Ta), (d) => yR(d.cap)));
    g += ln("load", 'stroke-width="2.5"', path((d) => x(d.Ta), (d) => yR(d.load)));
    g += ln("cop", 'stroke-width="2.5"', path((d) => x(d.Ta), (d) => yR(d.cop), "cop"));
    g += ln("need", 'stroke-width="2.5" stroke-dasharray="6 4"', path((d) => x(d.Ta), (d) => yL(d.need), "need"));
    g += ln("curve", 'stroke-width="2.5"', path((d) => x(d.Ta), (d) => yL(d.flow)));
    if (!h.curve) {
      g += `<circle cx="${x(p.nat)}" cy="${yL(wpsFlowTarget(p.nat, p))}" r="4" fill="${WPS_COL.curve}"/>
      <circle cx="${x(20)}" cy="${yL(wpsFlowTarget(20, p))}" r="4" fill="${WPS_COL.curve}"/>`;
    }
    /* Bivalenzpunkt = Schnittpunkt Heizlast / Max. WP, nur wenn beide Linien sichtbar sind */
    if (bv && !h.cap && !h.load) g += `<circle cx="${x(bv.Ta)}" cy="${yR(bv.kW)}" r="5" fill="${WPS_COL.bv}" stroke="#4a148c" stroke-width="1.5"/>`;
    g += `<line id="vl" stroke="var(--primary-text-color)" stroke-width="1.2" stroke-dasharray="4 3" y1="${M.t}" y2="${M.t + ih}"/>
      <rect x="${M.l}" y="${M.t}" width="${iw}" height="${ih}" fill="transparent"/>`;
    this._$("chart").innerHTML = g;
    this._drawTip(this._hoverTa != null ? this._hoverTa : p.ta);
  }

  _hover(e) {
    if (!this._cx) return;
    const rc = this._$("chart").getBoundingClientRect();
    const sx = ((e.clientX - rc.left) / rc.width) * WPS_CW;
    const { xMin, xMax, iw } = this._cx;
    this._hoverTa = wpsClamp(xMin + ((sx - WPS_M.l) / iw) * (xMax - xMin), xMin, xMax);
    this._drawTip(this._hoverTa);
  }

  /* Markierungslinie setzen und die Wertezeile unter dem Diagramm füllen */
  _drawTip(Ta) {
    if (!this._cx) return;
    const p = this._p, { x } = this._cx;
    const vl = this._$("vl");
    if (vl) { vl.setAttribute("x1", x(Ta)); vl.setAttribute("x2", x(Ta)); }
    const tip = this._$("tip");
    /* Werte ausgeblendet: nur die Markierungslinie mitführen */
    if (!this._tipOn) { tip.style.display = "none"; return; }
    tip.style.display = "";
    const st = wpsCompute(Object.assign({}, p, { ta: Ta }));
    const fb = wpsFbh(p, this._ref(), Ta);
    const near = this._bv && Math.abs(Ta - this._bv.Ta) < 0.4 ? `<div><i>Bivalenzpunkt</i></div>` : "";
    const offTxt = fb.Q > 0 && !fb.on ? ` (WP aus)` : "";
    tip.innerHTML = `
      <div><b>Außentemperatur:</b><span class="tv">${wpsFmt(Ta, 1)} °C</span></div>
      <div><b style="color:${WPS_COL.curve}">Vorlauf eingestellt:</b><span class="tv">${wpsFmt(st.T0, 1)} °C</span></div>
      <div><b style="color:${WPS_COL.need}">Vorlauf benötigt:</b><span class="tv">${fb.T0req === null ? "–" : wpsFmt(fb.T0req, 1) + " °C"}</span></div>
      <div><b style="color:${WPS_COL.load}">Heizlast:</b><span class="tv">${wpsFmt(fb.Q / 1000, 2)} kW${offTxt}</span></div>
      <div><b style="color:${WPS_COL.cap}">Max. / Min. WP:</b><span class="tv">${wpsFmt(st.capMaxW / 1000, 2)} / ${wpsFmt(st.capMinW / 1000, 2)} kW</span></div>
      <div><b>PC0:</b><span class="tv">${wpsFmt(st.pc0, 0)} l/h · ${wpsFmt(st.pc0mod, 0)} %</span></div>
      <div><b style="color:${WPS_COL.cop}">COP:</b><span class="tv">${st.Q > 0 ? wpsFmt(st.cop, 2) : "–"}</span></div>${near}`;
  }

  _drawDiagram() {
    const s = this._s;
    const col = (t) => wpsTempColor(t);
    const wPrim = wpsClamp(3 + s.pc0 / 140, 3, 12), wHeat = wpsClamp(3 + s.pc1 / 140, 3, 12);
    const dur = (lph) => (lph > 1 ? wpsClamp(400 / lph, 0.35, 4) : 0).toFixed(2);
    const pipe = (path, c, w, lph) =>
      `<path class="pipe" d="${path}" stroke="${c}" stroke-width="${w}" style="--dur:${dur(lph)}s${lph > 1 ? "" : ";animation:none"}"/>`;
    const off = s.Q <= 0, ref = off ? 0 : 300;
    const tMean = (s.T0 + s.TR) / 2;
    this._$("diag").innerHTML = `
      <path class="air" d="M6 70 H62"/><path class="air" d="M6 230 H62"/>
      <text class="dlbl b" x="30" y="155" text-anchor="middle">${wpsFmt(s.Ta, 1)} °C</text>
      <rect class="box" x="66" y="40" width="176" height="226" rx="12"/>
      <text class="dsec" x="154" y="158" text-anchor="middle">Kältekreis</text>
      <text class="dlbl b" x="154" y="28" text-anchor="middle">Mod: ${off ? "aus" : wpsFmt(s.mod * 100, 0) + " %" + (s.cycling ? " · taktet " + wpsFmt(s.duty * 100, 0) + " %" : "")}</text>
      ${pipe("M101 62 H140", col(s.suction), 4, ref)}
      ${pipe("M168 62 H206", col(s.tr1), 4, ref)}
      ${pipe("M206 244 H101", "#7e57c2", 4, ref)}
      <circle cx="154" cy="62" r="13" fill="var(--card-background-color)" stroke="#ef6c00" stroke-width="3"/>
      <path d="M146 62 q4 -8 8 0 t8 0" fill="none" stroke="#ef6c00" stroke-width="2"/>
      <text class="dlbl" x="102" y="52">${wpsFmt(s.suction, 1)} °C</text>
      <text class="dlbl" x="154" y="94" text-anchor="middle">TR1: ${wpsFmt(s.tr1, 1)} °C</text>
      <text class="dlbl" x="102" y="284">${wpsFmt(s.evap, 1)} °C</text>
      <rect class="hx" x="78" y="54" width="23" height="198" rx="3" stroke="#42a5f5"/>
      <text class="dlbl" transform="translate(94 153) rotate(-90)" text-anchor="middle" style="font-size:12px">Verdampfer</text>
      <rect class="hx" x="206" y="54" width="23" height="198" rx="3" stroke="#ffa726"/>
      <text class="dlbl" transform="translate(222 153) rotate(90)" text-anchor="middle" style="font-size:12px">Verflüssiger</text>

      ${pipe("M229 62 H382 V96", col(s.TC3), wPrim, s.pc0)}
      ${pipe("M382 236 V244 H229", col(s.TC0), wPrim, s.pc0)}
      <text class="dsec" x="306" y="158" text-anchor="middle">Primärkreis</text>
      <text class="dlbl" x="306" y="48" text-anchor="middle">TC3: ${wpsFmt(s.TC3, 1)} °C | PC0: ${wpsFmt(s.pc0, 0)} l/h (${wpsFmt(s.pc0mod, 0)} %)${s.pc0live ? " · EMS-ESP" : ""}</text>
      <text class="dlbl" x="306" y="268" text-anchor="middle">TC0: ${wpsFmt(s.TC0, 1)} °C</text>

      ${pipe("M404 96 V62 H602 V150", col(s.T0), wHeat, off ? 0 : s.pc1)}
      ${pipe("M602 150 V244 H404 V236", col(s.TR), wHeat, off ? 0 : s.pc1)}
      <rect class="buf" x="370" y="96" width="46" height="140" rx="12"/>
      <text class="dlbl" transform="translate(397 166) rotate(-90)" text-anchor="middle" style="font-size:12px">Pendelpuffer</text>
      <text class="dsec" x="505" y="158" text-anchor="middle">Heizkreis</text>
      <text class="dlbl" x="505" y="48" text-anchor="middle">T0: ${wpsFmt(s.T0, 1)} °C | PC1: ${wpsFmt(s.pc1, 0)} l/h</text>
      <text class="dlbl" x="505" y="268" text-anchor="middle">${wpsFmt(s.TR, 1)} °C</text>
      <text class="dlbl" x="616" y="146">⌀ ${wpsFmt(tMean, 1)} °C</text>
      <text class="dlbl" x="616" y="164">${wpsFmt(s.Q / 1000, 2)} kW</text>`;
    this._txt(this._$("cop-q"), `${wpsFmt(s.Q / 1000, 2)} kW`);
    this._txt(this._$("cop-p"), `${wpsFmt(s.pel / 1000, 2)} kW`);
    this._txt(this._$("cop-v"), off ? "–" : wpsFmt(s.cop, 2));
  }

  _drawEff() {
    const s = this._s, f = this._f, a = this._sPlant, p = this._p;
    const off = s.Q <= 0;
    this._txt(this._$("k-cop"), off ? "–" : wpsFmt(s.cop, 2));
    const dEl = this._$("k-delta");
    if (!off && a.Q > 0) {
      const d = s.cop - a.cop;
      const pct = (d / a.cop) * 100;
      this._txt(dEl, Math.abs(d) < 0.005 ? "= Anlage" : `${d > 0 ? "+" : ""}${wpsFmt(d, 2)} (${d > 0 ? "+" : ""}${wpsFmt(pct, 0)} %) ggü. Anlage`);
      dEl.className = "delta" + (d > 0.005 ? " up" : d < -0.005 ? " down" : "");
    } else { this._txt(dEl, ""); dEl.className = "delta"; }
    this._txt(this._$("k-q"), `${wpsFmt(s.Q / 1000, 2)} kW`);
    this._txt(this._$("k-p"), `${wpsFmt(s.pel / 1000, 2)} kW`);
    const dayNow = (s.pel * 24) / 1000, dayPlant = (a.pel * 24) / 1000;
    this._txt(this._$("k-day"), off ? "–" : `${wpsFmt(dayNow, 1)} kWh` +
      (a.Q > 0 && Math.abs(dayNow - dayPlant) > 0.05 ? ` (Anlage ${wpsFmt(dayPlant, 1)})` : ""));
    this._txt(this._$("k-mod"), off ? "aus" : s.cycling
      ? `${wpsFmt(s.mod * 100, 0)} % (Minimum) · taktet, Laufzeit ${wpsFmt(s.duty * 100, 0)} %`
      : `${wpsFmt(s.mod * 100, 0)} %`);
    this._txt(this._$("k-vl"), off ? "–" : `${wpsFmt(s.T0, 1)} / ${f.T0req === null ? "–" : wpsFmt(f.T0req, 1)} °C`);
    const tgt = this._num("target");
    const mdl = wpsFlowTarget(this._num("outdoor") ?? p.ta, this._plantParams());
    this._txt(this._$("k-tgt"), tgt === null ? "–" : `${wpsFmt(tgt, 0)} °C (Modell ${wpsFmt(mdl, 1)} °C ≙ ${wpsFmt(Math.round(mdl), 0)} °C)`);
    this._txt(this._$("k-tc3"), off ? "–" : `${wpsFmt(s.TC3, 1)} °C`);
    this._txt(this._$("k-pc0"), off ? "–" : `${wpsFmt(s.pc0, 0)} l/h / ${wpsFmt(s.pc0mod, 0)} %` + (s.pc0live ? " · EMS-ESP" : " · berechnet"));
    /* PC1: Rechenwert beim Pumpensolldruck im Rechner, dazu der Messwert der Anlage */
    const m1 = this._num("pc1flow"), pr1 = this._num("s_pressure");
    const same = pr1 !== null && Math.abs(pr1 - p.pressure) < 1;
    this._txt(this._$("k-pc1"), `${wpsFmt(s.pc1, 0)} l/h bei ${wpsFmt(p.pressure, 0)} mbar` +
      (m1 !== null && m1 > 50 && pr1 !== null
        ? (same ? " · EMS-ESP" : ` (gemessen ${wpsFmt(m1, 0)} l/h bei ${wpsFmt(pr1, 0)} mbar)`)
        : " · aus letzter Messung"));
    const sprReal = s.TC3 - s.TC0;
    this._txt(this._$("k-spr"), off ? "–" : `${wpsFmt(sprReal, 1)} K` +
      (sprReal < p.spread - 0.05 ? (s.pc0live ? ` (Soll ${wpsFmt(p.spread, 1)} K)` : ` (Soll ${wpsFmt(p.spread, 1)} K, PC0 an der Mindestmodulation)`) : ""));

    const bar = this._$("k-covbar"), ct = this._$("k-cov");
    if (f.cov === null) {
      bar.style.width = "0"; this._txt(ct, "Keine Heizlast (über der Heizgrenze des Gebäudes).");
    } else if (!f.on) {
      bar.style.width = "0";
      this._txt(ct, `Heizbetrieb aus (über der Heizgrenze der WP) – das Gebäude braucht noch ${wpsFmt(f.Q / 1000, 2)} kW, die Räume kühlen aus.`);
    } else {
      const c = f.cov * 100;
      bar.style.width = `${wpsClamp(c / 1.3, 0, 100)}%`;
      bar.style.background = c < 98 ? "var(--error-color, #e53935)" : c > 110 ? "var(--warning-color, #ffa726)" : "var(--success-color, #43a047)";
      this._txt(ct, c < 98 ? `Fußbodenheizung deckt nur ${wpsFmt(c, 0)} % der Heizlast – Räume erreichen ${wpsFmt(p.ti, 1)} °C nicht.`
        : c > 110 ? `Fußbodenheizung liefert ${wpsFmt(c, 0)} % der Heizlast – Vorlauf höher als nötig, Räume werden wärmer.`
        : `Heizlast gedeckt (${wpsFmt(c, 0)} %).`);
    }

    const w = this._$("warn");
    let msg = "";
    if (!off && s.Q > s.capMaxW) msg = `Heizlast über der max. WP-Leistung (${wpsFmt(s.capMaxW / 1000, 2)} kW) – Heizstab nötig.`;
    else if (!off && s.Q < s.capMinW) msg = `Heizlast unter der min. WP-Leistung (${wpsFmt(s.capMinW / 1000, 2)} kW) – die WP taktet (Laufzeit ca. ${wpsFmt(s.duty * 100, 0)} %, Taktverluste eingerechnet).`;
    this._txt(w, msg);
    w.classList.toggle("show", !!msg);

    const b = this._$("best");
    if (this._best && this._best.key === this._bestKey()) {
      const bp = this._best.p;
      b.innerHTML = `Bester COP bei ${wpsFmt(p.ta, 1)} °C: <b>${wpsFmt(this._best.cop, 2)}</b>
        <div class="bp">Fußpunkt ${wpsFmt(bp.vl20, 1)} °C · Auslegung ${wpsFmt(bp.vlNat, 1)} °C · Raumsoll ${wpsFmt(bp.rsoll, 1)} °C ·
        Anhebung ${wpsFmt(bp.offs, 0)} K · Min. VL ${wpsFmt(bp.minflow, 0)} °C · Heizgrenze ${wpsFmt(bp.limit, 0)} °C ·
        Spreizung ${wpsFmt(bp.spread, 1)} K · Pumpendruck ${wpsFmt(bp.pressure, 0)} mbar</div>
        <span class="actions"><button class="btn" id="b-best"><ha-icon icon="mdi:star"></ha-icon>Bestwert einstellen</button>
        <button class="btn" id="b-bestclr"><ha-icon icon="mdi:close"></ha-icon>Zurücksetzen</button></span>`;
    } else {
      b.innerHTML = `Bester COP: noch kein Wert mit gedeckter Heizlast bei ${wpsFmt(p.ta, 1)} °C – verschiebe die Einstellungen.`;
    }
  }
}

if (!customElements.get("wp-simulator-card")) {
  customElements.define("wp-simulator-card", WpSimulatorCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "wp-simulator-card",
    name: "WP Effizienz-Rechner",
    description: "Effizienz-Rechner für Buderus WLW186i-7 AR mit TP70 – Regler verschieben, COP und Deckung der Heizlast sehen",
    preview: false,
  });
  console.info(`%c WP-EFFIZIENZ-CARD %c ${WPS_VERSION} `, "background:#00897b;color:#fff", "background:#333;color:#fff");
}
