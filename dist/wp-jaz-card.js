/*
 * wp-jaz-card – Jahresarbeitszahl (JAZ) & SCOP-Vergleich für die Buderus WLW186i (EMS-ESP)
 * Liest Monatswerte aus der Langzeitstatistik (recorder/statistics_during_period),
 * daher rückwirkend ab Inbetriebnahme verfügbar.
 *
 * Wärme   = Energie Heizen + Energie Warmwasser
 * Strom   = Kompressor + Heizstab (jeweils Heizen bzw. Warmwasser)
 * AZ      = Wärme / Strom
 * SCOP-Vergleich = Arbeitszahl nur Heizen über die Heizperiode (SCOP nach EN 14825
 * gilt nur für Raumheizung, inkl. Heizstab).
 */
const WPJAZ_VERSION = '1.1.0';
const WPJAZ_MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

const WPJAZ_DEFAULTS = {
  title: 'Jahresarbeitszahl & SCOP',
  heat_heating: 'sensor.boiler_nrgheat',
  heat_dhw: 'sensor.boiler_dhw_nrg',
  el_heating: ['sensor.boiler_meterheat', 'sensor.boiler_metereheatheat'],
  el_dhw: ['sensor.boiler_dhw_meter', 'sensor.boiler_dhw_metereheat'],
  outdoor: 'sensor.boiler_outdoortemp',
  scop35: 4.58,
  scop55: 3.52,
  season_start_month: 7,
  months: 24,
  min_kwh: 1,
  simulator_key: 'default',
};

const wpNum = (s) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
};
const wpRatio = (q, e) => (q != null && e != null && e > 0.05 && q > 0 ? q / e : null);
const wpFmt = (v, d = 2) =>
  v == null ? '–' : v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const wpCls = (v) => (v == null ? '' : v >= 4 ? 'good' : v >= 3 ? 'ok' : 'bad');
const wpEsc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

class WpJazCard extends HTMLElement {
  setConfig(config) {
    const c = Object.assign({}, WPJAZ_DEFAULTS, config || {});
    ['el_heating', 'el_dhw'].forEach((k) => {
      if (!Array.isArray(c[k])) c[k] = [c[k]].filter(Boolean);
    });
    c.months = Math.max(13, parseInt(c.months, 10) || 24);
    c.season_start_month = Math.min(12, Math.max(1, parseInt(c.season_start_month, 10) || 7));
    c.scop35 = Number(c.scop35);
    c.scop55 = Number(c.scop55);
    this._config = c;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this._stats = null;
    this._lastLoad = 0;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const due = !this._lastLoad || Date.now() - this._lastLoad > 15 * 60 * 1000;
    if (due && !this._loading) this._load();
    const sig = this._sig();
    if (sig !== this._lastSig) {
      this._lastSig = sig;
      this._render();
    }
  }

  getCardSize() {
    return 14;
  }

  static getStubConfig() {
    return {};
  }

  _sig() {
    const c = this._config;
    return [c.heat_heating, c.heat_dhw, ...c.el_heating, ...c.el_dhw]
      .map((e) => (this._hass && this._hass.states[e] ? this._hass.states[e].state : ''))
      .join('|');
  }

