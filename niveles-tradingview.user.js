// ==UserScript==
// @name         Plan del Día + Niveles Gamma → TradingView
// @namespace    terminal-barchart
// @version      3.6
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
  const VER_DATOS = 33; // v3.3: si los datos los calculó una versión vieja (otra pestaña sin recargar), se recalculan
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
          symbol: sym, fields: 'strikePrice,optionType,openInterest,gamma,volatility,expirationDate,volume,lastPrice,bidPrice,askPrice',
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
          let ch; try { ch = await cadena(sym, hoy); } catch (e1) { await dormir(4000); ch = await cadena(sym, hoy); }   // v2.6: un reintento
          const ex = [...new Set(ch.map((x) => x.expirationDate))].sort().filter((v) => dte(v, hoy) >= minD);
          const semV = ex.slice(0, 4);
          const estV = ex.filter((v) => dte(v, hoy) <= DIAS_ESTR && dte(v, hoy) >= 1);
          const vCerca = ex[0], vMens = ex.find((v) => esMensual(v));
          // v2.4: lectura de opciones del día (contexto, NO probado) — sale de la misma cadena, sin pedidos extra
          const opc = { pcVol: null, pcOI: null, inus: null, flujo: null };
          try {
            const sum = (L, k) => L.reduce((t, x) => t + (x[k] || 0), 0);
            const cer = ch.filter((x) => dte(x.expirationDate, hoy) >= 0 && dte(x.expirationDate, hoy) <= 3);
            const cv = sum(cer.filter((x) => x.optionType === 'Call'), 'volume'), pv = sum(cer.filter((x) => x.optionType === 'Put'), 'volume');
            opc.pcVol = cv ? pv / cv : null;
            { const T = ch.filter((x) => dte(x.expirationDate, hoy) >= 0 && dte(x.expirationDate, hoy) <= DIAS_ESTR), c2 = sum(T.filter((x) => x.optionType === 'Call'), 'volume'), p2 = sum(T.filter((x) => x.optionType === 'Put'), 'volume'); opc.pcVolTot = c2 ? p2 / c2 : null; }
            const est = ch.filter((x) => dte(x.expirationDate, hoy) >= 0 && dte(x.expirationDate, hoy) <= DIAS_ESTR);
            const co = sum(est.filter((x) => x.optionType === 'Call'), 'openInterest'), po = sum(est.filter((x) => x.optionType === 'Put'), 'openInterest');
            opc.pcOI = co ? po / co : null;
            const inu = ch.filter((x) => dte(x.expirationDate, hoy) >= 0 && dte(x.expirationDate, hoy) <= 14 && (x.volume || 0) >= 500 && (x.volume || 0) >= 1.25 * (x.openInterest || 0));
            const prem = (L) => L.reduce((t, x) => t + (x.volume || 0) * (x.lastPrice || 0) * 100, 0);
            const ic = prem(inu.filter((x) => x.optionType === 'Call')), ip = prem(inu.filter((x) => x.optionType === 'Put'));
            // v3.0: lado de cada contrato (como colorea Barchart): último precio sobre el medio = comprado, bajo el medio = vendido.
            // alcista = call comprada o put vendida · bajista = put comprada o call vendida
            let ia = 0, ib = 0; const k4 = { cc: 0, cv: 0, pc: 0, pv: 0 };
            for (const x of inu) { const mid = x.bidPrice > 0 && x.askPrice > 0 ? (x.bidPrice + x.askPrice) / 2 : null; if (!mid || !(x.lastPrice > 0)) continue;
              const lado = x.lastPrice > mid * 1.001 ? 1 : x.lastPrice < mid * 0.999 ? -1 : 0, pr = (x.volume || 0) * x.lastPrice * 100, sg = (x.optionType === 'Call' ? 1 : -1) * lado;
              if (sg > 0) ia += pr; else if (sg < 0) ib += pr;
              if (lado) k4[(x.optionType === 'Call' ? 'c' : 'p') + (lado > 0 ? 'c' : 'v')] += pr; }
            opc.inus = { n: inu.length, calls: ic, puts: ip, alc: ia, baj: ib, k4 };
            if (mercadoAbierto()) {
              // v3.0: mismo filtro que la página "Options Flow" de Barchart: prima > $20 k, vence en < 10 días, tamaño > 50
              const fj = await api('/proxies/core-api/v1/options/flow', { symbol: sym, fields: 'symbolType,side,premium,tradeTime,tradeSize,dte', raw: 1, limit: 500, orderBy: 'tradeTime', orderDir: 'desc', 'gt(premium,20000)': '', 'lt(dte,10)': '' });
              const F = (fj.data || []).map((x) => x.raw || x).filter((o) => (o.tradeSize || 0) > 50 && new Date(o.tradeTime * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === hoy);
              let alc = 0, baj = 0; const k4 = { cc: 0, cv: 0, pc: 0, pv: 0 };
              for (const o of F) { const c = o.symbolType === 'Call', ask = o.side === 'ask', bid = o.side === 'bid';
                if ((c && ask) || (!c && bid)) alc += o.premium; else if ((!c && ask) || (c && bid)) baj += o.premium;
                if (c && ask) k4.cc += o.premium; if (c && bid) k4.cv += o.premium; if (!c && ask) k4.pc += o.premium; if (!c && bid) k4.pv += o.premium; }
              opc.flujo = { n: F.length, alc, baj, k4 };
            }
          } catch (e) {}
          const a = ACTIVOS[sym], cReal = cfd[a.cfd], cIdx = spot[a.idx];
          const c = cReal || cIdx || null;
          items[sym] = {
            spot: S, cfdSym: a.cfd, nombre: a.nombre, dec: a.dec,
            cfd: c, fuenteCfd: cReal ? 'CFD OANDA' : (cIdx ? 'índice ' + a.idx + ' (aprox.)' : null),
            ratio: c ? c / S : null,
            opc,
            semana: mapa(ch.filter((x) => semV.includes(x.expirationDate)), S, hoy),
            estructural: mapa(ch.filter((x) => estV.includes(x.expirationDate)), S, hoy),
            maxPain: {
              cercano: vCerca ? { venc: vCerca, strike: maxPain(ch.filter((x) => x.expirationDate === vCerca), S) } : null,
              mensual: vMens ? { venc: vMens, strike: maxPain(ch.filter((x) => x.expirationDate === vMens), S) } : null,
            },
          };
        } catch (e) { const prev = (gmGet('ng_data', null) || { items: {} }).items[sym]; items[sym] = prev && !prev.error ? Object.assign({}, prev, { viejo: prev.viejo || (gmGet('ng_data', null) || {}).hora || '?' }) : { error: 'Barchart no respondió (' + String(e.message || e) + ') · se reintenta solo en 5 min' }; }
      }
      const data = { t: Date.now(), hora: horaLima(), items };
      data.ver = VER_DATOS; gmSet('ng_data', data);
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
      // v2.7: historia diaria de put/call de Barchart (60 días) → cada activo se compara con SU propio normal
      let pch = gmGet('ng_pchist', null);
      if (!pch || pch.dia !== t.dia) {
        pch = { dia: t.dia, s: {} };
        for (const s of Object.keys(ACTIVOS)) {
          try { const j = await api('/proxies/core-api/v1/options-historical/get', { symbol: s, fields: 'date,putCallVolumeRatio,putCallOpenInterestRatio', orderBy: 'date', orderDir: 'desc', limit: 60, raw: 1 });
            const d = (j.data || []).map((x) => x.raw || x).filter((x) => x.date < t.dia);
            pch.s[s] = { vol: d.map((x) => x.putCallVolumeRatio).filter((x) => x > 0).slice(0, 20), oi: d.map((x) => x.putCallOpenInterestRatio).filter((x) => x > 0).slice(0, 20) }; } catch (e) {}
        }
        gmSet('ng_pchist', pch);
      }
      // 5 min de QQQ de hoy (para la entrada de contexto) — solo desde las 10:30 NY y una vez
      // v2.3: velas de 5 min de DIA, QQQ y GLD en sesión (VWAP de la fila de lectura + contexto 10:30)
      let b5 = gmGet('ng_b5', null);
      if (!b5 || b5.dia !== t.dia) b5 = { dia: t.dia, s: {} };
      if (t.min >= 575 && t.min < 965 && !/Sat|Sun/.test(t.sem)) {
        for (const sym of ['QQQ', 'DIA', 'GLD']) {
          try {
            const L = await serie('/proxies/timeseries/historical/queryminutes.ashx', { symbol: sym, interval: 5, maxrecords: 100, order: 'desc', volume: 'contract', dividends: 'false', backadjust: 'false' });
            b5.s[sym] = L.filter((c) => c.length >= 7 && c[0].startsWith(t.dia) && c[0].slice(11, 16) >= '09:30').map((c) => ({ hm: c[0].slice(11, 16), o: +c[2], h: +c[3], l: +c[4], c: +c[5], v: +c[6] })).sort((a, b) => a.hm < b.hm ? -1 : 1);
          } catch (e) {}
        }
        gmSet('ng_b5', b5);
      }
      const dd = { t: Date.now(), hora: horaLima(), Q, eod: eod.s, pch: pch.s, b5: b5.s, barras: b5.s.QQQ || [] };
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

    // Impulso de la 1ª hora en gamma + (NAS100 · 2024-01→2025-09: 286 ops +15 pts t 2,8 · 2025-10→2026-10: 125 ops +22 pts t 2,4 · EN PRUEBA)
    function impulso(dd, it) {
      const t = ny(); if (cerrado()) return { estado: `se evalúa en la próxima sesión a las ${limaDeNY(630)} Lima` };
      if (t.min < 630) return { estado: `se evalúa a las ${limaDeNY(630)} Lima (10:30 NY)` };
      const e = it.estructural || {}; if (!e.flip || !it.ratio) return { estado: 'falta el flip' };
      if (it.spot < e.flip) return { estado: 'hoy no aplica: bajo el flip (gamma −)' };
      const a = dd.barras.find((x) => x.hm === '09:30'), b = dd.barras.find((x) => x.hm === '10:25'), c = dd.barras.find((x) => x.hm === '10:30') || b;
      if (!a || !b) return { estado: 'faltan datos de 09:30–10:30' };
      const d = Math.sign(b.c / a.o - 1); if (!d) return { estado: 'primera hora plana' };
      const ent = c.o * it.ratio;
      return { señal: true, d, ent, sl: ent - d * 100, tp: ent + d * 200, risk: 100 };
    }

    // ── FILA DE LECTURA (v2.3): VWAP · noticias · próximo dato · VIX — lo primero que se mira ──
    function vwapDe(b) {
      if (!b || !b.length) return null; let pv = 0, vv = 0; for (const x of b) { pv += (x.h + x.l + x.c) / 3 * (x.v || 1); vv += (x.v || 1); }
      const vw = pv / vv, u = b[b.length - 1].c, lado = Math.sign(u - vw);
      let desde = b[b.length - 1].hm; pv = 0; vv = 0; const lados = [];
      for (const x of b) { pv += (x.h + x.l + x.c) / 3 * (x.v || 1); vv += (x.v || 1); lados.push([x.hm, Math.sign(x.c - pv / vv)]); }
      for (let j = lados.length - 1; j >= 0 && lados[j][1] === lado; j--) desde = lados[j][0];
      return { vw, u, lado, pct: (u / vw - 1) * 100, desde };
    }
    function textoTerminal() { try { const t = document.getElementById('tbc-host'); return t && t.shadowRoot ? t.shadowRoot.textContent.replace(/\s+/g, ' ') : ''; } catch (e) { return ''; } }
    function noticias(nombre) {
      const m = new RegExp(nombre + '\\s*·\\s*score noticias\\s*([+−-]?\\d+)\\s*\\((\\w+)\\)').exec(textoTerminal());
      const k = 'ng_news_' + nombre;
      if (m) { const v = { score: +m[1].replace('−', '-'), tono: m[2], t: Date.now() }; gmSet(k, v); return v; }
      const c = gmGet(k, null); return c && Date.now() - c.t < 30 * 60e3 ? Object.assign({}, c, { cache: Math.round((Date.now() - c.t) / 60e3) }) : null;
    }
    function proximoDato() {
      const t = textoTerminal(), i = t.indexOf('Datos de hoy (hora Lima):'); if (i < 0) return null;
      const seg = t.slice(i + 25, i + 600), ahora = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' });
      const re = /(\d{2}:\d{2})\s+([^●]+?)\s*(●+)/g; let m, prox = null;
      while ((m = re.exec(seg))) { if (m[1] > ahora && !prox) prox = { h: m[1], n: m[2].trim(), imp: m[3].length }; }
      if (!prox) return { fin: true };
      const [hh, mm] = prox.h.split(':').map(Number), [ah, am] = ahora.split(':').map(Number); prox.faltan = hh * 60 + mm - (ah * 60 + am);
      return prox;
    }
    // v3.1: ¿quién mueve las opciones? (calls compradas/vendidas, puts compradas/vendidas) + interpretación en palabras
    function quien(k, subePrecio) {
      if (!k) return '';
      const M = (v) => v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + ' M' : '$' + Math.round(v / 1e3) + ' k';
      const L = [['calls compradas', k.cc], ['calls vendidas', k.cv], ['puts compradas', k.pc], ['puts vendidas', k.pv]], tot = L.reduce((t, x) => t + x[1], 0);
      if (!tot) return '';
      const top = [...L].sort((a, b) => b[1] - a[1])[0], dom = top[1] / tot >= 0.45 ? top[0] : null;
      const frase = !dom ? 'mezclado: sin un lado dominante' :
        dom === 'calls vendidas' ? (subePrecio ? 'toma de ganancias / techo en la subida (no es apuesta a caída)' : 'venden calls: esperan que no suba') :
        dom === 'calls compradas' ? (subePrecio ? 'compran la subida: apuestan a más alza' : 'compran calls en la caída: apuestan al rebote') :
        dom === 'puts compradas' ? (subePrecio ? 'compran protección en la subida (cobertura)' : 'compran puts en la caída: apuestan a más baja') :
        (subePrecio ? 'venden puts: confían en el piso' : 'venden puts en la caída: ven piso cerca');
      return `<i style="display:block;margin-top:2px">${L.filter((x) => x[1] > 0).map((x) => `${x[0]} ${M(x[1])}`).join(' · ')}</i><i style="display:block;color:#ffd08a">→ ${frase}</i>`;
    }
    // v3.2: veredicto según las APUESTAS de dirección, no según el lado bruto.
    // Con el precio subiendo, vender calls = toma de ganancias (no cuenta como bajista); con el precio bajando, vender puts = toma de ganancias.
    function apuestas(k, sube) { if (!k) return null; return { alc: k.cc + (sube ? k.pv : 0), baj: k.pc + (sube ? 0 : k.cv), tg: sube ? k.cv : k.pv }; }
    function filaLectura(sym, it, dd) {
      const V = vwapDe((dd.b5 || {})[sym]), N = noticias(it.nombre), vx = dd.Q['$VIX'], vc = vx ? ((vx.percentChange || 0) > 1 ? vx.percentChange : vx.percentChange * 100) : null;
      const t = (c, a, b) => `<span class="ft ${c}"><small>${a}</small>${b}</span>`;
      let h = '<div class="fila">';
      const ult = V ? +((dd.b5[sym].slice(-1)[0] || {}).hm || '00:00').slice(0, 2) * 60 + +((dd.b5[sym].slice(-1)[0] || {}).hm || '00:00').slice(3) + 5 : 0, atraso = V ? ny().min - ult : 0;
      h += V ? t(V.lado > 0 ? 'fu' : 'fd', 'VWAP ' + it.nombre, `${V.lado > 0 ? '▲ SOBRE' : '▼ BAJO'} ${Math.abs(V.pct).toFixed(2)} %<i>desde ${limaDeNY(+V.desde.slice(0, 2) * 60 + +V.desde.slice(3))} · ${atraso > 8 ? 'dato de hace ' + atraso + ' min' : 'al día'}</i>`) : t('fn', 'VWAP', 'se calcula desde la apertura');
      h += N ? t(N.score >= 15 ? 'fu' : N.score <= -15 ? 'fd' : 'fn', 'Noticias', `${N.score > 0 ? '+' : ''}${N.score} ${N.tono}${N.cache ? `<i>leído hace ${N.cache} min</i>` : ''}`) : t('fn', 'Noticias', 'FALTA<i>abre el terminal general</i>');
      if (sym !== 'GLD') h += vc != null ? t(vc <= -3 ? 'fu' : vc >= 3 ? 'fd' : 'fn', 'VIX', `${vc > 0 ? '+' : ''}${vc.toFixed(1)} %`) : '';
      h += '</div>';
      // tablero (v2.7): 4 votos INDEPENDIENTES. Las tres lecturas de opciones (flujo, P/C volumen, inusual) se juntan en UN voto,
      // el P/C se compara con el normal de 20 días de ESE activo (no con un umbral fijo) y el P/C OI queda de fondo, sin votar.
      const O = it.opc || {}, M = (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + ' M' : Math.round(v / 1e3) + ' k';
      const E = (dd.eod || {})[sym] || [], hoyE = E.length && E[E.length - 1].d === ny().dia, c1 = E[E.length - (hoyE ? 2 : 1)], c2 = E[E.length - (hoyE ? 3 : 2)];
      const H = (dd.pch || {})[sym] || {}, est = (a) => { if (!a || a.length < 10) return null; const m = a.reduce((x, y) => x + y, 0) / a.length; return { m, sd: Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) }; };
      const hv = est(H.vol), ho = est(H.oi);
      // sub-lecturas de opciones (+1 alcista / −1 bajista / 0)
      const sub = [];
      const vNeto = (a, b) => { const t = a + b; if (!t) return 0; const r = (a - b) / t; return r >= 0.3 ? 1 : r <= -0.3 ? -1 : 0; };
      const sube = V ? V.lado > 0 : (c1 && it.spot > c1.c);
      const aF = O.flujo && apuestas(O.flujo.k4, sube), aI = O.inus && apuestas(O.inus.k4, sube);
      // v3.5: misma regla que la lectura general: apuestas < $250 k no cuentan (poco dinero = sin señal)
      const POCO = 250000, poca = (a) => a && a.alc + a.baj < POCO;
      const vFl = O.flujo ? (poca(aF) ? 0 : aF ? vNeto(aF.alc, aF.baj) : vNeto(O.flujo.alc, O.flujo.baj)) : 0, vIn = O.inus && O.inus.alc != null ? (poca(aI) ? 0 : aI ? vNeto(aI.alc, aI.baj) : vNeto(O.inus.alc, O.inus.baj)) : 0;
      const notaPoco = (a) => poca(a) ? `<i style="display:block;color:#7f93a8">poco dinero en apuestas (${'$' + Math.round((a.alc + a.baj) / 1e3)} k &lt; $250 k): no cuenta</i>` : '';
      if (O.flujo && O.flujo.n >= 5) sub.push(['flujo', vFl, aF ? `${M(aF.alc)}/${M(aF.baj)}` : `${M(O.flujo.alc)}/${M(O.flujo.baj)}`]);
      if (O.pcVolTot != null && hv && hv.sd > 0) { const z = (O.pcVolTot - hv.m) / hv.sd; sub.push(['P/C', z >= 1 ? -1 : z <= -1 ? 1 : 0, `${O.pcVolTot.toFixed(2)} vs normal ${hv.m.toFixed(2)}`]); }
      if (O.inus && O.inus.n && O.inus.alc != null) sub.push(['inusual', vIn, aI ? `${M(aI.alc)}/${M(aI.baj)}` : `${M(O.inus.alc)}/${M(O.inus.baj)}`]);
      const so = sub.reduce((t, x) => t + x[1], 0);
      const S = [];   // [nombre, voto, detalle]
      S.push(['Precio vs VWAP', V ? (Math.abs(V.pct) < 0.03 ? 0 : V.lado) : null, V ? `${V.pct >= 0 ? '+' : ''}${V.pct.toFixed(2)} %` : 'sin velas']);
      S.push(['Opciones', sub.length ? (so >= 2 ? 1 : so <= -2 ? -1 : 0) : null, sub.length ? sub.map((x) => `${x[0]} ${x[1] > 0 ? '▲' : x[1] < 0 ? '▼' : '='}`).join(' · ') : 'sin datos']);
      S.push(['Noticias', N ? (N.score >= 15 ? 1 : N.score <= -15 ? -1 : 0) : null, N ? `${N.score > 0 ? '+' : ''}${N.score}` : 'FALTA']);
      S.push(['Tendencia (ayer)', c1 && c2 ? ((c1.c / c2.c - 1) * 100 > 0.3 ? 1 : (c1.c / c2.c - 1) * 100 < -0.3 ? -1 : 0) : null, c1 && c2 ? `${(c1.c / c2.c - 1) * 100 > 0 ? '+' : ''}${((c1.c / c2.c - 1) * 100).toFixed(2)} %` : '—']);
      const nA = S.filter((x) => x[1] === 1).length, nB = S.filter((x) => x[1] === -1).length, nE = S.length - nA - nB;
      const cons = nA >= 3 && nB === 0 ? ['fu', 'MAYORÍA ALCISTA'] : nB >= 3 && nA === 0 ? ['fd', 'MAYORÍA BAJISTA'] : ['fn', 'SIN CONSENSO'];
      // lectura general (v3.2): precio + quién apuesta + quién toma ganancias + P/C, en una frase
      const Mm = (v) => '$' + M(v), sumA = (f) => (aF ? aF[f] : 0) + (aI ? aI[f] : 0);
      const A_ = sumA('alc'), B_ = sumA('baj'), TG = sumA('tg'), pcZ = O.pcVolTot != null && hv && hv.sd > 0 ? (O.pcVolTot - hv.m) / hv.sd : null;
      let gen = null;
      if (V || A_ + B_ + TG > 0) {
        const poco = A_ + B_ < POCO, dirOp = poco ? 0 : vNeto(A_, B_), pre = V ? (V.lado > 0 ? `${it.nombre} sube sobre el VWAP` : `${it.nombre} baja bajo el VWAP`) : `${it.nombre} ${sube ? 'sobre' : 'bajo'} el cierre de ayer`;
        const ap = A_ + B_ > 0 ? `apuestas${poco ? ' (poco dinero, < $250 k: no cuenta)' : ''}: ${dirOp > 0 ? 'compran al alza' : dirOp < 0 ? 'compran a la baja' : 'repartidas'} (alza ${Mm(A_)} · baja ${Mm(B_)})` : 'sin apuestas grandes';
        const tg = TG > 0 ? `; ${sube ? 'venden calls' : 'venden puts'} ${Mm(TG)} = toma de ganancias` : '';
        const pc = pcZ == null ? '' : pcZ >= 1 ? '; P/C alto: hay cobertura' : pcZ <= -1 ? '; P/C bajo: poca cobertura' : '';
        const dirP = V ? V.lado : (sube ? 1 : -1);
        const ver = dirOp === dirP ? [dirP > 0 ? 'fu' : 'fd', dirP > 0 ? 'ALCISTA' : 'BAJISTA', TG > Math.max(A_, B_) ? ' con freno: no perseguir, mejor en retroceso al VWAP' : ': opciones y precio van juntos']
          : dirOp === 0 ? [dirP > 0 ? 'fu' : 'fd', dirP > 0 ? 'ALCISTA' : 'BAJISTA', ' (lo lleva el precio; opciones sin apuesta en contra)']
          : ['fn', 'DIVERGENCIA', `: el precio va ${dirP > 0 ? 'arriba' : 'abajo'} pero las apuestas van ${dirOp > 0 ? 'arriba' : 'abajo'}; vigilar el VWAP`];
        gen = `<div class="gen ${ver[0]}"><b>${ver[1]}</b>${ver[2]}<i>${pre}; ${ap}${tg}${pc}.${V && atraso > 8 ? ` Dato de hace ${atraso} min.` : ''}</i></div>`;
      }
      let o = `${gen || ''}<div class="tab"><div class="tabh"><b class="${cons[0]}">${cons[1]}</b> <span class="up">${nA} alcistas</span> · <span class="dn">${nB} bajistas</span> · <span class="m">${nE} equilibradas / sin dato · de 4 votos independientes</span><span class="m" style="margin-left:auto">consenso = 3 de 4 sin ninguno en contra · NO probado</span></div><div class="tabg">`;
      for (const [n, v, d] of S) o += `<span class="tc ${v === 1 ? 'fu' : v === -1 ? 'fd' : 'fn'}"><small>${n}</small><b>${v === 1 ? 'Alcista' : v === -1 ? 'Bajista' : v === 0 ? 'Equilibrado' : 'Sin dato'}</b><i>${d}</i></span>`;
      // v2.8: P/C volumen y P/C OI en su propio cuadrito, con veredicto frente al normal de 20 días de ESTE activo
      const pcT = (n, hoy, normal, sd) => { if (hoy == null || !normal) return `<span class="tc fn tcx"><small>${n}</small><b>Sin dato</b></span>`;
        const z = sd > 0 ? (hoy - normal) / sd : 0, v = z >= 1 ? -1 : z <= -1 ? 1 : 0;
        return `<span class="tc tcx ${v === 1 ? 'fu' : v === -1 ? 'fd' : 'fn'}"><small>${n}</small><b>${v === 1 ? 'Alcista' : v === -1 ? 'Bajista' : 'Equilibrado'}</b><i>${hoy.toFixed(2)} · normal ${normal.toFixed(2)}</i></span>`; };
      const oiHoy = H.oi && H.oi.length ? H.oi[0] : null, oiN = est(H.oi && H.oi.length > 1 ? H.oi.slice(1) : null);
      o += pcT('P/C volumen', O.pcVolTot, hv && hv.m, hv && hv.sd) + pcT('P/C OI', oiHoy, oiN && oiN.m, oiN && oiN.sd);
      // v2.9: actividad inusual y flujo grande también en su propio cuadrito
      const tile = (n, v, d, lab) => `<span class="tc tcx ${v === 1 ? 'fu' : v === -1 ? 'fd' : 'fn'}"><small>${n}</small><b>${lab || (v === 1 ? 'Alcista' : v === -1 ? 'Bajista' : v === 0 ? 'Equilibrado' : 'Sin actividad')}</b><i>${d}</i></span>`;
      // v3.6: el veredicto del cuadrito sigue la INTERPRETACIÓN (igual que la lectura general):
      // apuestas a favor del precio = a favor · apuestas en contra = divergencia · sin apuestas o poco dinero = lo lleva el precio (la toma de ganancias no es apuesta en contra)
      const dirP = V ? V.lado : (sube ? 1 : -1);
      const interp = (vv, a) => { const P = dirP > 0 ? 'Alcista' : 'Bajista';
        if (!vv) return [dirP, `${P} · lo lleva el precio`];
        if (vv === dirP) return [dirP, `${P}${a && a.tg > Math.max(a.alc, a.baj) ? ' con freno' : ''}`];
        return [vv, `${vv > 0 ? 'Alcista' : 'Bajista'} · divergencia`]; };
      const tI = interp(vIn, aI), tF = interp(vFl, aF);
      if (O.inus) o += O.inus.n ? tile('Actividad inusual', tI[0], `${O.inus.n} contratos · neto ${O.inus.alc != null ? (O.inus.alc - O.inus.baj >= 0 ? '+' : '−') + M(Math.abs(O.inus.alc - O.inus.baj)) : '—'}${quien(O.inus.k4, sube)}${notaPoco(aI)}`, tI[1]) : tile('Actividad inusual', null, 'vol > 1,25× OI · ≤14 d');
      if (O.flujo) o += O.flujo.n >= 5 ? tile('Flujo de opciones', tF[0], `${O.flujo.n} ops · neto ${O.flujo.alc - O.flujo.baj >= 0 ? '+' : '−'}$${M(Math.abs(O.flujo.alc - O.flujo.baj))}${quien(O.flujo.k4, sube)}${notaPoco(aF)}`, tF[1]) : `<span class="tc tcx fn"><small>Flujo de opciones</small><b>Insuficiente</b><i>solo ${O.flujo.n} ops</i></span>`;
      o += `</div><div class="m" style="font-size:10.5px;margin-top:3px">Borde punteado = detalle, no suma al conteo (ya está resumido en "Opciones"). Los P/C se comparan con el normal de 20 días de ${it.nombre} (±1 desvío; lectura "miedo = bajista", pendiente de probar). Inusual: volumen &gt; 1,25× el interés abierto, según si se compró o vendió. Flujo: mismo filtro que la página de Barchart (&gt; $20 k, vence en &lt; 10 días, tamaño &gt; 50); neto ±30 % = señal.</div>`;
      o += '</div>';   // cierra .tab
      return h + o;
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
      const modo = s.flip ? (it.spot >= s.flip ? 'FRENADO' : 'AMPLIO') : null;
      const R1 = arriba[0], R2 = arriba[1], S1 = abajo[0], S2 = abajo[1], out = [];
      const obj = (desde, lado, sig) => { const tope = desde + lado * p.obj; return sig && (lado > 0 ? sig.v < tope : sig.v > tope) ? { v: sig.v, n: sig.n } : { v: tope, n: p.obj + ' ' + p.u }; };
      // v2.1: el rechazo del muro NO funcionó (2024–26: el muro rebota 32–47 % vs 52–62 % un nivel cualquiera).
      // Se dejan solo rupturas, en los dos modos, como referencia EN PRUEBA.
      if (modo) {
        if (R1) { const o = obj(R1.v, 1, R2); out.push({ lado: 1, txt: `COMPRA si una vela de 5 min cierra sobre ${R1.n}`, gat: R1.v, sl: R1.v - p.stop, tp: o.v, tpN: o.n }); }
        if (S1) { const o = obj(S1.v, -1, S2); out.push({ lado: -1, txt: `VENTA si una vela de 5 min cierra bajo ${S1.n}`, gat: S1.v, sl: S1.v + p.stop, tp: o.v, tpN: o.n }); }
      }
      return { modo, N, out, px };
    }

    // ── 5) DIARIO: cada señal se anota y se mide sola ──
    function anotar(reg) { const D = gmGet('ng_diario', []); if (!D.some((x) => x.id === reg.id)) { D.push(reg); gmSet('ng_diario', D.slice(-500)); } }
    function evaluarDiario(dd) {
      const D = gmGet('ng_diario', []); let cambio = false; const t = ny();
      for (const x of D) {
        if (x.r != null) continue;
        if ((x.tipo === 'contexto' || x.tipo === 'impulso') && t.min >= 960 && dd.barras.length && x.dia === t.dia) {
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
      // v3.4: plegado = botón chico abajo a la izquierda, para no tapar el menú de Barchart
      host.style.cssText = abierto ? 'position:fixed;left:0;right:0;top:0;z-index:2147483646;' : 'position:fixed;left:10px;bottom:10px;z-index:2147483646;';
      if (!abierto) {
        sh.innerHTML = `<style>:host{all:initial}button{font:600 13px system-ui,Segoe UI,Arial,sans-serif;background:#0b1520;color:#cfe1ff;border:1px solid #3b5878;border-radius:999px;padding:7px 14px;cursor:pointer;box-shadow:0 2px 10px #000a}button:hover{background:#13263a}</style><button id="tg" title="${F.n}">📋 Plan del Día ▾</button><button id="ac" style="display:none"></button>`;
        sh.getElementById('tg').onclick = () => { gmSet('ng_abierto', true); pintar(); };
        return;
      }
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
        .fila{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 6px}
        .ft{display:inline-flex;flex-direction:column;padding:4px 9px;border-radius:7px;border:1px solid #2a3340;background:#0b1118;font-weight:800;font-size:13px;line-height:1.2}
        .ft small{font-size:10px;font-weight:600;color:#8b9bb0;text-transform:uppercase;letter-spacing:.05em}.ft i{font-style:normal;font-weight:500;font-size:10.5px;color:#9fb3c8}
        .fu{border-color:#2fbf71;color:#5dffa5;background:#0c2a1b}.fd{border-color:#e5485a;color:#ff8a96;background:#2a1015}.fa{border-color:#ffb84d;color:#ffd08a;background:#2a2110}.fn{color:#c9d6e3}
        .tab{border:1px solid #1e2a36;border-radius:8px;padding:5px 7px;margin:0 0 7px;background:#0a0f15}
        .tabh{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;margin-bottom:4px}.tabh b{font-size:12.5px}
        .tabg{display:flex;gap:5px;flex-wrap:wrap}.tc{display:inline-flex;flex-direction:column;padding:3px 7px;border-radius:6px;border:1px solid #2a3340;font-size:12px;line-height:1.25;min-width:96px}
        .tcx{border-style:dashed;max-width:360px}
        .gen{margin:6px 0 4px;padding:6px 10px;border-radius:6px;border:1px solid currentColor;font-size:13px}.gen b{font-size:14px;margin-right:4px}.gen i{display:block;font-style:normal;color:#cfd6e0;font-size:11.5px;margin-top:2px}
        .tc small{font-size:9.5px;color:#8b9bb0;text-transform:uppercase;letter-spacing:.04em}.tc i{font-style:normal;font-size:10px;color:#9fb3c8}
        .fila2{display:flex;gap:4px 10px;flex-wrap:wrap;align-items:center;font-size:11.5px;margin:-2px 0 6px}
        .fo{padding:1px 6px;border-radius:5px;background:#0b1118;border:1px solid #1e2a36}.fo.fu b{color:#5dffa5}.fo.fd b{color:#ff8a96}.fo.fn b{color:#c9d6e3}
        input{width:110px;background:#0b1118;color:#fff;border:1px solid #2b3b4e;border-radius:5px;padding:2px 5px;font:inherit;font-size:12px}
      </style><div class="b"><div class="top"><b>📋 PLAN DEL DÍA</b><span class="fs">${F.n}</span><span class="m">${F.d}</span>${(() => { const P = proximoDato(); return P && !P.fin ? `<span class="ft ${P.imp >= 3 ? 'fd' : P.faltan <= 15 ? 'fa' : 'fn'}"><small>Próximo dato</small>${P.h} ${P.n}<i>en ${P.faltan} min${P.imp >= 3 ? ' · ALTO IMPACTO: sin posición' : ''}</i></span>` : ''; })()}<span style="flex:1"></span><span class="m">${dd ? 'datos ' + dd.hora : ''}${data ? ' · gamma ' + data.hora : ''} ${estado || ''}</span><button id="ac">↻</button><button id="tg">${abierto ? '▴ plegar' : '▾ plan'}</button></div>`;
      if (abierto && data && dd) {
        const cap = gmGet('ng_capital', null);
        h += '<div class="g">';
        for (const sym of Object.keys(ACTIVOS)) {
          const it = data.items[sym]; if (!it || it.error) { h += `<div class="c"><h4>${ACTIVOS[sym].nombre}</h4><span class="dn">${it ? it.error : 'sin datos'}</span></div>`; continue; }
          const d = it.dec, E = escenarios(sym, it, dd), p = PASO[sym];
          h += `<div class="c"><h4><span>${it.nombre} ${f(it.cfd, d)}${it.viejo ? ` <small class="am" style="font-size:10.5px">⚠ gamma de las ${it.viejo} (Barchart no respondió; reintenta solo)</small>` : ''}</span><span class="m" style="font-size:11px">${it.fuenteCfd || ''}</span></h4>` + filaLectura(sym, it, dd);
          if (E && E.modo) h += `<div><span class="modo ${E.modo === 'AMPLIO' ? 'ru' : 're'}">DÍA ${E.modo}</span> <span class="m">${E.modo === 'AMPLIO' ? 'gamma − (bajo el flip): días más amplios · no comprar caídas ni vender subidas por "barato/caro"' : 'gamma + (sobre el flip): días más frenados · el muro NO es freno (se rompe más que un nivel cualquiera)'}</span>${sym !== 'GLD' ? '<span class="pr ok">rango probado</span>' : '<span class="pr">sin efecto en oro</span>'}</div>`;
          // señales probadas
          if (sym === 'QQQ') {
            const C = contexto(dd, it), Pn = panico(dd), I = impulso(dd, it);
            if (I.señal) { h += `<div class="sem si"><b class="${I.d > 0 ? 'up' : 'dn'}">● ENTRAR · ${I.d > 0 ? 'COMPRA' : 'VENTA'} ${f(I.ent, 0)}</b> · stop ${f(I.sl, 0)} · objetivo ${f(I.tp, 0)} (200 pts) · si no toca, cerrar al cierre<br><span class="m">Impulso de la 1ª hora en gamma + · 2024–26: +15 / +22 pts por operación</span><span class="pr">en prueba · 0,25 %</span>${cap ? `<br><span class="m">tamaño para 0,25 %: ${f(cap * 0.0025 / 100, 2)} USD por punto</span>` : ''}</div>`;
              anotar({ id: 'imp_' + ny().dia, tipo: 'impulso', dia: ny().dia, d: I.d, ent: I.ent, sl: I.sl, tp: I.tp, k: it.ratio }); }
            else h += `<div class="sem"><b class="m">○ Impulso 1ª hora</b> <span class="m">${I.estado}</span></div>`;
            if (C.señal) { h += `<div class="sem si"><b class="${C.d > 0 ? 'up' : 'dn'}">● ENTRAR · ${C.d > 0 ? 'COMPRA' : 'VENTA'} ${f(C.ent, 0)}</b> · stop ${f(C.sl, 0)} · objetivo ${f(C.tp, 0)} (2R) · riesgo ${f(C.risk, 0)} pts<br><span class="m">Entrada de contexto 10:30 NY · 7 años: 48 % acierto, +0,19 R/op</span><span class="pr">en prueba</span>${cap ? `<br><span class="m">tamaño para 0,5 %: ${f(cap * 0.005 / C.risk, 2)} USD por punto</span>` : ''}</div>`;
              anotar({ id: 'ctx_' + ny().dia, tipo: 'contexto', dia: ny().dia, d: C.d, ent: C.ent, sl: C.sl, tp: C.tp, k: it.ratio }); }
            else h += `<div class="sem"><b class="m">○ Contexto 10:30</b> <span class="m">${C.estado}</span></div>`;
            if (Pn.señal) { h += `<div class="sem si"><b class="up">● REBOTE DE PÁNICO ACTIVO</b> · comprar al cierre (${limaDeNY(955)} Lima) · salir en el primer cierre sobre ${f(Pn.prevHigh * it.ratio, 0)} o a los 5 días<br><span class="m">RSI2 ${Pn.rsi.toFixed(1)} · sobre la media de 200 · crédito sano · 2007–2026: 71 % acierto, +0,31 %/op</span><span class="pr ok">probado 19 años</span></div>`;
              if (ny().min >= 900) anotar({ id: 'pn_' + ny().dia, tipo: 'panico', dia: ny().dia, ent: dd.Q.QQQ.lastPrice, prevHigh: Pn.prevHigh }); }
            else if (Pn.rsi != null) h += `<div class="sem ${Pn.cerca ? 'cer' : ''}"><b class="${Pn.cerca ? 'am' : 'm'}">${Pn.cerca ? '◐ Pánico cerca' : '○ Rebote de pánico'}</b> <span class="m">RSI2 ${Pn.rsi.toFixed(1)} (necesita &lt; 10) · ${Pn.ok.tend ? 'sobre' : 'bajo'} media 200 · crédito ${Pn.ok.cred ? 'sano' : 'débil'} (${(Pn.cred * 100).toFixed(1)} %)</span></div>`;
          } else h += `<div class="sem"><b class="m">○ Sin señal probada para ${it.nombre}</b> <span class="m">· solo escenarios en prueba (riesgo reducido)</span></div>`;
          // escenarios
          if (E && E.out.length) {
            h += `<div class="m" style="margin-top:4px">Rupturas de referencia <span class="pr">NO probadas · solo para ubicar niveles</span></div>`;
            for (const x of E.out) h += `<div class="esc"><b class="${x.lado > 0 ? 'up' : 'dn'}">${x.lado > 0 ? '▲' : '▼'}</b> ${x.txt} (${f(x.gat, d)})<br><span class="m">stop ${f(x.sl, d)} · objetivo ${f(x.tp, d)} (${x.tpN}) · ${p.stop} ${p.u} de riesgo</span></div>`;
          }
          if (E) h += `<div class="niv">${E.N.map((x) => `<span${Math.abs(x.v - E.px) < p.stop ? ' style="color:#fff"' : ''}>${x.n} <b>${f(x.v, d)}</b></span>`).join('')}</div>`;
          h += '</div>';
        }
        const D = evaluarDiario(dd), hechos = D.filter((x) => x.r != null);
        const txt = (tipo) => { const H = hechos.filter((x) => x.tipo === tipo); return H.length ? `${H.length} · ${Math.round(H.filter((x) => x.r > 0).length / H.length * 100)} % ganadas · media ${(H.reduce((a, x) => a + x.r, 0) / H.length).toFixed(2)}${tipo === 'panico' ? ' %' : ' R'}` : 'aún sin resultados'; };
        h += `</div><div class="m" style="margin-top:6px">📒 Diario en vivo — impulso 1ª hora: ${txt('impulso')} · contexto 10:30: ${txt('contexto')} · pánico: ${txt('panico')} · Capital para el tamaño: <input id="cap" type="number" placeholder="FALTA" value="${cap || ''}"> USD · *Imán = gamma más negativa, NO probado que atraiga. No es asesoría: datos para que decidas tú.</div>`;
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
      if (!forzar && ((d && d.ver === VER_DATOS && Date.now() - d.t < ttl) || Date.now() - lock < 3 * 60e3)) return;
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

    // borrar SOLO las líneas de este script: v2.2 las reconoce por su TEXTO ("S·…", "E·…", "MAXPAIN …" con "(DIA|QQQ|GLD …)"),
    // porque TradingView cambia el id interno al recargar el gráfico guardado y así quedaban líneas viejas duplicadas.
    const ids = idsGuardados();
    const MIA = /^(S·|E·|MAXPAIN )[\s\S]*\((DIA|QQQ|GLD) [\d.]+\)$/;
    for (const x of ch.getAllShapes() || []) {
      if (x.name !== 'horizontal_line') continue;
      let txt = '';
      try { const o = ch.getShapeById(x.id); txt = (o.getProperties() || {}).text || ''; } catch (err) {}
      if (MIA.test(String(txt).trim()) || (ids[sym] || []).map(String).includes(String(x.id))) { try { ch.removeEntity(x.id); } catch (err) {} }
    }
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
