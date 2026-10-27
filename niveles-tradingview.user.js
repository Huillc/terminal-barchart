// ==UserScript==
// @name         Plan del Día + Niveles Gamma → TradingView
// @namespace    terminal-barchart
// @version      2.0
// @description  PLAN DEL DÍA en Barchart (fases por hora de Lima, modo rebote/ruptura por gamma, señales probadas: contexto 10:30 y rebote de pánico con crédito, escenarios a 200 pts, diario automático) + niveles gamma dibujados solos en TradingView. PC y Firefox del celular.
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
    let ultPedido = 0;
    async function turno() { for (;;) { const e = PAUSA_MS - (Date.now() - ultPedido); if (e <= 0) { ultPedido = Date.now(); return; } await dormir(e); } }
    async function api(path, params) {
      await turno();
      const r = await fetch(path + '?' + new URLSearchParams(params), { headers: { 'x-xsrf-token': xsrf(), accept: 'application/json' }, credentials: 'include' });
      if (!r.ok) throw new Error('Barchart respondió ' + r.status);
      return r.json();
    }
    async function serie(path, params) {
      await turno();
      const r = await fetch(path + '?' + new URLSearchParams(params), { credentials: 'include' });
      const x = await r.text(); if (x.includes('<') || x.includes('Error')) throw new Error('serie ' + params.symbol);
      return x.trim().split('\n').map((l) => l.split(','));
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

    // ── 1) MAPA DE GAMMA (única fuente para todo: plan, franja y TradingView) ──
    async function calcular() {
      const t = ny(), hoy = t.dia;
      const minD = mercadoAbierto() ? 0 : 1;   // con mercado abierto el vencimiento de hoy cuenta (como Barchart)
      const q = await api('/proxies/core-api/v1/quotes/get', { symbols: Object.keys(ACTIVOS).concat(Object.values(ACTIVOS).map((a) => a.idx)).join(','), fields: 'symbol,lastPrice', raw: 1 });
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
          const vCerca = ex[0], vMens = ex.find((v) => esMensual(v));
          const a = ACTIVOS[sym], cReal = cfd[a.cfd], cIdx = spot[a.idx];
          const c = cReal || cIdx || null;
          items[sym] = {
            spot: S, cfdSym: a.cfd, nombre: a.nombre, dec: a.dec,
            cfd: c, fuenteCfd: cReal ? 'CFD OANDA' : (cIdx ? 'índice ' + a.idx + ' (aprox.)' : null),
            ratio: c ? c / S : null,
            semana: mapa(ch.filter((x) => semV.includes(x.expirationDate)), S, hoy),
            estructural: mapa(ch.filter((x) => estV.includes(x.expirationDate)), S, hoy),
            maxPain: {
              cercano: vCerca ? { venc: vCerca, strike: maxPain(ch.filter((x) => x.expirationDate === vCerca), S) } : null,
              mensual: vMens ? { venc: vMens, strike: maxPain(ch.filter((x) => x.expirationDate === vMens), S) } : null,
            },
          };
        } catch (e) { items[sym] = { error: String(e.message || e) }; }
      }
      const data = { t: Date.now(), hora: horaLima(), items };
      gmSet('ng_data', data);
      return data;
    }

    // ── 2) DATOS DEL DÍA para el plan (precios, historia diaria, crédito, VIX) ──
    async function datosDia() {
      const t = ny();
      const q = await api('/proxies/core-api/v1/quotes/get', { symbols: 'DIA,QQQ,GLD,$VIX,HYG,LQD,YM*0,NQ*0,GC*0', fields: 'symbol,lastPrice,previousPrice,openPrice,highPrice,lowPrice,percentChange', raw: 1 });
      const Q = {}; for (const x of q.data || []) { const r = x.raw || x; Q[r.symbol] = r; }
      let eod = gmGet('ng_eod', null);
      if (!eod || eod.dia !== t.dia) {
        eod = { dia: t.dia, s: {} };
        for (const [s, n] of [['QQQ', 230], ['DIA', 30], ['GLD', 30], ['HYG', 60], ['LQD', 60]]) {
          try { eod.s[s] = (await serie('/proxies/timeseries/queryeod.ashx', { symbol: s, data: 'daily', maxrecords: n, order: 'asc', dividends: 'false', backadjust: 'false' })).filter((c) => c.length >= 6).map((c) => ({ d: c[1], h: +c[3], l: +c[4], c: +c[5] })); } catch (e) {}
        }
        gmSet('ng_eod', eod);
      }
      // 5 min de QQQ de hoy (para la entrada de contexto) — solo desde las 10:30 NY y una vez
      let barras = gmGet('ng_qqq5', null);
      if (t.min >= 630 && t.min < 960 && (!barras || barras.dia !== t.dia || (!barras.completo && t.min >= 632))) {
        try {
          const L = await serie('/proxies/timeseries/historical/queryminutes.ashx', { symbol: 'QQQ', interval: 5, maxrecords: 200, order: 'asc', volume: 'contract', dividends: 'false', backadjust: 'false' });
          const b = L.filter((c) => c.length >= 7 && c[0].startsWith(t.dia)).map((c) => ({ hm: c[0].slice(11, 16), o: +c[2], h: +c[3], l: +c[4], c: +c[5], v: +c[6] }));
          barras = { dia: t.dia, b, completo: b.some((x) => x.hm >= '10:25') };
          gmSet('ng_qqq5', barras);
        } catch (e) {}
      }
      const dd = { t: Date.now(), hora: horaLima(), Q, eod: eod.s, barras: barras && barras.dia === t.dia ? barras.b : [] };
      gmSet('ng_dia', dd);
      return dd;
    }

    // ── 3) REGLAS PROBADAS (las mismas del CLAUDE.md) ──
    const hoyNY = () => ny().dia;
    const cerrado = () => { const t = ny(); return /Sat|Sun/.test(t.sem) || t.min >= 960; };
    const sesionPrevia = (E) => !E || !E.length ? null : (E[E.length - 1].d === hoyNY() && !cerrado() ? E[E.length - 2] : E[E.length - 1]);
    const cierres = (E, live) => { let c = E.map((x) => x.c); if (E.length && E[E.length - 1].d === hoyNY()) c = c.slice(0, -1); return live ? c.concat([live]) : c; };
    function rsi2(C) { const n = C.length; let g = 0, l = 0; for (let k = n - 2; k < n; k++) { const d = C[k] - C[k - 1]; d > 0 ? (g += d) : (l -= d); } return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    // Rebote de pánico + filtro de crédito (NAS100 · 2007–2026: 607 ops, 71 %, +0,31 %/op, positiva en las 3 épocas)
    function panico(dd) {
      const E = dd.eod.QQQ, H = dd.eod.HYG, Lq = dd.eod.LQD, q = dd.Q.QQQ;
      if (!E || E.length < 205 || !H || !Lq || !q) return { estado: 'faltan datos' };
      const C = cierres(E, q.lastPrice), r = rsi2(C), sma200 = C.slice(-200).reduce((a, x) => a + x, 0) / 200;
      const rh = cierres(H, dd.Q.HYG && dd.Q.HYG.lastPrice), rl = cierres(Lq, dd.Q.LQD && dd.Q.LQD.lastPrice), n = Math.min(rh.length, rl.length);
      const ratio = rh.slice(-n).map((x, i) => x / rl.slice(-n)[i]); const sma50 = ratio.slice(-50).reduce((a, x) => a + x, 0) / 50; const cred = ratio[ratio.length - 1] / sma50 - 1;
      const ok = { rsi: r < 10, tend: q.lastPrice > sma200, cred: cred >= -0.01 };
      return { rsi: r, sma200, cred, ok, señal: ok.rsi && ok.tend && ok.cred, cerca: !ok.rsi && r < 20 && ok.tend && ok.cred, prevHigh: E[E.length - 1].d === hoyNY() ? E[E.length - 1].h : sesionPrevia(E).h };
    }
    // Entrada de contexto 10:30 NY (NAS100 · 7 años: 48 % acierto, +0,19 R · EN PRUEBA) — misma regla que el terminal
    function contexto(dd, it) {
      const t = ny(); if (cerrado()) return { estado: `se evalúa en la próxima sesión a las ${limaDeNY(630)} Lima` }; if (t.min < 630) return { estado: `se evalúa a las ${limaDeNY(630)} Lima (10:30 NY)` };
      const B = dd.barras.filter((x) => x.hm >= '09:30' && x.hm < '10:30'); const q = dd.Q.QQQ, vx = dd.Q['$VIX'];
      const E = dd.eod.QQQ; if (!q || !vx || !E || B.length < 6 || !it || !it.ratio) return { estado: 'faltan datos de 09:30–10:30' };
      const H = E.filter((x) => x.d !== t.dia).slice(-15, -1), atr = H.reduce((a, x) => a + (x.h - x.l), 0) / H.length;
      let pv = 0, vv = 0; for (const x of B) { pv += (x.h + x.l + x.c) / 3 * x.v; vv += x.v; } const vw = pv / vv;
      const fin = dd.barras.find((x) => x.hm === '10:30') || B[B.length - 1]; const c = fin.c, O = B[0].o, vc = (vx.percentChange || 0) > 1 ? vx.percentChange / 100 : vx.percentChange;
      let d = 0;
      if (c < O && c < vw && (O - c) / atr >= 0.15 && vc >= 0.03) d = -1;
      if (c > O && c > vw && (c - O) / atr >= 0.15 && vc <= -0.03) d = 1;
      if (!d) return { estado: `sin contexto claro (QQQ ${c >= O ? 'sobre' : 'bajo'} la apertura, ${c >= vw ? 'sobre' : 'bajo'} VWAP, VIX ${(vc * 100).toFixed(1)} %)` };
      const k = it.ratio, ent = c * k, ex = d < 0 ? Math.max(...B.map((x) => x.h)) * k : Math.min(...B.map((x) => x.l)) * k, buf = 0.05 * atr * k;
      const sl = d < 0 ? Math.max(ex, ent) + buf : Math.min(ex, ent) - buf, risk = Math.abs(sl - ent);
      if (risk > 0.6 * atr * k) return { estado: 'contexto claro pero el stop queda demasiado lejos (> 0,6 ATR): no se entra' };
      return { señal: true, d, ent, sl, tp: ent + d * 2 * risk, risk };
    }

    // ── 4) ESCENARIOS (EN PRUEBA): niveles clave + objetivo 200 pts o el siguiente nivel ──
    const PASO = { DIA: { stop: 100, obj: 200, u: 'pts' }, QQQ: { stop: 100, obj: 200, u: 'pts' }, GLD: { stop: 10, obj: 20, u: '$' } };
    function niveles(sym, it, dd) {
      const k = it.ratio, s = it.semana || {}, e = it.estructural || {}, E = (dd.eod || {})[sym] || [];
      const prev = sesionPrevia(E);
      const L = [];
      const add = (v, n) => { if (v != null && isFinite(v)) L.push({ v: v * k, n }); };
      add(s.flip, 'flip'); add(s.muro, 'muro'); add(s.iman, 'imán*'); add(e.muro, 'muro mensual'); add(it.maxPain.cercano && it.maxPain.cercano.strike, 'max pain');
      if (prev) { add(prev.h, 'máx. ayer'); add(prev.l, 'mín. ayer'); }
      // juntar niveles a menos de 15 % del stop entre sí (evita etiquetas encimadas)
      const p = PASO[sym], tol = p.stop * 0.15, M = [];
      for (const x of L.sort((a, b) => a.v - b.v)) { const u = M[M.length - 1]; if (u && x.v - u.v < tol) { u.n += ' + ' + x.n; } else M.push({ ...x }); }
      return M;
    }
    function escenarios(sym, it, dd) {
      const px = it.cfd, p = PASO[sym], N = niveles(sym, it, dd), s = it.semana || {};
      if (!px || !N.length) return null;
      const arriba = N.filter((x) => x.v > px), abajo = N.filter((x) => x.v < px).reverse();
      const modo = s.flip ? (it.spot >= s.flip ? 'REBOTE' : 'RUPTURA') : null;
      const R1 = arriba[0], R2 = arriba[1], S1 = abajo[0], S2 = abajo[1], out = [];
      const obj = (desde, lado, sig) => { const tope = desde + lado * p.obj; return sig && (lado > 0 ? sig.v < tope : sig.v > tope) ? { v: sig.v, n: sig.n } : { v: tope, n: p.obj + ' ' + p.u }; };
      if (modo === 'RUPTURA') {
        if (R1) { const o = obj(R1.v, 1, R2); out.push({ lado: 1, txt: `COMPRA si una vela de 5 min cierra sobre ${R1.n}`, gat: R1.v, sl: R1.v - p.stop, tp: o.v, tpN: o.n }); }
        if (S1) { const o = obj(S1.v, -1, S2); out.push({ lado: -1, txt: `VENTA si una vela de 5 min cierra bajo ${S1.n}`, gat: S1.v, sl: S1.v + p.stop, tp: o.v, tpN: o.n }); }
      } else if (modo === 'REBOTE') {
        if (R1) { const o = obj(R1.v, -1, S1); out.push({ lado: -1, txt: `VENTA si toca ${R1.n} y la vela de 5 min cierra debajo (rechazo)`, gat: R1.v, sl: R1.v + p.stop, tp: o.v, tpN: o.n }); }
        if (S1) { const o = obj(S1.v, 1, R1); out.push({ lado: 1, txt: `COMPRA si toca ${S1.n} y la vela de 5 min cierra encima (rechazo)`, gat: S1.v, sl: S1.v - p.stop, tp: o.v, tpN: o.n }); }
      }
      return { modo, N, out, px };
    }

    // ── 5) DIARIO: cada señal se anota y se mide sola ──
    function anotar(reg) { const D = gmGet('ng_diario', []); if (!D.some((x) => x.id === reg.id)) { D.push(reg); gmSet('ng_diario', D.slice(-500)); } }
    function evaluarDiario(dd) {
      const D = gmGet('ng_diario', []); let cambio = false; const t = ny();
      for (const x of D) {
        if (x.r != null) continue;
        if (x.tipo === 'contexto' && (x.dia < t.dia || t.min >= 960) && dd.barras.length && x.dia === t.dia) {
          const k = x.k; let r = null;
          for (const b of dd.barras.filter((b) => b.hm > '10:30')) { const h = b.h * k, l = b.l * k; if (x.d > 0 ? l <= x.sl : h >= x.sl) { r = -1; break; } if (x.d > 0 ? h >= x.tp : l <= x.tp) { r = 2; break; } }
          if (r == null) { const u = dd.barras[dd.barras.length - 1]; r = x.d * (u.c * k - x.ent) / Math.abs(x.ent - x.sl); }
          x.r = +r.toFixed(2); cambio = true;
        }
        if (x.tipo === 'panico' && x.dia < t.dia) {
          const E = (dd.eod.QQQ || []).filter((e) => e.d > x.dia); if (!E.length) continue;
          let sal = null, i = 0, prevH = x.prevHigh;
          for (const e of E) { i++; if (e.c > prevH || i >= 5) { sal = e.c; break; } prevH = e.h; }
          if (sal) { x.r = +((sal / x.ent - 1) * 100).toFixed(2); x.unid = '%'; cambio = true; }
        }
      }
      if (cambio) gmSet('ng_diario', D);
      return D;
    }

    // ── 6) PANEL "PLAN DEL DÍA" ──
    const host = document.createElement('div');
    host.id = 'ng-host';
    host.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483646;';
    const sh = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
    const f = (v, d) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d }));
    function horaLima(ms) { return new Date(ms || Date.now()).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' }); }
    function limaDeNY(minNY) {   // convierte una hora de NY a hora de Lima (cambia sola con el horario de verano)
      const now = new Date(), nyp = ny(), off = Math.round(((now.getUTCHours() * 60 + now.getUTCMinutes() - 300 + 1440) % 1440 - nyp.min) / 60) * 60;
      const m = (minNY + off + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    }
    function fase() {
      const t = ny(); if (/Sat|Sun/.test(t.sem)) return { n: 'MERCADO CERRADO', d: 'fin de semana · el plan del lunes se arma desde la madrugada' };
      if (t.min < 480) return { n: 'PREPARACIÓN', d: `armando el plan con futuros nocturnos y gamma del cierre · plan listo ${limaDeNY(480)} Lima` };
      if (t.min < 570) return { n: 'PLAN LISTO', d: `datos fuertes ${limaDeNY(510)} Lima · apertura ${limaDeNY(570)} Lima` };
      if (t.min < 630) return { n: 'APERTURA', d: `primera hora: se mide la estructura · contexto NAS100 a las ${limaDeNY(630)} Lima` };
      if (t.min < 900) return { n: 'EJECUCIÓN', d: `escenarios activos · cierre de bolsa ${limaDeNY(960)} Lima` };
      if (t.min < 960) return { n: 'CIERRE', d: `ventana del rebote de pánico (se compra al cierre, ${limaDeNY(960)} Lima)` };
      return { n: 'MERCADO CERRADO', d: 'resultados del día al diario · el plan de mañana se arma desde la madrugada' };
    }
    function pintar(estado) {
      const abierto = gmGet('ng_abierto', true), data = gmGet('ng_data', null), dd = gmGet('ng_dia', null), F = fase();
      let h = `<style>
        :host{all:initial}
        .b{font:13px/1.4 system-ui,Segoe UI,Arial,sans-serif;background:#070b10f2;color:#d8dee9;border-bottom:2px solid #2b3b4e;padding:8px 12px;max-height:72vh;overflow:auto}
        .top{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
        .top b{color:#fff;font-size:15px}.m{color:#7f93a8}.fs{padding:2px 9px;border-radius:999px;background:#1d3557;color:#cfe1ff;font-weight:700;font-size:12px}
        button{background:#1b2735;color:#d8dee9;border:1px solid #2b3b4e;border-radius:6px;padding:3px 9px;font:inherit;font-size:12px;cursor:pointer}
        .g{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
        .c{flex:1;min-width:290px;background:#0f1620;border:1px solid #1e2a36;border-radius:10px;padding:8px 10px}
        .c h4{margin:0 0 6px;font-size:14px;color:#fff;display:flex;justify-content:space-between;gap:6px}
        .modo{font-weight:800;padding:2px 8px;border-radius:6px;font-size:12px}.ru{background:#4a1520;color:#ff9aa5}.re{background:#0f3d26;color:#7dffb5}
        .sem{margin:6px 0;padding:6px 8px;border-radius:8px;border:1px solid #2a3340}.si{border-color:#2fbf71;background:#0c2a1b}.cer{border-color:#ffb84d;background:#2a2110}
        .sem b{font-size:13px}.up{color:#3ddc84}.dn{color:#ff5c6c}.am{color:#ffb84d}
        .esc{margin:4px 0;padding:5px 7px;background:#0b1118;border-left:3px solid #4c8fe0;border-radius:4px;font-size:12.5px}
        .niv{font-size:12px;color:#9fb3c8;margin-top:4px}.niv span{display:inline-block;margin:1px 8px 1px 0}
        .pr{font-size:10.5px;padding:1px 5px;border-radius:4px;background:#2a2110;color:#ffb84d;margin-left:4px}.ok{background:#0c2a1b;color:#7dffb5}
        input{width:110px;background:#0b1118;color:#fff;border:1px solid #2b3b4e;border-radius:5px;padding:2px 5px;font:inherit;font-size:12px}
      </style><div class="b"><div class="top"><b>📋 PLAN DEL DÍA</b><span class="fs">${F.n}</span><span class="m">${F.d}</span><span style="flex:1"></span><span class="m">${dd ? 'datos ' + dd.hora : ''}${data ? ' · gamma ' + data.hora : ''} ${estado || ''}</span><button id="ac">↻</button><button id="tg">${abierto ? '▴ plegar' : '▾ plan'}</button></div>`;
      if (abierto && data && dd) {
        const cap = gmGet('ng_capital', null);
        h += '<div class="g">';
        for (const sym of Object.keys(ACTIVOS)) {
          const it = data.items[sym]; if (!it || it.error) { h += `<div class="c"><h4>${ACTIVOS[sym].nombre}</h4><span class="dn">${it ? it.error : 'sin datos'}</span></div>`; continue; }
          const d = it.dec, E = escenarios(sym, it, dd), p = PASO[sym];
          h += `<div class="c"><h4><span>${it.nombre} ${f(it.cfd, d)}</span><span class="m" style="font-size:11px">${it.fuenteCfd || ''}</span></h4>`;
          if (E && E.modo) h += `<div><span class="modo ${E.modo === 'RUPTURA' ? 'ru' : 're'}">MODO ${E.modo}</span> <span class="m">${E.modo === 'RUPTURA' ? 'gamma − (bajo el flip): los movimientos se estiran · entrar a favor de la ruptura' : 'gamma + (sobre el flip): los extremos se frenan · entrar en el rechazo'}</span>${sym === 'QQQ' ? '<span class="pr ok">régimen probado</span>' : '<span class="pr">en prueba</span>'}</div>`;
          // señales probadas
          if (sym === 'QQQ') {
            const C = contexto(dd, it), Pn = panico(dd);
            if (C.señal) { h += `<div class="sem si"><b class="${C.d > 0 ? 'up' : 'dn'}">● ENTRAR · ${C.d > 0 ? 'COMPRA' : 'VENTA'} ${f(C.ent, 0)}</b> · stop ${f(C.sl, 0)} · objetivo ${f(C.tp, 0)} (2R) · riesgo ${f(C.risk, 0)} pts<br><span class="m">Entrada de contexto 10:30 NY · 7 años: 48 % acierto, +0,19 R/op</span><span class="pr">en prueba</span>${cap ? `<br><span class="m">tamaño para 0,5 %: ${f(cap * 0.005 / C.risk, 2)} USD por punto</span>` : ''}</div>`;
              anotar({ id: 'ctx_' + ny().dia, tipo: 'contexto', dia: ny().dia, d: C.d, ent: C.ent, sl: C.sl, tp: C.tp, k: it.ratio }); }
            else h += `<div class="sem"><b class="m">○ Contexto 10:30</b> <span class="m">${C.estado}</span></div>`;
            if (Pn.señal) { h += `<div class="sem si"><b class="up">● REBOTE DE PÁNICO ACTIVO</b> · comprar al cierre (${limaDeNY(955)} Lima) · salir en el primer cierre sobre ${f(Pn.prevHigh * it.ratio, 0)} o a los 5 días<br><span class="m">RSI2 ${Pn.rsi.toFixed(1)} · sobre la media de 200 · crédito sano · 2007–2026: 71 % acierto, +0,31 %/op</span><span class="pr ok">probado 19 años</span></div>`;
              if (ny().min >= 900) anotar({ id: 'pn_' + ny().dia, tipo: 'panico', dia: ny().dia, ent: dd.Q.QQQ.lastPrice, prevHigh: Pn.prevHigh }); }
            else if (Pn.rsi != null) h += `<div class="sem ${Pn.cerca ? 'cer' : ''}"><b class="${Pn.cerca ? 'am' : 'm'}">${Pn.cerca ? '◐ Pánico cerca' : '○ Rebote de pánico'}</b> <span class="m">RSI2 ${Pn.rsi.toFixed(1)} (necesita &lt; 10) · ${Pn.ok.tend ? 'sobre' : 'bajo'} media 200 · crédito ${Pn.ok.cred ? 'sano' : 'débil'} (${(Pn.cred * 100).toFixed(1)} %)</span></div>`;
          } else h += `<div class="sem"><b class="m">○ Sin señal probada para ${it.nombre}</b> <span class="m">· solo escenarios en prueba (riesgo reducido)</span></div>`;
          // escenarios
          if (E && E.out.length) {
            h += `<div class="m" style="margin-top:4px">Escenarios <span class="pr">en prueba · usar 0,25 % de riesgo</span></div>`;
            for (const x of E.out) h += `<div class="esc"><b class="${x.lado > 0 ? 'up' : 'dn'}">${x.lado > 0 ? '▲' : '▼'}</b> ${x.txt} (${f(x.gat, d)})<br><span class="m">stop ${f(x.sl, d)} · objetivo ${f(x.tp, d)} (${x.tpN}) · ${p.stop} ${p.u} de riesgo</span></div>`;
          }
          if (E) h += `<div class="niv">${E.N.map((x) => `<span${Math.abs(x.v - E.px) < p.stop ? ' style="color:#fff"' : ''}>${x.n} <b>${f(x.v, d)}</b></span>`).join('')}</div>`;
          h += '</div>';
        }
        const D = evaluarDiario(dd), hechos = D.filter((x) => x.r != null);
        const txt = (tipo) => { const H = hechos.filter((x) => x.tipo === tipo); return H.length ? `${H.length} · ${Math.round(H.filter((x) => x.r > 0).length / H.length * 100)} % ganadas · media ${(H.reduce((a, x) => a + x.r, 0) / H.length).toFixed(2)}${tipo === 'panico' ? ' %' : ' R'}` : 'aún sin resultados'; };
        h += `</div><div class="m" style="margin-top:6px">📒 Diario en vivo — contexto 10:30: ${txt('contexto')} · pánico: ${txt('panico')} · Capital para el tamaño: <input id="cap" type="number" placeholder="FALTA" value="${cap || ''}"> USD · *Imán = gamma más negativa, NO probado que atraiga. No es asesoría: datos para que decidas tú.</div>`;
      }
      h += '</div>';
      sh.innerHTML = h;
      sh.getElementById('tg').onclick = () => { gmSet('ng_abierto', !gmGet('ng_abierto', true)); pintar(); };
      sh.getElementById('ac').onclick = () => { ciclo(true); cicloDia(true); };
      const ci = sh.getElementById('cap'); if (ci) ci.onchange = () => { const v = +ci.value; gmSet('ng_capital', v > 0 ? v : null); pintar(); };
    }

    // ── 7) CICLOS (con candado entre pestañas para no duplicar pedidos) ──
    let corriendo = false, corriendoDia = false;
    async function ciclo(forzar) {
      if (corriendo) return;
      const d = gmGet('ng_data', null), ttl = mercadoAbierto() ? CICLO_ABIERTO_MS : CICLO_CERRADO_MS, lock = gmGet('ng_lock', 0);
      if (!forzar && ((d && Date.now() - d.t < ttl) || Date.now() - lock < 3 * 60e3)) return;
      corriendo = true; gmSet('ng_lock', Date.now()); pintar('· calculando gamma…');
      try { await calcular(); pintar(); } catch (e) { pintar('· ⚠ ' + (e.message || e)); } finally { corriendo = false; gmSet('ng_lock', 0); }
    }
    async function cicloDia(forzar) {
      if (corriendoDia) return;
      const t = ny(), dd = gmGet('ng_dia', null), activo = !/Sat|Sun/.test(t.sem) && t.min >= 420 && t.min < 975;
      const ttl = activo ? 60e3 : 15 * 60e3, lock = gmGet('ng_dlock', 0);
      if (!forzar && ((dd && Date.now() - dd.t < ttl) || Date.now() - lock < 50e3)) { pintar(); return; }
      corriendoDia = true; gmSet('ng_dlock', Date.now());
      try { await datosDia(); } catch (e) {} finally { corriendoDia = false; gmSet('ng_dlock', 0); pintar(); }
    }
    pintar();
    setTimeout(() => cicloDia(false), 3000);
    setTimeout(() => ciclo(false), 9000);
    setInterval(() => { cicloDia(false); ciclo(false); }, 30e3);
    try { GM_addValueChangeListener('ng_dia', (k, o, n, remoto) => { if (remoto) pintar(); }); GM_addValueChangeListener('ng_data', (k, o, n, remoto) => { if (remoto) pintar(); }); } catch (e) {}
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