  async _load() {
    if (!this._hass || !this._config) return;
    this._loading = true;
    const c = this._config;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - (c.months - 1), 1);
    const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    try {
      const ids = [c.heat_heating, c.heat_dhw, ...c.el_heating, ...c.el_dhw, c.outdoor].filter(Boolean);
      const res = await this._hass.callWS({
        type: 'recorder/statistics_during_period',
        start_time: start.toISOString(),
        period: 'month',
        statistic_ids: ids,
        types: ['change', 'mean'],
        units: { energy: 'kWh' },
      });
      const months = {};
      for (let i = 0; i < c.months; i++) {
        const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
        months[key(d)] = { date: d, qH: 0, qW: 0, eH: 0, eW: 0, t: null };
      }
      const add = (id, field) => {
        (res[id] || []).forEach((r) => {
          const ts = typeof r.start === 'number' ? r.start : Date.parse(r.start);
          const m = months[key(new Date(ts))];
          if (!m) return;
          if (field === 't') {
            if (r.mean != null) m.t = r.mean;
          } else if (r.change != null) {
            m[field] += r.change;
          }
        });
      };
      add(c.heat_heating, 'qH');
      add(c.heat_dhw, 'qW');
      c.el_heating.forEach((id) => add(id, 'eH'));
      c.el_dhw.forEach((id) => add(id, 'eW'));
      if (c.outdoor) add(c.outdoor, 't');
      this._stats = Object.values(months).sort((a, b) => a.date - b.date);
      this._error = null;
    } catch (e) {
      this._error = (e && e.message) || String(e);
    }
    this._loading = false;
    this._lastLoad = Date.now();
    this._render();
  }

  _agg(rows) {
    const s = rows.reduce(
      (a, m) => ({ qH: a.qH + m.qH, qW: a.qW + m.qW, eH: a.eH + m.eH, eW: a.eW + m.eW }),
      { qH: 0, qW: 0, eH: 0, eW: 0 }
    );
    const temps = rows.map((m) => m.t).filter((t) => t != null);
    s.t = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
    s.n = rows.filter((m) => m.qH + m.qW >= this._config.min_kwh).length;
    return s;
  }

  /* Modell-Arbeitszahl (Heizen) des Effizienz-Rechners für die Monate in rows, gewichtet mit der gemessenen Wärme.
     Anlagenwerte (Heizlast, Vorlauf, Außeneinheit …) stammen aus den gespeicherten Reglern der Rechner-Karte. */
  _modelAz(rows) {
    const M = window.wpEffizienzModel;
    if (!M || !M.compute) return null;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('wp-effizienz-card:' + (this._config.simulator_key || 'default')) || 'null'); } catch (e) { saved = null; }
    const p = Object.assign({}, M.defaults, (saved && saved.p) || {}, { pc0Live: 0 });
    let q = 0, e = 0;
    for (const m of rows) {
      if (m.t == null || m.qH < this._config.min_kwh) continue;
      const s = M.compute(Object.assign({}, p, { ta: m.t }));
      if (!(s.cop > 0)) continue;
      q += m.qH;
      e += m.qH / s.cop;
    }
    return e > 0 ? q / e : null;
  }

  _life() {
    const c = this._config;
    const g = (id) => (this._hass && this._hass.states[id] ? wpNum(this._hass.states[id].state) : null);
    const sum = (list) => {
      let s = 0;
      for (const id of list) {
        const v = g(id);
        if (v == null) return null;
        s += v;
      }
      return s;
    };
    return { qH: g(c.heat_heating), qW: g(c.heat_dhw), eH: sum(c.el_heating), eW: sum(c.el_dhw), t: null };
  }

  _vals(s) {
    const ok = [s.qH, s.qW, s.eH, s.eW].every((v) => v != null);
    const q = ok ? s.qH + s.qW : null;
    const e = ok ? s.eH + s.eW : null;
    return { q, e, azH: wpRatio(s.qH, s.eH), azW: wpRatio(s.qW, s.eW), az: wpRatio(q, e), t: s.t };
  }

  _row(label, s, extraCls = '') {
    const v = this._vals(s);
    return `<tr class="${extraCls}">
      <td>${label}</td>
      <td>${v.t == null ? '–' : wpFmt(v.t, 1)}</td>
      <td>${v.q == null ? '–' : wpFmt(v.q, 0)}</td>
      <td>${v.e == null ? '–' : wpFmt(v.e, 0)}</td>
      <td class="${wpCls(v.azH)}">${wpFmt(v.azH)}</td>
      <td class="${wpCls(v.azW)}">${wpFmt(v.azW)}</td>
      <td class="az ${wpCls(v.az)}">${wpFmt(v.az)}</td>
    </tr>`;
  }

  _chart(rows) {
    const c = this._config;
    if (!rows.length) return '';
    const W = 640, H = 220, L = 30, R = 10, T = 14, B = 28;
    const vals = rows.map((m) => this._vals(m));
    const peak = Math.max(c.scop35, ...vals.flatMap((v) => [v.azH || 0, v.azW || 0, v.az || 0]));
    const maxV = Math.max(5, Math.ceil(peak + 0.3));
    const y = (v) => T + (H - T - B) * (1 - v / maxV);
    const slot = (W - L - R) / rows.length;
    const bw = Math.max(4, Math.min(20, slot * 0.3));
    let g = '';
    for (let i = 0; i <= maxV; i++) {
      g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(i)}" y2="${y(i)}"/>`;
      g += `<text x="${L - 6}" y="${y(i) + 4}" text-anchor="end">${i}</text>`;
    }
    const now = new Date();
    rows.forEach((m, i) => {
      const v = vals[i];
      const x0 = L + i * slot + slot / 2;
      if (v.azH != null) g += `<rect class="bh" x="${x0 - bw - 1}" y="${y(v.azH)}" width="${bw}" height="${y(0) - y(v.azH)}" rx="2"><title>Heizen ${wpFmt(v.azH)}</title></rect>`;
      if (v.azW != null) g += `<rect class="bw" x="${x0 + 1}" y="${y(v.azW)}" width="${bw}" height="${y(0) - y(v.azW)}" rx="2"><title>Warmwasser ${wpFmt(v.azW)}</title></rect>`;
      if (v.az != null) g += `<circle class="dot" cx="${x0}" cy="${y(v.az)}" r="4"><title>Gesamt ${wpFmt(v.az)}</title></circle>`;
      const cur = m.date.getFullYear() === now.getFullYear() && m.date.getMonth() === now.getMonth();
      g += `<text x="${x0}" y="${H - 9}" text-anchor="middle">${WPJAZ_MONTHS[m.date.getMonth()]}${cur ? '*' : ''}</text>`;
    });
    const sl = (val, cl, txt) =>
      `<line class="${cl}" x1="${L}" x2="${W - R}" y1="${y(val)}" y2="${y(val)}"/>` +
      `<text class="${cl}t" x="${W - R}" y="${y(val) - 4}" text-anchor="end">${txt}</text>`;
    g += sl(c.scop35, 's35', `SCOP 35 °C ${wpFmt(c.scop35)}`);
    g += sl(c.scop55, 's55', `SCOP 55 °C ${wpFmt(c.scop55)}`);
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg>`;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const c = this._config;
    const now = new Date();
    const stats = this._stats || [];
    const active = stats.filter((m) => m.qH + m.qW >= c.min_kwh);

    const sy = now.getMonth() + 1 >= c.season_start_month ? now.getFullYear() : now.getFullYear() - 1;
    const seasonStart = new Date(sy, c.season_start_month - 1, 1);
    const seasonLbl = c.season_start_month === 1 ? `${sy}` : `${sy}/${String(sy + 1).slice(2)}`;
    const season = this._agg(stats.filter((m) => m.date >= seasonStart));
    const year = this._agg(stats.filter((m) => m.date.getFullYear() === now.getFullYear()));
    const r12 = this._agg(stats.filter((m) => m.date >= new Date(now.getFullYear(), now.getMonth() - 11, 1)));
    const curM = stats.find((m) => m.date.getFullYear() === now.getFullYear() && m.date.getMonth() === now.getMonth());
    const life = this._life();

    const vR12 = this._vals(r12);
    const vSeason = this._vals(season);
    const vLife = this._vals(life);
    const vCur = curM ? this._vals(curM) : this._vals({ qH: null, qW: null, eH: null, eW: null });
    const first = active.length ? active[0].date : null;
    const firstLbl = first ? `${WPJAZ_MONTHS[first.getMonth()]} ${first.getFullYear()}` : '–';

    if (!window.wpEffizienzModel && !this._mdlRetry) this._mdlRetry = setTimeout(() => { this._mdlRetry = null; if (window.wpEffizienzModel) this._render(); }, 1500);
    const model = this._modelAz(stats.filter((m) => m.date >= seasonStart));
    const mDiff = model != null && vSeason.azH != null ? (vSeason.azH / model - 1) * 100 : null;
    const diff = vSeason.azH != null && c.scop35 ? ((vSeason.azH / c.scop35 - 1) * 100) : null;
    const scopCls = vSeason.azH == null ? '' : vSeason.azH >= c.scop35 ? 'good' : vSeason.azH >= c.scop55 ? 'ok' : 'bad';

    const tiles = `
      <div class="tile">
        <div class="lbl">JAZ gleitend 12 Monate</div>
        <div class="big ${wpCls(vR12.az)}">${wpFmt(vR12.az)}</div>
        <div class="sub">Heizen ${wpFmt(vR12.azH)} · Warmwasser ${wpFmt(vR12.azW)}</div>
        ${r12.n < 12 ? `<div class="badge">vorläufig: ${r12.n} von 12 Monaten</div>` : '<div class="badge okb">vollständiges Jahr</div>'}
      </div>
      <div class="tile">
        <div class="lbl">SCOP-Vergleich Heizperiode ${seasonLbl}</div>
        <div class="big ${scopCls}">${wpFmt(vSeason.azH)}</div>
        <div class="sub">nur Heizen · Datenblatt ${wpFmt(c.scop35)} (35 °C)${diff == null ? '' : ` · ${diff >= 0 ? '+' : ''}${wpFmt(diff, 0)} %`}</div>
        ${model == null ? '' : `<div class="sub">Rechner-Modell ${wpFmt(model)}${mDiff == null ? '' : ` · gemessen ${mDiff >= 0 ? '+' : ''}${wpFmt(mDiff, 0)} %`}</div>`}
      </div>
      <div class="tile">
        <div class="lbl">Seit Inbetriebnahme</div>
        <div class="big ${wpCls(vLife.az)}">${wpFmt(vLife.az)}</div>
        <div class="sub">Heizen ${wpFmt(vLife.azH)} · Warmwasser ${wpFmt(vLife.azW)}</div>
        <div class="sub">${wpFmt(vLife.q, 0)} kWh Wärme / ${wpFmt(vLife.e, 0)} kWh Strom</div>
      </div>
      <div class="tile">
        <div class="lbl">${WPJAZ_MONTHS[now.getMonth()]} ${now.getFullYear()} (laufend)</div>
        <div class="big ${wpCls(vCur.az)}">${wpFmt(vCur.az)}</div>
        <div class="sub">Heizen ${wpFmt(vCur.azH)} · Warmwasser ${wpFmt(vCur.azW)}</div>
      </div>`;

    let body;
    if (this._error) {
      body = `<div class="err">Statistik konnte nicht geladen werden: ${wpEsc(this._error)}</div>`;
    } else if (!this._stats) {
      body = `<div class="sub pad">Lade Langzeitstatistik …</div>`;
    } else {
      const monthRows = active
        .slice()
        .reverse()
        .map((m) => {
          const cur = m.date.getFullYear() === now.getFullYear() && m.date.getMonth() === now.getMonth();
          return this._row(`${WPJAZ_MONTHS[m.date.getMonth()]} ${String(m.date.getFullYear()).slice(2)}${cur ? '*' : ''}`, m);
        })
        .join('');
      const chartRows = active.slice(-12);
      body = `
        <div class="sec">Monatliche Arbeitszahl</div>
        <div class="chart">${this._chart(chartRows)}</div>
        <div class="legend">
          <span><i class="lh"></i>Heizen</span><span><i class="lw"></i>Warmwasser</span>
          <span><i class="ld"></i>Gesamt</span><span><i class="l35"></i>SCOP-Datenblatt</span>
        </div>
        <div class="sec">Auflistung</div>
        <div class="scroll"><table>
          <thead><tr><th>Zeitraum</th><th>Ø °C</th><th>Wärme kWh</th><th>Strom kWh</th><th>AZ Heizen</th><th>AZ WW</th><th>AZ gesamt</th></tr></thead>
          <tbody>
            ${monthRows || '<tr><td colspan="7">Noch keine Monatswerte</td></tr>'}
            <tr class="sep"><td colspan="7"></td></tr>
            ${this._row(`Heizperiode ${seasonLbl}`, season, 'sum')}
            ${this._row(`Jahr ${now.getFullYear()}`, year, 'sum')}
            ${this._row('Gleitend 12 Monate', r12, 'sum')}
            ${this._row(`Seit Inbetriebnahme`, life, 'sum')}
          </tbody>
        </table></div>
        <div class="note">
          * laufender Monat · Daten ab ${firstLbl} · Heizperiode ab 1. ${WPJAZ_MONTHS[c.season_start_month - 1]}<br>
          <b>JAZ</b> = Wärme ÷ Strom über 12 Monate, inkl. Warmwasser und Heizstab.
          <b>SCOP</b> ist ein Normwert (EN 14825, mittleres Klima, nur Raumheizung). Vergleichbar ist deshalb die gemessene
          Arbeitszahl <i>Heizen</i> über die Heizperiode: mit Fußbodenheizung gegen den Wert bei 35 °C.<br>
          <b>Rechner-Modell</b>: Arbeitszahl, die der Effizienz-Rechner für die monatlichen Außentemperaturen der Heizperiode berechnet (mit deinen Reglerwerten, gewichtet mit der gemessenen Wärme). Weicht die Messung deutlich ab, hilft im Rechner der Regler „Zusätzlicher COP-Abfall über 35 °C“ und die Prüfung von Heizlast und Vorlauf.<br>
          Grundlage sind die internen Energiezähler der Wärmepumpe (EMS-ESP), kein geeichter Wärmemengen- oder Stromzähler.
          Hilfsenergie wie Pumpen und Standby ist darin evtl. nicht vollständig enthalten, die reale JAZ liegt dann etwas niedriger.
        </div>`;
    }

    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 16px; }
        .wrap { max-width: 1100px; margin: 0 auto; }
        h2 { margin: 0; font-size: 1.2rem; font-weight: 500; }
        .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin: 14px 0 6px; }
        .tile { background: var(--secondary-background-color); border-radius: 12px; padding: 12px 14px; }
        .lbl { font-size: .72rem; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .04em; }
        .big { font-size: 2.1rem; font-weight: 600; line-height: 1.15; margin: 4px 0 2px; }
        .sub { font-size: .8rem; color: var(--secondary-text-color); }
        .pad { padding: 12px 0; }
        .badge { display: inline-block; margin-top: 6px; font-size: .7rem; padding: 2px 8px; border-radius: 10px;
                 background: rgba(255,152,0,.15); color: var(--warning-color, #ff9800); }
        .badge.okb { background: rgba(76,175,80,.15); color: var(--success-color, #4caf50); }
        .good { color: var(--success-color, #4caf50); }
        .ok { color: var(--warning-color, #ff9800); }
        .bad { color: var(--error-color, #f44336); }
        .sec { margin: 18px 0 6px; font-size: .85rem; font-weight: 500; color: var(--primary-text-color); }
        .chart svg { width: 100%; height: auto; max-height: 280px; display: block; }
        svg text { fill: var(--secondary-text-color); font-size: 11px; }
        svg .grid { stroke: var(--divider-color); stroke-width: 1; }
        svg .bh { fill: #ff8a3d; }
        svg .bw { fill: #2ec4b6; }
        svg .dot { fill: var(--primary-text-color); stroke: var(--card-background-color); stroke-width: 2; }
        svg .s35 { stroke: #8bc34a; stroke-dasharray: 6 4; stroke-width: 1.5; }
        svg .s55 { stroke: #9e9e9e; stroke-dasharray: 3 4; stroke-width: 1.2; }
        svg .s35t { fill: #8bc34a; font-size: 10px; }
        svg .s55t { fill: #9e9e9e; font-size: 10px; }
        .legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: .75rem; color: var(--secondary-text-color); margin-top: 4px; }
        .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
        .lh { background: #ff8a3d; } .lw { background: #2ec4b6; }
        .ld { background: var(--primary-text-color); border-radius: 50% !important; }
        .l35 { background: #8bc34a; height: 2px !important; vertical-align: 3px !important; }
        .scroll { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; font-size: .84rem; white-space: nowrap; }
        th, td { padding: 6px 8px; text-align: right; border-bottom: 1px solid var(--divider-color); }
        th { font-weight: 500; color: var(--secondary-text-color); font-size: .75rem; }
        th:first-child, td:first-child { text-align: left; }
        td.az { font-weight: 600; }
        tr.sep td { border: none; height: 6px; padding: 0; }
        tr.sum td { background: var(--secondary-background-color); font-weight: 500; }
        .note { font-size: .74rem; color: var(--secondary-text-color); margin-top: 12px; line-height: 1.5; }
        .err { color: var(--error-color, #f44336); padding: 12px 0; }
      </style>
      <ha-card>
        <div class="wrap">
          <h2>${wpEsc(c.title)}</h2>
          <div class="tiles">${tiles}</div>
          ${body}
        </div>
      </ha-card>`;
  }
}

if (!customElements.get('wp-jaz-card')) customElements.define('wp-jaz-card', WpJazCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((x) => x.type === 'wp-jaz-card')) {
  window.customCards.push({
    type: 'wp-jaz-card',
    name: 'WP Jahresarbeitszahl & SCOP',
    description: 'JAZ, Monatsarbeitszahlen und SCOP-Vergleich aus der Langzeitstatistik (EMS-ESP).',
  });
}
console.info(`%c WP-JAZ-CARD %c ${WPJAZ_VERSION} `, 'background:#ff8a3d;color:#000', 'background:#333;color:#fff');
