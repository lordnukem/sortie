// Bits both record pages need: the API base, number and time formatting, the map, and the two
// chart shapes. Loaded as a plain script, so everything hangs off one global.
window.P = (() => {
  const API = ['sortiethegame.com', 'www.sortiethegame.com', '72.62.196.152', '127.0.0.1', 'localhost']
    .includes(location.hostname) ? '/api' : 'https://sortiethegame.com/api';

  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (Number(n) || 0).toLocaleString();

  // Durations read as time, not as a count of seconds: 4,512 tells you nothing at a glance.
  const dur = (s) => {
    s = Math.max(0, Math.round(Number(s) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
  };
  const when = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(+d) ? '—' : d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  };

  // Country centroids, so the public map can place a country without ever being told a city.
  // Only the ones that have shown up need to exist; anything else falls through to the list.
  const CENTROID = {
    AD: [42.5, 1.6], AE: [24, 54], AF: [33, 65], AL: [41, 20], AM: [40, 45], AO: [-12.5, 18.5], AR: [-34, -64],
    AT: [47.3, 13.3], AU: [-25, 133], AZ: [40.5, 47.5], BA: [44, 18], BD: [24, 90], BE: [50.8, 4.5], BG: [43, 25],
    BH: [26, 50.5], BN: [4.5, 114.7], BO: [-17, -65], BR: [-10, -55], BY: [53, 28], CA: [60, -96], CH: [47, 8],
    CL: [-30, -71], CM: [6, 12], CN: [35, 105], CO: [4, -73], CR: [10, -84], CY: [35, 33], CZ: [49.8, 15.5],
    DE: [51, 10], DK: [56, 10], DO: [19, -70.7], DZ: [28, 3], EC: [-2, -77.5], EE: [59, 26], EG: [27, 30],
    ES: [40, -4], ET: [8, 38], FI: [64, 26], FR: [46, 2], GB: [54, -2], GE: [42, 43.5], GH: [8, -2], GR: [39, 22],
    GT: [15.5, -90.3], HK: [22.3, 114.2], HR: [45.2, 15.5], HU: [47, 20], ID: [-5, 120], IE: [53, -8],
    IL: [31.5, 34.8], IN: [21, 78], IQ: [33, 44], IR: [32, 53], IS: [65, -18], IT: [42.8, 12.8], JO: [31, 36],
    JP: [36, 138], KE: [1, 38], KH: [13, 105], KR: [37, 127.5], KW: [29.5, 47.8], KZ: [48, 68], LA: [18, 105],
    LB: [33.8, 35.8], LK: [7, 81], LT: [56, 24], LU: [49.8, 6.1], LV: [57, 25], MA: [32, -5], MD: [47, 29],
    ME: [42.5, 19.3], MK: [41.6, 21.7], MM: [22, 98], MN: [46, 105], MO: [22.2, 113.5], MT: [35.9, 14.4],
    MU: [-20.3, 57.6], MV: [3.2, 73], MX: [23, -102], MY: [2.5, 112.5], MZ: [-18, 35], NG: [10, 8],
    NL: [52.5, 5.75], NO: [62, 10], NP: [28, 84], NZ: [-41, 174], OM: [21, 57], PA: [9, -80], PE: [-10, -76],
    PH: [13, 122], PK: [30, 70], PL: [52, 20], PR: [18.2, -66.5], PT: [39.5, -8], PY: [-23, -58], QA: [25.3, 51.2],
    RO: [46, 25], RS: [44, 21], RU: [60, 100], SA: [25, 45], SE: [62, 15], SG: [1.36, 103.8], SI: [46.1, 14.8],
    SK: [48.7, 19.5], SN: [14, -14], SV: [13.8, -88.9], TH: [15, 100], TN: [34, 9], TR: [39, 35], TT: [10.5, -61.3],
    TW: [23.5, 121], TZ: [-6, 35], UA: [49, 32], UG: [1, 32], US: [39.8, -98.6], UY: [-33, -56], UZ: [41, 64],
    VE: [8, -66], VN: [16, 106], ZA: [-29, 24], ZW: [-19, 30],
  };

  // Equirectangular, matching the baked outline's 360x180 viewBox.
  const xy = (lat, lon) => [Number(lon) + 180, 90 - Number(lat)];

  // `places` is [{ lat, lon, n, label }]. Radius grows with the square root of the count, so
  // ten runs looks like more than one without a hundred swallowing the map.
  function drawMap(el, places) {
    const max = Math.max(1, ...places.map((p) => p.n || 1));
    const grat = [];
    for (let lon = -180; lon <= 180; lon += 30) grat.push(`M${lon + 180} 0V180`);
    for (let lat = -60; lat <= 60; lat += 30) grat.push(`M0 ${90 - lat}H360`);
    const dots = places.map((p) => {
      if (!Number.isFinite(+p.lat) || !Number.isFinite(+p.lon)) return '';
      const [x, y] = xy(p.lat, p.lon);
      const r = 1.6 + 4.4 * Math.sqrt((p.n || 1) / max);
      return `<circle class="halo" cx="${x}" cy="${y}" r="${(r * 2.1).toFixed(2)}"/>`
        + `<circle class="dot" cx="${x}" cy="${y}" r="${r.toFixed(2)}"><title>${esc(p.label)}</title></circle>`;
    }).join('');
    el.innerHTML = `<svg class="map" viewBox="0 0 360 180" role="img" aria-label="Where runs were played">
      <path class="grat" d="${grat.join('')}"/>
      <path class="land" d="${window.__WORLD || ''}"/>
      ${dots}
    </svg>`;
  }

  // A ranked list with a bar each: the shape every one of these breakdowns wants.
  function drawBars(el, rows, { key = 'k', count = 'n', empty = 'nothing yet' } = {}) {
    if (!rows || !rows.length) { el.innerHTML = `<p class="empty">${esc(empty)}</p>`; return; }
    const max = Math.max(...rows.map((r) => r[count]));
    const total = rows.reduce((a, r) => a + r[count], 0);
    el.innerHTML = '<div class="bars">' + rows.map((r) => {
      const pct = total ? Math.round((r[count] / total) * 100) : 0;
      return `<div class="bar"><span class="lbl">${esc(r[key] || 'unknown')}</span>
        <span class="track"><span class="fill" style="width:${(r[count] / max) * 100}%"></span></span>
        <span class="n">${num(r[count])} · ${pct}%</span></div>`;
    }).join('') + '</div>';
  }

  function tiles(el, items) {
    el.innerHTML = items.map(([k, v, small]) =>
      `<div class="tile"><div class="k">${esc(k)}</div><div class="v${small ? ' sm' : ''}">${esc(v)}</div></div>`).join('');
  }

  return { API, $, esc, num, dur, when, CENTROID, drawMap, drawBars, tiles };
})();
