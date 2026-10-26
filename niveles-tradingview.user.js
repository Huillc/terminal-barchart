// ==UserScript==
// @name         Niveles Gamma → TradingView (puente)
// @namespace    terminal-barchart
// @version      1.1
// @description  Calcula flip, muro, imán y max pain de DIA/QQQ/GLD desde Barchart (mapa Semana = igual a Barchart, y Estructural 1–45 días), los convierte a tu CFD y los dibuja solos en TradingView. Funciona en PC y en Firefox del celular.
// @match        https://www.barchart.com/*
// @match        https://www.tradingview.com/*
// @match        https://*.tradingview.com/*
// @updateURL    https://raw.githubusercontent.com/Huillc/terminal-barchart/main/niveles-tradingview.user.js
// @downloadURL  https://raw.githubusercontent.com/Huillc/terminal-barchart/main/niveles-tradingview.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  if (window.top !== window.self) return;

  // ───────────────────────── configuración ─────────────────────────
  const ACTIVOS = {
    // idx = respaldo en Barchart cuando el escáner de TradingView no da el CFD (pasa con NAS100)
    DIA: { cfd: 'OANDA:US30USD',   idx: '$DOWI',   nombre: 'US30',   dec: 0 },
    QQQ: { cfd: 'OANDA:NAS100USD', idx: '$IUXX',   nombre: 'NAS100', dec: 0 },
    GLD: { cfd: 'OANDA:XAUUSD',    idx: '^XAUUSD', nombre: 'ORO',    dec: 1 },
  };
  const PAUSA_MS = 2000;            // regla: nunca más de 1 pedido cada 1–2 s a Barchart
  const CICLO_ABIERTO_MS = 5 * 60e3; // recalcular cada 5 min con mercado abierto
  const CICLO_CERRADO_MS = 30 * 60e3;
  const DIAS_ESTR = 45;              // mapa estructural: vencimientos de 1 a 45 días
  const R = 0.04;

  const gmGet = (k, d) => { try { const v = GM_getValue(k); return v === undefined ? d : v; } catch (e) { return d; } };
  const gmSet = (k, v) => { try { GM_setValue(k, v); } catch (e) {} };
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  // ───────────────────────── reloj Nueva York ─────────────────────────
  function ny() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const hh = +p.hour % 24, mm = +p.minute;
    return { dia: `${p.year}-${p.month}-${p.day}`, min: hh * 60 + mm, sem: p.weekday };
  }
  const mercadoAbierto = () => { const t = ny(); return !/Sat|Sun/.test(t.sem) && t.min >= 570 && t.min < 960; };
  const dte = (venc, hoy) => Math.round((Date.parse(venc + 'T12:00:00Z') - Date.parse(hoy + 'T12:00:00Z')) / 864e5);
  const esMensual = (venc) => { const d = new Date(venc + 'T12:00:00Z'); return d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21; };

  // ───────────────────────── matemática ─────────────────────────
  const npdf = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  function bsGamma(S, K, T, s) {
    if (!(T > 0) || !(s > 0) || !(S > 0)) return 0;
    const d1 = (Math.log(S / K) + (R + s * s / 2) * T) / (s * Math.sqrt(T));
    return npdf(d1) / (S * s * Math.sqrt(T));
  }
  const ivDe = (x) => (x.volatility > 3 ? x.volatility / 100 : x.volatility);

  // Mapa de gamma con la misma convención que tus terminales (call − put:
  // supone clientes que venden calls y compran puts).
  function mapa(filas, S, hoy) {
    const f = filas.filter((x) => x.openInterest > 0);
    if (!f.length) return null;
    const net = {};
    for (const x of f) net[x.strikePrice] = (net[x.strikePrice] || 0) + (x.gamma || 0) * x.openInterest * 100 * S * (x.optionType === 'Call' ? 1 : -1);
    const L = Object.entries(net).map(([k, v]) => [+k, v]);
    const muro = L.reduce((a, b) => (b[1] > (a ? a[1] : 0) ? b : a), null);
    const iman = L.reduce((a, b) => (b[1] < (a ? a[1] : 0) ? b : a), null);
    // flip: precio hipotético donde la gamma total cambia de signo (se reprecia la cadena)
    const tot = (s) => { let t = 0; for (const x of f) t += bsGamma(s, x.strikePrice, Math.max(1, dte(x.expirationDate, hoy)) / 365, ivDe(x)) * x.openInterest * (x.optionType === 'Call' ? 1 : -1); return t; };
    let flip = null, prev = null;
    for (let s = S * 0.95; s <= S * 1.05; s += S * 0.0005) {
      const v = tot(s);
      if (prev && (prev[1] < 0) !== (v < 0) && v !== prev[1]) {
        const c = prev[0] + (0 - prev[1]) / (v - prev[1]) * (s - prev[0]);
        if (flip === null || Math.abs(c - S) < Math.abs(flip - S)) flip = c;
      }
      prev = [s, v];
    }
    const vencs = [...new Set(f.map((x) => x.expirationDate))].sort();
    return {
      vencs, oi: f.reduce((a, x) => a + x.openInterest, 0),
      flip: flip == null ? null : +flip.toFixed(2),
      muro: muro ? muro[0] : null, iman: iman ? iman[0] : null,
    };
  }

  // Max pain de UN vencimiento (como lo publica Barchart, no sumando varios)
  function maxPain(filas, S) {
    const C = {}, P = {};
    for (const x of filas) { if (!(x.openInterest > 0)) continue; const d = x.optionType === 'Call' ? C : P; d[x.strikePrice] = (d[x.strikePrice] || 0) + x.openInterest; }
    const ks = [...new Set([...Object.keys(C), ...Object.keys(P)].map(Number))].filter((k) => Math.abs(k / S - 1) < 0.08).sort((a, b) => a - b);
    let best = null;
    for (const s of ks) {
      let t = 0;
      for (const k in C) if (+k < s) t += (s - k) * C[k];
      for (const k in P) if (+k > s) t += (k - s) * P[k];
      if (!best || t < best[1]) best = [s, t];
    }
    return best ? best[0] : null;
  }

  // ═════════════════════════ LADO BARCHART ═════════════════════════
  if (/barchart\.com$/.test(location.hostname)) {
    const xsrf = () => decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '');
    async function api(path, params) {
      const r = await fetch(path + '?' + new URLSearchParams(params), { headers: { 'x-xsrf-token': xsrf(), accept: 'application/json' }, credentials: 'include' });
      if (!r.ok) throw new Error('Barchart respondió ' + r.status);
      return r.json();
    }

    async function cadena(sym, hoy) {
      let all = [];
      for (let pg = 1; pg <= 12; pg++) {
        const j = await api('/proxies/core-api/v1/options/get', {
          symbol: sym, fields: 'strikePrice,optionType,openInterest,gamma,volatility,expirationDate',
          orderBy: 'daysToExpiration', orderDir: 'asc', limit: 1000, page: pg, raw: 1,
        });
        const d = (j.data || []).map((x) => x.raw || x);
        all = all.concat(d);
        await dormir(PAUSA_MS);
        if (d.length < 1000 || dte(d[d.length - 1].expirationDate, hoy) > DIAS_ESTR) break;
      }
      return all;
    }

    async function precioCFD() {
      const out = {};
      try {
        const r = await fetch('https://scanner.tradingview.com/cfd/scan', { method: 'POST', body: JSON.stringify({ symbols: { tickers: Object.values(ACTIVOS).map((a) => a.cfd) }, columns: ['close'] }) });
        const j = await r.json();
        for (const x of j.data || []) out[x.s] = x.d[0];
      } catch (e) {}
      return out;
    }

    async function calcular() {
      const t = ny(), hoy = t.dia;
      // con mercado abierto el vencimiento de hoy cuenta (como hace Barchart); después del cierre, no
      const minD = mercadoAbierto() ? 0 : 1;
      const q = await api('/proxies/core-api/v1/quotes/get', { symbols: Object.keys(ACTIVOS).concat(Object.values(ACTIVOS).map((a) => a.idx)).join(','), fields: 'symbol,lastPrice', raw: 1 });
      await dormir(PAUSA_MS);
      const spot = {};
      for (const x of q.data || []) { const r = x.raw || x; spot[r.symbol] = r.lastPrice; }
      const cfd = await precioCFD();
      const items = {};
      for (const sym of Object.keys(ACTIVOS)) {
        const S = spot[sym];
        if (!(S > 0)) { items[sym] = { error: 'sin precio de ' + sym }; continue; }
        try {
          const ch = await cadena(sym, hoy);
          const ex = [...new Set(ch.map((x) => x.expirationDate))].sort().filter((v) => dte(v, hoy) >= minD);
          const semV = ex.slice(0, 4);
          const estV = ex.filter((v) => dte(v, hoy) <= DIAS_ESTR && dte(v, hoy) >= 1);
          const sem = mapa(ch.filter((x) => semV.includes(x.expirationDate)), S, hoy);
          const est = mapa(ch.filter((x) => estV.includes(x.expirationDate)), S, hoy);
          const vCerca = ex[0], vMens = ex.find((v) => esMensual(v));
          const a = ACTIVOS[sym], cReal = cfd[a.cfd], cIdx = spot[a.idx];
          const c = cReal || cIdx || null;
          items[sym] = {
            spot: S, cfdSym: a.cfd, nombre: a.nombre, dec: a.dec,
            cfd: c, fuenteCfd: cReal ? 'CFD OANDA' : (cIdx ? 'índice ' + a.idx + ' (aprox.)' : null),
            ratio: c ? c / S : null,
            semana: sem, estructural: est,
            maxPain: {
              cercano: vCerca ? { venc: vCerca, strike: maxPain(ch.filter((x) => x.expirationDate === vCerca), S) } : null,
              mensual: vMens ? { venc: vMens, strike: maxPain(ch.filter((x) => x.expirationDate === vMens), S) } : null,
            },
          };
        } catch (e) { items[sym] = { error: String(e.message || e) }; }
      }
      const data = { t: Date.now(), hora: new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' }), items };
      gmSet('ng_data', data);
      return data;
    }

    // ── franja en pantalla (PC y celular) ──
    const host = document.createElement('div');
    host.id = 'ng-host';
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483646;';
    const sh = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
    const f = (v, d) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d }));

    function pintar(data, estado) {
      const abierto = gmGet('ng_abierto', true);
      let h = `<style>
        :host{all:initial}
        .b{font:12px/1.35 system-ui,Segoe UI,Arial,sans-serif;background:#0b0f14ee;color:#d8dee9;border-top:1px solid #2b3b4e;padding:6px 10px;max-height:45vh;overflow:auto}
        .top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        .top b{color:#fff}.m{color:#7f93a8}
        button{background:#1b2735;color:#d8dee9;border:1px solid #2b3b4e;border-radius:6px;padding:3px 9px;font:inherit;cursor:pointer}
        .g{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
        .c{flex:1;min-width:260px;background:#111821;border:1px solid #1e2a36;border-radius:8px;padding:6px 8px}
        .c h4{margin:0 0 4px;font-size:13px;color:#8fb3ff;display:flex;justify-content:space-between;gap:6px}
        table{border-collapse:collapse;width:100%}td{padding:1px 4px;text-align:right;white-space:nowrap}td:first-child{text-align:left;color:#7f93a8}
        .fl{color:#ffd166}.mu{color:#3ddc84}.im{color:#ff5c6c}.mp{color:#b9c4d0}
        .pos{color:#3ddc84}.neg{color:#ff5c6c}
      </style><div class="b"><div class="top"><b>🧲 Niveles gamma → CFD</b><span class="m">${data ? 'calculado ' + data.hora + ' (Lima)' : ''} ${estado || ''}</span><span style="flex:1"></span><button id="ac">↻</button><button id="tg">${abierto ? '▾ ocultar' : '▴ niveles'}</button></div>`;
      if (abierto && data) {
        h += '<div class="g">';
        for (const sym of Object.keys(ACTIVOS)) {
          const it = data.items[sym];
          if (!it || it.error) { h += `<div class="c"><h4>${sym}</h4><span class="neg">${it ? it.error : 'sin datos'}</span></div>`; continue; }
          const k = it.ratio, d = it.dec, cv = (x) => (k && x != null ? f(x * k, d) : '—');
          const s = it.semana || {}, e = it.estructural || {};
          const reg = s.flip ? (it.spot > s.flip ? '<span class="pos">sobre el flip: gamma + (frena)</span>' : '<span class="neg">bajo el flip: gamma − (acelera)</span>') : '';
          h += `<div class="c"><h4><span>${it.nombre} ${it.cfd ? f(it.cfd, d) : ''} <span class="m" style="font-size:10px">${it.fuenteCfd || ''}</span></span><span class="m">${sym} ${f(it.spot, 2)}</span></h4>
            <div style="margin-bottom:3px">${reg}</div>
            <table><tr><td></td><td>Semana <span class="m">(= Barchart)</span></td><td>Estructural <span class="m">(1–45 d)</span></td></tr>
            <tr><td class="fl">Flip</td><td class="fl">${cv(s.flip)}</td><td class="fl">${cv(e.flip)}</td></tr>
            <tr><td class="mu">Muro</td><td class="mu">${cv(s.muro)}</td><td class="mu">${cv(e.muro)}</td></tr>
            <tr><td class="im">Imán*</td><td class="im">${cv(s.iman)}</td><td class="im">${cv(e.iman)}</td></tr>
            <tr><td class="mp">Max pain</td><td class="mp">${it.maxPain.cercano ? cv(it.maxPain.cercano.strike) + ' <span class="m">' + it.maxPain.cercano.venc.slice(5) + '</span>' : '—'}</td><td class="mp">${it.maxPain.mensual ? cv(it.maxPain.mensual.strike) + ' <span class="m">' + it.maxPain.mensual.venc.slice(5) + '</span>' : '—'}</td></tr>
            <tr><td class="m">ETF</td><td class="m">${f(s.flip, 2)} · ${f(s.muro, 2)} · ${f(s.iman, 2)}</td><td class="m">${f(e.flip, 2)} · ${f(e.muro, 2)} · ${f(e.iman, 2)}</td></tr></table></div>`;
        }
        h += '</div><div class="m" style="margin-top:4px">*Imán = strike con la gamma neta más negativa. Que "atraiga" el precio NO está probado. Convertido con la relación en vivo CFD/ETF. No es señal de entrada.</div>';
      }
      h += '</div>';
      sh.innerHTML = h;
      sh.getElementById('tg').onclick = () => { gmSet('ng_abierto', !gmGet('ng_abierto', true)); pintar(gmGet('ng_data', null)); };
      sh.getElementById('ac').onclick = () => ciclo(true);
    }

    let corriendo = false;
    async function ciclo(forzar) {
      if (corriendo) return;
      const d = gmGet('ng_data', null);
      const ttl = mercadoAbierto() ? CICLO_ABIERTO_MS : CICLO_CERRADO_MS;
      // candado: si otra pestaña de Barchart ya está calculando o calculó hace poco, no pedir de nuevo
      const lock = gmGet('ng_lock', 0);
      if (!forzar && ((d && Date.now() - d.t < ttl) || Date.now() - lock < 3 * 60e3)) { pintar(d); return; }
      corriendo = true; gmSet('ng_lock', Date.now());
      pintar(d, '· calculando…');
      try { pintar(await calcular()); }
      catch (e) { pintar(d, '· ⚠ ' + (e.message || e)); }
      finally { corriendo = false; gmSet('ng_lock', 0); }
    }
    pintar(gmGet('ng_data', null));
    setTimeout(() => ciclo(false), 4000);
    setInterval(() => ciclo(false), 60e3);
    return;
  }

  // ═════════════════════════ LADO TRADINGVIEW ═════════════════════════
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const ETF_DE = (sym) => {
    const s = String(sym || '').toUpperCase();
    if (/XAU|GOLD|GLD/.test(s)) return 'GLD';
    if (/NAS100|US100|NDX|NQ1|QQQ|IUXX/.test(s)) return 'QQQ';
    if (/US30|DJI|DOW|YM1|DIA/.test(s)) return 'DIA';
    return null;
  };
  const ESTILO = {
    // Semana: línea continua · Estructural: punteada
    flip: { col: '#ffd166' }, muro: { col: '#2fbf71' }, iman: { col: '#ff5c6c' }, mp: { col: '#9aa7b4' },
  };
  const idsGuardados = () => { try { return JSON.parse(localStorage.getItem('ng_ids') || '{}'); } catch (e) { return {}; } };
  const guardarIds = (o) => { try { localStorage.setItem('ng_ids', JSON.stringify(o)); } catch (e) {} };
  let ultimaFirma = '';

  async function dibujar(forzar) {
    const api = W.TradingViewApi;
    if (!api || !api.activeChart) return;
    let ch; try { ch = api.activeChart(); } catch (e) { return; }
    const sym = ch.symbol();
    const etf = ETF_DE(sym);
    const data = gmGet('ng_data', null);
    if (!etf || !data || !data.items[etf] || data.items[etf].error) return;
    const it = data.items[etf];
    // v1.1: si el gráfico ES el ETF (QQQ, DIA, GLD de cualquier bolsa) los niveles van tal cual;
    // si es el CFD/índice, se convierten con la relación en vivo CFD/ETF.
    const esEtf = String(sym).split(':').pop().toUpperCase() === etf;
    if (!esEtf && !it.ratio) return;
    const k = esEtf ? 1 : it.ratio, dec = esEtf ? 2 : it.dec;
    const lineas = [];
    const add = (strike, tipo, mapaN, texto) => { if (strike != null && isFinite(strike)) lineas.push({ p: +(strike * k).toFixed(dec), tipo, mapaN, texto: `${texto} ${(strike * k).toFixed(dec)} (${etf} ${strike})` }); };
    const s = it.semana || {}, e = it.estructural || {};
    add(s.flip, 'flip', 'S', 'S·FLIP'); add(s.muro, 'muro', 'S', 'S·MURO'); add(s.iman, 'iman', 'S', 'S·IMÁN*');
    add(e.flip, 'flip', 'E', 'E·FLIP'); add(e.muro, 'muro', 'E', 'E·MURO'); add(e.iman, 'iman', 'E', 'E·IMÁN*');
    if (it.maxPain.cercano) add(it.maxPain.cercano.strike, 'mp', 'S', 'MAXPAIN ' + it.maxPain.cercano.venc.slice(5));
    if (it.maxPain.mensual) add(it.maxPain.mensual.strike, 'mp', 'E', 'MAXPAIN ' + it.maxPain.mensual.venc.slice(5));
    const firma = sym + '|' + JSON.stringify(lineas.map((l) => l.texto));
    if (!forzar && firma === ultimaFirma) return;

    // borrar SOLO las líneas que dibujó este script en este símbolo
    const ids = idsGuardados();
    const existentes = new Set((ch.getAllShapes() || []).map((x) => String(x.id)));
    for (const id of ids[sym] || []) { if (existentes.has(String(id))) { try { ch.removeEntity(id); } catch (err) {} } }
    const nuevos = [];
    for (const l of lineas) {
      try {
        const id = await ch.createShape({ price: l.p }, {
          shape: 'horizontal_line', lock: true, disableSelection: false, disableSave: false, text: l.texto,
          overrides: {
            linecolor: ESTILO[l.tipo].col, linewidth: l.mapaN === 'S' ? 2 : 1, linestyle: l.mapaN === 'S' ? 0 : 2,
            showLabel: true, text: l.texto, textcolor: ESTILO[l.tipo].col, fontsize: 11,
            horzLabelsAlign: l.mapaN === 'S' ? 'right' : 'left', vertLabelsAlign: 'top',
          },
        });
        if (id != null) nuevos.push(id);
      } catch (err) {}
    }
    ids[sym] = nuevos; guardarIds(ids);
    ultimaFirma = firma;
  }

  try { GM_addValueChangeListener('ng_data', () => dibujar(false)); } catch (e) {}
  setInterval(() => dibujar(false), 15e3);
  setTimeout(() => dibujar(true), 8000);
})();
