// ==UserScript==
// @name         Plan del Día + Niveles Gamma → TradingView
// @namespace    terminal-barchart
// @version      5.12
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
// @grant        GM_xmlhttpRequest
// @connect      api-fxtrade.oanda.com
// @connect      api-fxpractice.oanda.com
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  if (window.top !== window.self) return;

  // ───────────────────────── configuración ─────────────────────────
  const ACTIVOS = {
    // idx = respaldo en Barchart cuando el escáner de TradingView no da el CFD (pasa con NAS100)
    DIA: { cfd: 'OANDA:US30USD',   idx: '$DOWI',   nombre: 'US30',   dec: 0 },
    QQQ: { cfd: 'OANDA:NAS100USD', idx: '$IUXX',   nombre: 'NAS100', dec: 0, gexIdx: '$IUXX' }, // v5.9: en el CFD el GEX sale de las opciones del índice NDX (strikes de 100 en 100)
    GLD: { cfd: 'OANDA:XAUUSD',    idx: '^XAUUSD', nombre: 'ORO',    dec: 1 },
  };
  const PAUSA_MS = 2000;            // regla: nunca más de 1 pedido cada 1–2 s a Barchart
  const VER_DATOS = 39; // v3.3: si los datos los calculó una versión vieja (otra pestaña sin recargar), se recalculan
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
  // v4.9: feriados y medias jornadas de la NYSE (calendario hasta 2027; hay que ampliarlo para 2028)
  const NYSE_FER = ['2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'];
  const NYSE_MEDIA = { '2026-11-27': 780, '2026-12-24': 780, '2027-11-26': 780 };
  const esFeriado = () => NYSE_FER.includes(ny().dia);
  const cierreHoy = () => NYSE_MEDIA[ny().dia] || 960;
  const mercadoAbierto = () => { const t = ny(); return !/Sat|Sun/.test(t.sem) && !esFeriado() && t.min >= 570 && t.min < cierreHoy(); };
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
  function mapa(filas, S, hoy, rangoFlip) {
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
    const rf = rangoFlip || 0.15; // v5.12: flip y HVL se buscan en ±15 %; si no aparece, el tipo de día usa la gamma neta
    for (let s = S * (1 - rf); s <= S * (1 + rf); s += S * 0.0005) {
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
      neta: tot(S),
      muro: muro ? muro[0] : null, iman: iman ? iman[0] : null,
    };
  }

  // v5.4: perfil GEX neto propio. Por strike: gamma × interés abierto × 100 × S² × 1 %, calls en positivo y puts en negativo.
  // C1–C3 = mayor neto positivo · P1–P3 = mayor neto negativo · HVL = donde la gamma total cambia de signo. Dos modos: primer vencimiento o acumulado.
  function gexPerfil(filas, S, hoy, venc, semana) {
    const calc = (L) => { const n = {}, co = {}, po = {}, ag = {};
      for (const x of L) { if (!(x.openInterest > 0) || !(x.gamma > 0) || Math.abs(x.strikePrice / S - 1) > 0.1) continue; const g = x.gamma * x.openInterest * 100 * S * S * 0.01, c = x.optionType === 'Call', k = x.strikePrice;
        n[k] = (n[k] || 0) + (c ? g : -g); ag[k] = (ag[k] || 0) + g; const d = c ? co : po; d[k] = (d[k] || 0) + x.openInterest; }
      const A = Object.entries(n).map(([k, v]) => ({ k: +k, g: Math.round(v) })), m = mapa(L, S, hoy, 0.15);
      // v5.7: marcas por strike (definición propia; se calculan con OI y gamma de Barchart)
      const ks = Object.keys(n).map(Number), top = (f) => { let b = null, bv = -Infinity; for (const k of ks) { const v = f(k); if (v > bv) { bv = v; b = k; } } return b; }, oc = (k) => co[k] || 0, op = (k) => po[k] || 0;
      const M = ks.length ? { COI: top(oc), POI: top(op), nCOI: top((k) => oc(k) - op(k)), nPOI: top((k) => op(k) - oc(k)), AbOI: top((k) => oc(k) + op(k)), Ab: ks.slice().sort((p, q) => ag[q] - ag[p]).slice(0, 3) } : null;
      return { hvl: m ? m.flip : null, C: A.filter((x) => x.g > 0).sort((p, q) => q.g - p.g).slice(0, 6), P: A.filter((x) => x.g < 0).sort((p, q) => p.g - q.g).slice(0, 6), B: A.slice().sort((p, q) => Math.abs(q.g) - Math.abs(p.g)).slice(0, 30), M }; };
    return { venc, S, dte: dte(venc, hoy), primero: calc(filas.filter((x) => x.expirationDate === venc)), acum: calc(semana) };
  }
  const gexModo = () => gmGet('ng_gexmodo', 'primero');
  const gexDe = (it) => (it && it.gex ? it.gex[gexModo()] : null);

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

    async function cadena(sym, hoy, maxVenc) {
      let all = [];
      for (let pg = 1; pg <= 12; pg++) {
        const j = await api('/proxies/core-api/v1/options/get', {
          symbol: sym, fields: 'strikePrice,optionType,openInterest,gamma,volatility,expirationDate,volume,lastPrice,bidPrice,askPrice',
          orderBy: 'daysToExpiration', orderDir: 'asc', limit: 1000, page: pg, raw: 1,
        });
        const d = (j.data || []).map((x) => x.raw || x);
        all = all.concat(d);
        if (d.length < 1000 || dte(d[d.length - 1].expirationDate, hoy) > DIAS_ESTR) break;
        if (maxVenc && new Set(all.map((x) => x.expirationDate)).size > maxVenc) break;
      }
      return all;
    }

    // ── v3.7: OANDA en vivo (opcional). El usuario pega SU token en el botón "OANDA"; se guarda solo en su Tampermonkey.
    const OANDA_INST = { 'OANDA:US30USD': 'US30_USD', 'OANDA:NAS100USD': 'NAS100_USD', 'OANDA:XAUUSD': 'XAU_USD' };
    function oanda(path) {
      const cfg = gmGet('ng_oanda', null);
      if (!cfg || !cfg.tok) return Promise.reject(new Error('sin token'));
      const host = cfg.env === 'demo' ? 'https://api-fxpractice.oanda.com' : 'https://api-fxtrade.oanda.com';
      return new Promise((ok, mal) => GM_xmlhttpRequest({ method: 'GET', url: host + path, timeout: 10000, headers: { Authorization: 'Bearer ' + cfg.tok, 'Accept-Datetime-Format': 'UNIX' },
        onload: (r) => { if (r.status !== 200) return mal(new Error('OANDA ' + r.status)); try { ok(JSON.parse(r.responseText)); } catch (e) { mal(e); } }, onerror: () => mal(new Error('OANDA sin conexión')), ontimeout: () => mal(new Error('OANDA tiempo agotado')) }));
    }
    async function oandaCuenta() {
      const cfg = gmGet('ng_oanda', null); if (!cfg) return null; if (cfg.acc) return cfg.acc;
      const j = await oanda('/v3/accounts'); const acc = j.accounts && j.accounts[0] && j.accounts[0].id; if (acc) gmSet('ng_oanda', { ...cfg, acc }); return acc;
    }
    async function oandaPrecios() {
      const acc = await oandaCuenta(); if (!acc) return null;
      const j = await oanda('/v3/accounts/' + acc + '/pricing?instruments=' + Object.values(OANDA_INST).join(','));
      const out = {}; for (const p of j.prices || []) { const k = Object.keys(OANDA_INST).find((x) => OANDA_INST[x] === p.instrument); const b = +(p.bids[0] || {}).price, a = +(p.asks[0] || {}).price; if (k && b && a) out[k] = (a + b) / 2; }
      return out;
    }
    // velas de 5 min del CFD de hoy desde las 09:30 NY (volumen = ticks), SIN atraso
    async function oandaVelas(cfdSym, dia) {
      const j = await oanda('/v3/instruments/' + OANDA_INST[cfdSym] + '/candles?granularity=M5&price=M&count=120');
      const out = [];
      for (const c of j.candles || []) { const d = new Date(+c.time * 1000), f = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), hm = d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
        if (f === dia && hm >= '09:30') out.push({ hm, o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c, v: c.volume || 1, vivo: !c.complete }); }
      return out;
    }
    async function precioCFD() {
      try { const o = await oandaPrecios(); if (o && Object.keys(o).length) { o._oanda = true; return o; } } catch (e) {}
      const out = {};
      try {
        // v3.8: si TradingView no da el CFD de OANDA (pasa con NAS100), usa el mismo CFD de otro bróker en vivo
        const ALT = { 'OANDA:NAS100USD': ['PEPPERSTONE:NAS100', 'FOREXCOM:NSXUSD', 'CAPITALCOM:US100'], 'OANDA:US30USD': ['PEPPERSTONE:US30', 'FOREXCOM:DJI'], 'OANDA:XAUUSD': ['PEPPERSTONE:XAUUSD', 'FOREXCOM:XAUUSD'] };
        const tk = Object.values(ACTIVOS).map((a) => a.cfd); for (const k of tk) tk.push(...(ALT[k] || []));
        const r = await fetch('https://scanner.tradingview.com/cfd/scan', { method: 'POST', body: JSON.stringify({ symbols: { tickers: tk }, columns: ['close'] }) });
        const j = await r.json(), raw = {};
        for (const x of j.data || []) if (x.d[0] > 0) raw[x.s] = x.d[0];
        out._src = {};
        for (const a of Object.values(ACTIVOS)) { const k = [a.cfd, ...(ALT[a.cfd] || [])].find((t) => raw[t]); if (k) { out[a.cfd] = raw[k]; out._src[a.cfd] = 'CFD ' + k.split(':')[0].replace('FOREXCOM', 'FOREX.com').replace('CAPITALCOM', 'Capital.com').replace('PEPPERSTONE', 'Pepperstone') + ' (en vivo)'; } }
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
              const fj = await api('/proxies/core-api/v1/options/flow', { symbol: sym, fields: 'symbolType,strikePrice,side,premium,tradeTime,tradeSize,dte', raw: 1, limit: 500, orderBy: 'tradeTime', orderDir: 'desc', 'gt(premium,20000)': '', 'lt(dte,10)': '' });
              const F = (fj.data || []).map((x) => x.raw || x).filter((o) => (o.tradeSize || 0) > 50 && new Date(o.tradeTime * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === hoy);
              let alc = 0, baj = 0; const k4 = { cc: 0, cv: 0, pc: 0, pv: 0 };
              for (const o of F) { const c = o.symbolType === 'Call', ask = o.side === 'ask', bid = o.side === 'bid';
                if ((c && ask) || (!c && bid)) alc += o.premium; else if ((!c && ask) || (c && bid)) baj += o.premium;
                if (c && ask) k4.cc += o.premium; if (c && bid) k4.cv += o.premium; if (!c && ask) k4.pc += o.premium; if (!c && bid) k4.pv += o.premium; }
              opc.flujo = { n: F.length, alc, baj, k4 };
              // v4.6: FLUJO GRANDE por strike (dinero de hoy, prima > $20k) → los 3 strikes con más prima cerca del precio (±4 %). SIN PROBAR.
              const m = {};
              for (const o of F) { if (!(o.strikePrice > 0) || Math.abs(o.strikePrice / S - 1) > 0.04) continue;
                const c = o.symbolType === 'Call', z = (m[o.strikePrice] = m[o.strikePrice] || { k: o.strikePrice, t: 0, a: 0, b: 0 }); z.t += o.premium;
                if ((c && o.side === 'ask') || (!c && o.side === 'bid')) z.a += o.premium; else if ((!c && o.side === 'ask') || (c && o.side === 'bid')) z.b += o.premium; }
              const top = Object.values(m).filter((z) => z.t >= 100000).sort((x, y) => y.t - x.t).slice(0, 3);
              const FS = gmGet('ng_flujoS', {}); FS[sym] = { dia: hoy, L: top }; gmSet('ng_flujoS', FS);
            }
          } catch (e) {}
          const a = ACTIVOS[sym], cReal = cfd[a.cfd], cIdx = spot[a.idx];
          // v5.9: GEX del índice para el CFD (solo si Barchart lo entrega)
          let gexI = null;
          if (a.gexIdx && spot[a.gexIdx]) { try { const LI = (await cadena(a.gexIdx, hoy, 4)).filter((x) => dte(x.expirationDate, hoy) >= 0), vI = [...new Set(LI.map((x) => x.expirationDate))].sort().slice(0, 4); if (vI.length) gexI = gexPerfil(LI, spot[a.gexIdx], hoy, vI[0], LI.filter((x) => vI.includes(x.expirationDate))); } catch (e) {} }
          const c = cReal || cIdx || null;
          items[sym] = {
            spot: S, cfdSym: a.cfd, nombre: a.nombre, dec: a.dec,
            cfd: c, fuenteCfd: cReal ? ((cfd._src && cfd._src[a.cfd]) || 'CFD OANDA') : (cIdx ? 'índice ' + a.idx + ' (aprox.)' : null),
            ratio: c ? c / S : null,
            opc,
            gex: vCerca ? gexPerfil(ch, S, hoy, vCerca, ch.filter((x) => semV.includes(x.expirationDate))) : null,
            gexI,
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
      const q = await api('/proxies/core-api/v1/quotes/get', { symbols: 'DIA,QQQ,GLD,$VIX,$VXV,$TRIN,$ADVN,$DECN,HYG,LQD,YM*0,NQ*0,GC*0', fields: 'symbol,lastPrice,previousPrice,openPrice,highPrice,lowPrice,percentChange', raw: 1 });
      const Q = {}; for (const x of q.data || []) { const r = x.raw || x; Q[r.symbol] = r; }
      let eod = gmGet('ng_eod', null);
      if (!eod || eod.dia !== t.dia || !(eod.s.DIA && eod.s.DIA.length >= 205 && eod.s.GLD && eod.s.GLD.length >= 205)) {   // v4.7.1: 230 días para la media 200
        eod = { dia: t.dia, s: {} };
        for (const [s, n] of [['QQQ', 230], ['DIA', 230], ['GLD', 230], ['HYG', 60], ['LQD', 60]]) {
          try { eod.s[s] = (await serie('/proxies/timeseries/queryeod.ashx', { symbol: s, data: 'daily', maxrecords: n, order: 'asc', dividends: 'false', backadjust: 'false' })).filter((c) => c.length >= 6).map((c) => ({ d: c[1], h: +c[3], l: +c[4], c: +c[5] })); } catch (e) {}
        }
        gmSet('ng_eod', eod);
      }
      // v2.7: historia diaria de put/call de Barchart (60 días) → cada activo se compara con SU propio normal
      let pch = gmGet('ng_pchist', null);
      if (!pch || pch.dia !== t.dia || pch.v !== 2) {   // v4.9: también guarda IV percentil
        pch = { dia: t.dia, v: 2, s: {} };
        for (const s of Object.keys(ACTIVOS)) {
          try { const j = await api('/proxies/core-api/v1/options-historical/get', { symbol: s, fields: 'date,putCallVolumeRatio,putCallOpenInterestRatio,impliedVolatilityRank1y,impliedVolatilityPercentile1y,weightedImpliedVolatility', orderBy: 'date', orderDir: 'desc', limit: 60, raw: 1 });
            const d = (j.data || []).map((x) => x.raw || x).filter((x) => x.date < t.dia);
            pch.s[s] = { vol: d.map((x) => x.putCallVolumeRatio).filter((x) => x > 0).slice(0, 20), oi: d.map((x) => x.putCallOpenInterestRatio).filter((x) => x > 0).slice(0, 20), ivp: d[0] ? d[0].impliedVolatilityPercentile1y : null, ivr: d[0] ? d[0].impliedVolatilityRank1y : null, iv: d[0] ? d[0].weightedImpliedVolatility : null }; } catch (e) {}
        }
        gmSet('ng_pchist', pch);
      }
      // 5 min de QQQ de hoy (para la entrada de contexto) — solo desde las 10:30 NY y una vez
      // v2.3: velas de 5 min de DIA, QQQ y GLD en sesión (VWAP de la fila de lectura + contexto 10:30)
      let b5 = gmGet('ng_b5', null);
      if (!b5 || b5.dia !== t.dia) b5 = { dia: t.dia, s: {} };
      if (t.min >= 575 && t.min < cierreHoy() + 5 && !/Sat|Sun/.test(t.sem) && !esFeriado()) {
        for (const sym of ['QQQ', 'DIA', 'GLD']) {
          try {
            const L = await serie('/proxies/timeseries/historical/queryminutes.ashx', { symbol: sym, interval: 5, maxrecords: 100, order: 'desc', volume: 'contract', dividends: 'false', backadjust: 'false' });
            b5.s[sym] = L.filter((c) => c.length >= 7 && c[0].startsWith(t.dia) && c[0].slice(11, 16) >= '09:30').map((c) => ({ hm: c[0].slice(11, 16), o: +c[2], h: +c[3], l: +c[4], c: +c[5], v: +c[6] })).sort((a, b) => a.hm < b.hm ? -1 : 1);
          } catch (e) {}
        }
        gmSet('ng_b5', b5);
      }
      // v3.7: si hay token de OANDA, el VWAP de la fila se calcula con el CFD real y sin atraso
      const o5 = {};
      if (gmGet('ng_oanda', null) && t.min >= 575 && !/Sat|Sun/.test(t.sem)) {
        for (const sym of ['DIA', 'QQQ', 'GLD']) { try { const v = await oandaVelas(ACTIVOS[sym].cfd, t.dia); if (v.length) o5[sym] = v; } catch (e) {} }
      }
      // v4.0: VWAP en vivo de US30 y ORO desde el escáner público de TradingView (VWAP de la sesión del CFD, desde las 18:00 NY)
      const sv = {};
      try { const r = await fetch('https://scanner.tradingview.com/cfd/scan', { method: 'POST', body: JSON.stringify({ symbols: { tickers: ['OANDA:US30USD', 'OANDA:XAUUSD'] }, columns: ['close', 'VWAP', 'update_mode'] }) });
        const j = await r.json(); for (const x of j.data || []) { const k = x.s === 'OANDA:US30USD' ? 'DIA' : 'GLD'; if (x.d[0] > 0 && x.d[1] > 0) sv[k] = { px: x.d[0], vw: x.d[1], vivo: x.d[2] === 'streaming' }; } } catch (e) {}
      let px = null; if (gmGet('ng_oanda', null)) { try { px = await oandaPrecios(); } catch (e) { px = { _error: e.message }; } }
      const dd = { t: Date.now(), hora: horaLima(), Q, eod: eod.s, pch: pch.s, b5: b5.s, o5, px, sv, barras: b5.s.QQQ || [] };
      gmSet('ng_dia', dd);
      return dd;
    }

    // ── 3) REGLAS PROBADAS (las mismas del CLAUDE.md) ──
    const hoyNY = () => ny().dia;
    const cerrado = () => { const t = ny(); return /Sat|Sun/.test(t.sem) || esFeriado() || t.min >= cierreHoy(); };
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
      const serV = (dd.o5 || {})[sym] || (dd.b5 || {})[sym], tvL = gmGet('ng_tvlive', null), tvV = tvL && tvL.vw && tvL.vw[sym] && Date.now() - tvL.vw[sym].t < 120e3 ? tvL.vw[sym] : null;
      const enVivo = !!(dd.o5 || {})[sym] || !!tvV;
      let V = vwapDe(serV); if (tvV) { const u = (tvL.px && tvL.px[sym]) || tvV.u, lado = Math.sign(u - tvV.vw); V = { vw: tvV.vw, u, lado, pct: (u / tvV.vw - 1) * 100, desde: V ? V.desde : '09:30', tv: true }; }
      const N = noticias(it.nombre), vx = dd.Q['$VIX'], vc = vx ? ((vx.percentChange || 0) > 1 ? vx.percentChange : vx.percentChange * 100) : null;
      const t = (c, a, b) => `<span class="ft ${c}"><small>${a}</small>${b}</span>`;
      let h = '<div class="fila">';
      const ult = V && serV && serV.length ? +((serV.slice(-1)[0] || {}).hm || '00:00').slice(0, 2) * 60 + +((serV.slice(-1)[0] || {}).hm || '00:00').slice(3) + 5 : 0, atraso = V ? (enVivo ? 0 : ny().min - ult) : 0;
      h += V ? t(V.lado > 0 ? 'fu' : 'fd', 'VWAP ' + it.nombre, `${V.lado > 0 ? '▲ SOBRE' : '▼ BAJO'} ${Math.abs(V.pct).toFixed(2)} %<i>desde ${limaDeNY(+V.desde.slice(0, 2) * 60 + +V.desde.slice(3))} · ${V.tv ? 'en vivo (tu TradingView)' : atraso > 8 ? 'dato de hace ' + atraso + ' min' : 'al día'}</i>${(() => { const z = !V.tv && (dd.sv || {})[sym]; if (!z) return ''; const tl = gmGet('ng_tvlive', null), u = tl && tl.px && tl.px[sym] && Date.now() - tl.t < 60e3 ? tl.px[sym] : z.px, q = (u / z.vw - 1) * 100; return `<i style="color:${q >= 0 ? '#7dffb5' : '#ff9aa5'}">${z.vivo ? 'EN VIVO' : 'escáner'} · VWAP sesión 24 h: ${q >= 0 ? '▲ sobre' : '▼ bajo'} ${Math.abs(q).toFixed(2)} %</i>`; })()}`) : t('fn', 'VWAP', 'se calcula desde la apertura');
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
        if (!vv) return [0, `Neutral · lo lleva el precio (${P.toLowerCase()})`];   // v4.1: gris = no suma al voto de Opciones
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
      const modo = s.flip ? (it.spot >= s.flip ? 'FRENADO' : 'AMPLIO') : s.neta != null && s.neta !== 0 ? (s.neta > 0 ? 'FRENADO' : 'AMPLIO') : null;
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
        if ((x.tipo === 'contexto' || x.tipo === 'impulso') && cerrado() && dd.barras.length && x.dia === t.dia) {
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
        if (x.tipo === 'tarde' && (x.dia < t.dia || (x.dia === t.dia && cerrado()))) {   // v4.8: compra 12:30 → cierre del mismo día
          const e = (dd.eod[x.sym] || []).find((e) => e.d === x.dia); const cl = e ? e.c : (x.dia === t.dia && dd.Q[x.sym] ? dd.Q[x.sym].lastPrice : null);
          if (cl) { x.r = +((cl / x.ent - 1) * 100).toFixed(2); x.unid = '%'; cambio = true; }
        }
        if (x.tipo === 'caida' && x.dia < t.dia) {   // v4.7: objetivo +0,5 ATR / stop −4 ATR / máx 20 días (en el ETF)
          const E = (dd.eod[x.sym] || []).filter((e) => e.d > x.dia && (e.d < t.dia || cerrado())); let sal = null, i = 0;
          for (const e of E) { i++; if (e.l <= x.stop) { sal = x.stop; break; } if (e.h >= x.obj) { sal = x.obj; break; } if (i >= 20) { sal = e.c; break; } }
          if (sal) { x.r = +((sal / x.ent - 1) * 100).toFixed(2); x.unid = '%'; cambio = true; }
        }
      }
      if (cambio) gmSet('ng_diario', D);
      return D;
    }

    // ── 5b) REGISTRO (v4.9): cada 15 min en sesión guarda los datos de cada activo para medirlos después. NO genera señales. ──
    const REG_COLS = ['dia', 'hora', 'sym', 'etf', 'cfd', 'flip', 'muro', 'flujoN', 'flujoAlc', 'flujoBaj', 'callsComp', 'callsVend', 'putsComp', 'putsVend', 'inusN', 'inusAlc', 'inusBaj', 'pcVol', 'pcVolCerca', 'pcOI', 'vwapPct', 'noticias', 'ivPct', 'ivRank', 'iv', 'vix', 'vxv', 'trin', 'adv', 'dec', 'hyg', 'lqd', 'fut'];
    function registrar() {
      if (!mercadoAbierto()) return;
      const t = ny(), data = gmGet('ng_data', null), dd = gmGet('ng_dia', null);
      if (!data || !dd || !dd.Q || Date.now() - data.t > 10 * 60e3 || Date.now() - dd.t > 5 * 60e3) return;
      const slot = Math.floor(t.min / 15) * 15, k = 'ng_reg_' + t.dia, L = gmGet(k, []), hora = `${String(Math.floor(slot / 60)).padStart(2, '0')}:${String(slot % 60).padStart(2, '0')}`;
      if (L.some((x) => x[1] === hora)) return;
      const q = (s) => (dd.Q[s] ? dd.Q[s].lastPrice : null), fut = { DIA: 'YM', QQQ: 'NQ', GLD: 'GC' };
      for (const sym of Object.keys(ACTIVOS)) {
        const it = data.items[sym]; if (!it || it.error) continue;
        const O = it.opc || {}, F = O.flujo || {}, K = F.k4 || {}, I = O.inus || {}, s = it.semana || {}, H = (dd.pch || {})[sym] || {}, V = vwapDe((dd.o5 || {})[sym] || (dd.b5 || {})[sym]), N = noticias(it.nombre);
        const fk = Object.keys(dd.Q).find((x) => x.startsWith(fut[sym]));
        L.push([t.dia, hora, sym, q(sym), it.cfd, s.flip, s.muro, F.n, F.alc, F.baj, K.cc, K.cv, K.pc, K.pv, I.n, I.alc, I.baj, O.pcVolTot, O.pcVol, O.pcOI, V ? +V.pct.toFixed(3) : null, N ? N.score : null, H.ivp, H.ivr, H.iv, q('$VIX'), q('$VXV'), q('$TRIN'), q('$ADVN'), q('$DECN'), q('HYG'), q('LQD'), fk ? q(fk) : null]);
      }
      gmSet(k, L);
      const dias = gmGet('ng_reg_dias', []); if (!dias.includes(t.dia)) { dias.push(t.dia); gmSet('ng_reg_dias', dias); }
    }
    // v5.4: foto de niveles a las 09:45 y máximo/mínimo del día del ETF, para medir si las barras grandes atraen el precio. No genera señales.
    function gexFoto() {
      const t = ny(), data = gmGet('ng_data', null), dd = gmGet('ng_dia', null); if (!data || !dd || !dd.Q) return;
      const F = gmGet('ng_gexfotos', {}); let cambia = false;
      if (mercadoAbierto() && t.min >= 585 && !F[t.dia]) { const o = {};
        for (const sym of Object.keys(ACTIVOS)) { const it = data.items[sym], q = dd.Q[sym]; if (!it || !it.gex || !q) continue; o[sym] = { px: q.lastPrice, h: q.highPrice, l: q.lowPrice, venc: it.gex.venc, pr: { C: it.gex.primero.C, P: it.gex.primero.P, hvl: it.gex.primero.hvl }, ac: { C: it.gex.acum.C, P: it.gex.acum.P, hvl: it.gex.acum.hvl } }; }
        if (Object.keys(o).length) { F[t.dia] = o; cambia = true; } }
      if (F[t.dia] && !esFeriado() && !/Sat|Sun/.test(t.sem)) for (const sym of Object.keys(F[t.dia])) { const q = dd.Q[sym]; if (q && q.highPrice > 0 && (q.highPrice !== F[t.dia][sym].h || q.lowPrice !== F[t.dia][sym].l)) { F[t.dia][sym].h = q.highPrice; F[t.dia][sym].l = q.lowPrice; cambia = true; } }
      if (cambia) { const k = Object.keys(F).sort(); while (k.length > 400) delete F[k.shift()]; gmSet('ng_gexfotos', F); }
    }
    function exportarRegistro() {
      const dias = gmGet('ng_reg_dias', []), filas = [REG_COLS.join(',')];
      for (const d of dias) for (const x of gmGet('ng_reg_' + d, [])) filas.push(x.map((v) => (v == null ? '' : v)).join(','));
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([filas.join('\n')], { type: 'text/csv' }));
      a.download = 'registro-plan-del-dia-' + hoyNY() + '.csv'; document.body.appendChild(a); a.click(); a.remove();
      const FO = gmGet('ng_gexfotos', {});
      if (Object.keys(FO).length) { const c = document.createElement('a'); c.href = URL.createObjectURL(new Blob([JSON.stringify(FO)], { type: 'application/json' })); c.download = 'gex-fotos-' + hoyNY() + '.json'; document.body.appendChild(c); c.click(); c.remove(); }
      const AR = gmGet('ng_arranques', []);
      if (AR.length) { const b = document.createElement('a'); b.href = URL.createObjectURL(new Blob([['dia', 'activo', 'dir', 'ref', 'precio', 'atrs', 'hora'].join(',') + '\n' + AR.map((x) => [x.dia, x.nm, x.dir, x.ref, x.px, x.atrs, x.hora].join(',')).join('\n')], { type: 'text/csv' })); b.download = 'arranques-' + hoyNY() + '.csv'; document.body.appendChild(b); b.click(); b.remove(); }
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
      if (esFeriado()) return { n: 'FERIADO EN EE.UU.', d: 'bolsa cerrada · sin señales hoy' };
      if (NYSE_MEDIA[t.dia] && t.min < cierreHoy()) return { n: 'MEDIA JORNADA', d: `la bolsa cierra a las ${limaDeNY(cierreHoy())} Lima · motor 3 no opera hoy` };
      if (t.min < 480) return { n: 'PREPARACIÓN', d: `armando el plan con futuros nocturnos y gamma del cierre · plan listo ${limaDeNY(480)} Lima` };
      if (t.min < 570) return { n: 'PLAN LISTO', d: `datos fuertes ${limaDeNY(510)} Lima · apertura ${limaDeNY(570)} Lima` };
      if (t.min < 630) return { n: 'APERTURA', d: `primera hora: se mide la estructura · contexto NAS100 a las ${limaDeNY(630)} Lima` };
      if (t.min < cierreHoy() - 60) return { n: 'EJECUCIÓN', d: `escenarios activos · cierre de bolsa ${limaDeNY(cierreHoy())} Lima` };
      if (t.min < cierreHoy()) return { n: 'CIERRE', d: `ventana del rebote de pánico (se compra al cierre, ${limaDeNY(cierreHoy())} Lima)` };
      return { n: 'MERCADO CERRADO', d: 'resultados del día al diario · el plan de mañana se arma desde la madrugada' };
    }
    // v4.7: CAÍDA RÁPIDA (EN PRUEBA) — comprar al cierre si el precio cayó más de 2,5 ATR desde el máximo de 5 días y está sobre la media de 200;
    // objetivo +0,5 ATR · stop −4 ATR · máximo 20 días. ETF 2007–2026: QQQ 92 %, DIA 92 %, GLD 92 % de acierto, positiva en 2007–16 y 2017–26.
    function caida(dd, sym) {
      const E = dd.eod[sym], q = dd.Q[sym];
      if (!E || E.length < 205 || !q || !(q.lastPrice > 0)) return { estado: 'faltan datos' };
      const tt = ny(), hoyH = !/Sat|Sun/.test(tt.sem) && !esFeriado() && tt.min >= 570, Ec = E.filter((x) => x.d < hoyNY());   // sesiones anteriores + hoy (en vivo o ya cerrado)
      let a = null; for (let i = 1; i < Ec.length; i++) { const tr = Math.max(Ec[i].h - Ec[i].l, Math.abs(Ec[i].h - Ec[i - 1].c), Math.abs(Ec[i].l - Ec[i - 1].c)); a = a == null ? tr : (a * 13 + tr) / 14; }
      const vivo = hoyH, px = q.lastPrice;
      const C = Ec.map((x) => x.c).concat(vivo ? [px] : []);
      const sma200 = C.slice(-200).reduce((t, x) => t + x, 0) / 200;
      const altos = Ec.slice(vivo ? -4 : -5).map((x) => x.h).concat(vivo && q.highPrice > 0 ? [q.highPrice] : []);
      const hh5 = Math.max(...altos), caidaATR = (hh5 - px) / a;
      const ok = { caida: caidaATR > 2.5, tend: px > sma200 };
      // v4.7.3: precio GATILLO = dónde tendría que cerrar para dar señal (hoy, o mañana si ya cerró)
      const manana = cerrado() || !vivo, hhM = Math.max(...Ec.slice(vivo ? -3 : -4).map((x) => x.h).concat(vivo && q.highPrice > 0 ? [q.highPrice] : []));
      const gat = (manana ? hhM : hh5) - 2.5 * a;
      return { gat, manana, atr: a, sma200, hh5, caidaATR, ok, señal: ok.caida && ok.tend, cerca: !ok.caida && caidaATR > 2 && ok.tend, obj: px + 0.5 * a, stop: px - 4 * a, px };
    }
    function avisar(id, tit, txt) {
      const A = gmGet('ng_avisos', {}); if (A[id]) return; A[id] = Date.now(); gmSet('ng_avisos', A);
      try { const ac = new (window.AudioContext || window.webkitAudioContext)(); [0, 0.35, 0.7].forEach((t) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ac.destination); g.gain.setValueAtTime(0.25, ac.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + 0.3); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.3); }); } catch (e) {}
      try { if (window.Notification && Notification.permission === 'granted') new Notification(tit, { body: txt }); } catch (e) {}
    }
    function rutinaHTML(data, dd) {
      const hoy = hoyNY(); let R0 = gmGet('ng_rutina', null); if (!R0 || R0.dia !== hoy) { R0 = { dia: hoy, m: {} }; gmSet('ng_rutina', R0); }
      const ck = (k, txt, sub) => `<label style="display:flex;gap:6px;align-items:flex-start;margin:3px 0;cursor:pointer"><input type="checkbox" class="rt" data-k="${k}" ${R0.m[k] ? 'checked' : ''} style="width:auto;margin-top:2px"><span><b>${txt}</b><br><span class="m">${sub}</span></span></label>`;
      const fila = (n, txt, cont) => `<div style="margin:5px 0;padding:5px 7px;background:#0b1118;border-radius:6px"><b style="color:#9fc5ff">${n}.</b> <b>${txt}</b><div style="margin-top:2px">${cont}</div></div>`;
      const pill = (cls, t) => `<span class="fo ${cls}" style="margin-right:5px">${t}</span>`;
      let p1 = '', p2 = '', p2e = '', p5 = '', autos = 0, buenas = 0; const CD = {};
      for (const sym of Object.keys(ACTIVOS)) {
        const it = data.items[sym], k = it && it.ratio, nm = ACTIVOS[sym].nombre, d = ACTIVOS[sym].dec, c = caida(dd, sym);
        if (c.estado) { p1 += pill('fn', nm + ': faltan datos'); continue; }
        CD[sym] = { c, k, nm, d };
        p1 += pill(c.ok.tend ? 'fu' : 'fd', `${nm} <b>${c.ok.tend ? 'sobre' : 'bajo'}</b> media 200`);
        if (c.ok.tend) buenas++;
        p2 += pill(c.señal ? 'fu' : c.cerca ? 'fa' : 'fn', c.señal ? `${nm} <b>● SEÑAL${cerrado() ? ' DE HOY</b> (la entrada era al cierre: ya pasó; no entrar tarde)<b>' : ''}</b> caída ${c.caidaATR.toFixed(1)} ATR · comprar al cierre ~${k ? f(c.px * k, d) : '—'} · obj ${k ? f(c.obj * k, d) : '—'} · stop ${k ? f(c.stop * k, d) : '—'} · máx 20 días`
          : `${nm} ${c.cerca ? '<b>◐ cerca</b>' : '○'} caída ${c.caidaATR.toFixed(1)} ATR`);
        // v4.7.3: línea ENTRAR por activo (precio del CFD)
        { const g = c.gat, okG = g > c.sma200, ob = g + 0.5 * c.atr, st = g - 4 * c.atr;
          p2e += `<div style="margin:3px 0;padding:4px 8px;border-radius:6px;border:1px solid ${c.señal && !cerrado() ? '#2fbf71' : okG ? '#3b5878' : '#2a3340'};background:${c.señal && !cerrado() ? '#0c2a1b' : '#0b1118'}"><b>${nm}</b> · ` +
            (c.señal && !cerrado() && ny().min >= cierreHoy() - 15 ? `<b class="up" style="font-size:15px">✅ AHORA PUEDES ENTRAR · COMPRA ~${k ? f(c.px * k, d) : '—'}</b> (confirmado al cierre: entra antes de las ${limaDeNY(cierreHoy() - 1)} Lima) · objetivo <b>${k ? f(c.obj * k, d) : '—'}</b> · stop <b>${k ? f(c.stop * k, d) : '—'}</b> · máx 20 días`
            : c.señal && !cerrado() ? `<b class="am">◐ SEÑAL EN FORMACIÓN · todavía NO entres</b> <span class="m">— se confirma entre ${limaDeNY(cierreHoy() - 15)} y ${limaDeNY(cierreHoy() - 1)} Lima (cierre); si sigue así, aquí dirá "AHORA PUEDES ENTRAR" y sonará un aviso · hoy ~${k ? f(c.px * k, d) : '—'}, objetivo ${k ? f(c.obj * k, d) : '—'}, stop ${k ? f(c.stop * k, d) : '—'}</span>`
            : !c.ok.tend ? `<b class="m">▲ COMPRA: no</b> <span class="m">(bajo la media 200 = ${k ? f(c.sma200 * k, d) : '—'}) · </span><b class="m">▼ VENTA: no</b> <span class="m">— la venta espejo (subida rápida bajo la media 200) se probó 2007–26 y PIERDE (−0,14 a −0,79 %/op) → hoy no hay operación de esta estrategia</span>`
            : !okG ? `<span class="m">▲ COMPRA no aplica ${c.manana ? 'mañana' : 'hoy'}: el gatillo (${k ? f(g * k, d) : '—'}) queda bajo la media 200 (${k ? f(c.sma200 * k, d) : '—'}) · ▼ VENTA: no (probada, pierde)</span>`
            : `<b class="m">○ AÚN NO · no entres</b> <span class="m">— el terminal te avisará "AHORA PUEDES ENTRAR" solo si ${c.manana ? 'mañana' : 'hoy'} cierra en ${k ? f(g * k, d) : '—'} o menos (ahora ${k ? f(c.px * k, d) : '—'}, falta ${k ? f((c.px - g) * k, d) : '—'}) · objetivo ≈ ${k ? f(ob * k, d) : '—'} · stop ≈ ${k ? f(st * k, d) : '—'}</span>`) + '</div>'; }
        // v4.7.4: aviso (sonido + notificación) una sola vez por día y activo cuando se confirma
        if (c.señal && !cerrado() && ny().min >= cierreHoy() - 15) avisar('cd_' + sym + '_' + hoy, `✅ ${nm}: AHORA PUEDES ENTRAR (compra)`, `~${k ? f(c.px * k, d) : ''} · objetivo ${k ? f(c.obj * k, d) : ''} · stop ${k ? f(c.stop * k, d) : ''} · antes de las ${limaDeNY(cierreHoy() - 1)} Lima`);
        if (c.señal && !cerrado()) { autos++; if (ny().min >= cierreHoy() - 15) anotar({ id: 'cd_' + sym + '_' + hoy, tipo: 'caida', sym, dia: hoy, ent: c.px, obj: c.obj, stop: c.stop }); }
        const E = it && !it.error ? escenarios(sym, it, dd) : null;
        if (E && E.modo) p5 += pill(E.modo === 'AMPLIO' ? 'fd' : 'fu', `${nm} día <b>${E.modo}</b>`);
      }
      const Pn = panico(dd), P = proximoDato(), cap = gmGet('ng_capital', null);
      // v4.9: POSIBLE DÍA GRANDE — avisa del tamaño, NO de la dirección. DIA 2020–26: IV percentil ≥ 75 → movimiento medio 0,94 % vs 0,69 %.
      let dgh = '';
      { const vxv = dd.Q['$VXV'] && dd.Q['$VXV'].lastPrice, vixL = dd.Q['$VIX'] && dd.Q['$VIX'].lastPrice, ratio = vxv > 0 && vixL > 0 ? vixL / vxv : null, evento = P && !P.fin && P.imp >= 3, grandes = [];
        for (const sym of Object.keys(ACTIVOS)) { const H = (dd.pch || {})[sym] || {}, it = data.items[sym], s = it && it.semana, ivp = H.ivp == null ? null : H.ivp * 100; if (ivp == null) continue;
          const bajo = s && s.flip && it.spot < s.flip, on = ivp >= 75; if (on) grandes.push(ACTIVOS[sym].nombre);
          dgh += pill(on ? 'fa' : 'fn', `${ACTIVOS[sym].nombre} IV percentil <b>${ivp.toFixed(0)} %</b>${bajo ? ' · bajo el flip' : ''}`); }
        dgh += pill(ratio >= 0.95 ? 'fa' : 'fn', `VIX/VXV ${ratio == null ? '—' : ratio.toFixed(2)}`) + (evento ? pill('fd', 'dato fuerte hoy') : '');
        if (grandes.length && !cerrado()) avisar('dg_' + hoy, '⚡ Posible día grande: ' + grandes.join(', '), 'Volatilidad alta: puede moverse más de lo normal. No indica dirección; revisa stop y tamaño.');
        dgh = (grandes.length ? `<b class="am">⚡ POSIBLE DÍA GRANDE: ${grandes.join(', ')}</b> <span class="m">— no indica dirección; 9 de cada 10 veces no llega a ±2 %</span><br>` : '<span class="m">Volatilidad normal: sin aviso.</span><br>') + dgh; }
      const p3 = Pn.rsi == null ? pill('fn', 'faltan datos') : pill(Pn.señal ? 'fu' : Pn.cerca ? 'fa' : 'fn', Pn.señal ? '<b>● REBOTE DE PÁNICO ACTIVO</b> (NAS100, comprar al cierre)' : `RSI2 NAS100 ${Pn.rsi.toFixed(1)} (necesita &lt; 10) · crédito ${Pn.ok.cred ? 'sano' : 'débil'}`);
      if (Pn.señal && !cerrado()) autos++;
      const p4 = P ? pill(P.fin ? 'fn' : P.imp >= 3 ? 'fd' : 'fa', P.fin ? 'ya salieron los datos de hoy' : `${P.h} Lima · ${P.n} ${P.imp >= 3 ? '(FUERTE: no entrar 15 min antes/después)' : ''}`) : pill('fn', 'sin calendario (abre el Terminal)');
      // v4.8: SISTEMA 4G — motor 2 (pánico NAS100) y motor 3 (tarde bajista NAS100/US30)
      const tm = ny().min, abierto = mercadoAbierto(), completa = cierreHoy() === 960;
      let m4 = '';
      { const q = CD.QQQ, okVent = abierto && tm >= cierreHoy() - 15;
        m4 += `<div style="margin:3px 0;padding:4px 8px;border-radius:6px;border:1px solid ${Pn.señal && okVent ? '#2fbf71' : '#2a3340'};background:${Pn.señal && okVent ? '#0c2a1b' : '#0b1118'}"><b>Motor 2 · Rebote de pánico · NAS100</b> · ` +
          (Pn.rsi == null ? '<span class="m">faltan datos</span>'
          : Pn.señal && okVent ? `<b class="up" style="font-size:15px">✅ AHORA PUEDES ENTRAR · COMPRA ~${q && q.k ? f(dd.Q.QQQ.lastPrice * q.k, 0) : '—'}</b> (antes de las ${limaDeNY(cierreHoy() - 1)} Lima) · salida: primer cierre sobre ${q && q.k ? f(Pn.prevHigh * q.k, 0) : '—'} o a los 5 días · <span class="m">71 %, +0,31 %/op</span>`
          : Pn.señal && abierto ? `<b class="am">◐ SEÑAL EN FORMACIÓN · todavía NO entres</b> <span class="m">— se confirma entre ${limaDeNY(cierreHoy() - 15)} y ${limaDeNY(cierreHoy() - 1)} Lima</span>`
          : `<b class="m">○ AÚN NO</b> <span class="m">— RSI2 ${Pn.rsi.toFixed(1)} (necesita &lt; 10), ${Pn.ok.tend ? 'sobre' : 'bajo'} media 200, crédito ${Pn.ok.cred ? 'sano' : 'débil'}</span>`) + '</div>';
        if (Pn.señal && okVent) { autos++; avisar('pn_' + hoy, '✅ NAS100: AHORA PUEDES ENTRAR (rebote de pánico)', 'compra al cierre · salida en el primer cierre sobre el máximo de ayer o a los 5 días'); } }
      for (const sym of ['QQQ', 'DIA']) { const X = CD[sym]; if (!X) continue; const { c, k, nm, d } = X;
        const bajo = !c.ok.tend, ven = abierto && completa && tm >= 750 && tm <= 870, antes = abierto && completa && tm < 750;
        m4 += `<div style="margin:3px 0;padding:4px 8px;border-radius:6px;border:1px solid ${bajo && ven ? '#2fbf71' : '#2a3340'};background:${bajo && ven ? '#0c2a1b' : '#0b1118'}"><b>Motor 3 · Tarde bajista · ${nm}</b> · ` +
          (!bajo ? `<span class="m">○ no aplica: ${nm} está SOBRE la media 200 (${k ? f(c.sma200 * k, d) : '—'}); solo funciona bajo la media</span>`
          : ven ? `<b class="up" style="font-size:15px">✅ AHORA PUEDES ENTRAR · COMPRA ~${k ? f(c.px * k, d) : '—'}</b> (ventana ${limaDeNY(750)}–${limaDeNY(870)} Lima) · <b>salida: al cierre ${limaDeNY(cierreHoy() - 1)} Lima</b> · sin objetivo · <span class="m">56 %, +0,07–0,08 %/op · solo con spread bajo</span>`
          : antes ? `<b class="am">◐ HOY SE ACTIVA a las ${limaDeNY(750)} Lima</b> <span class="m">— ${nm} bajo la media 200; compra entre ${limaDeNY(750)} y ${limaDeNY(870)}, cierra a las ${limaDeNY(cierreHoy() - 1)}</span>`
          : `<span class="m">${nm} bajo la media 200 → mañana se activa de ${limaDeNY(750)} a ${limaDeNY(870)} Lima (compra) y se cierra al cierre</span>`) + '</div>';
        if (bajo && ven) { autos++; avisar('tb_' + sym + '_' + hoy, `✅ ${nm}: AHORA PUEDES ENTRAR (tarde bajista)`, `compra ~${k ? f(c.px * k, d) : ''} · cerrar al cierre (${limaDeNY(cierreHoy() - 1)} Lima)`); anotar({ id: 'tb_' + sym + '_' + hoy, tipo: 'tarde', sym, dia: hoy, ent: c.px }); } }
      const ver = autos ? `<b class="up">HOY HAY SEÑAL MEDIDA</b> — opera solo esa, con su stop y su objetivo` : buenas >= 2 ? `<b class="am">SIN SEÑAL MEDIDA</b> — si operas: tamaño reducido, solo con retest + confirmación y a favor de la media 200` : `<b class="am">MERCADO BAJO LA MEDIA 200</b> — no compres caídas; la única operación medida es el motor 3 (tarde bajista, compra de ${limaDeNY(750)} a ${limaDeNY(870)} y cierra al cierre)`;
      let h = `<div class="c" style="flex-basis:100%"><h4><span>✅ RUTINA DE LA MAÑANA · 8 puntos</span><span class="m" style="font-size:11px">1–5 automáticos · 6–8 los marcas tú · se reinicia cada día ${window.Notification && Notification.permission !== 'granted' ? '<button id="ntf">🔔 activar avisos</button>' : '🔔 avisos activos'}</span></h4>`;
      h += `<div class="gen" style="color:#cfe1ff">${ver}</div>`;
      h += fila('⚡', 'Aviso de día grande (tamaño, no dirección) · EN PRUEBA', dgh);
      h += fila('★', 'SISTEMA 4G · motores 2 y 3 (el motor 1 = caída rápida está en el punto 2)', m4 + '<span class="m">Sistema 2015–26 (1/3 de la cuenta por operación): 11 de 12 años positivos, 76 % de meses positivos, +5,2 %/año, peor caída −10,6 %. Máximo 3 operaciones abiertas a la vez.</span>');
      h += fila(1, 'Tendencia diaria (media de 200)', p1 + '<span class="m"> sobre = solo compras en caídas · bajo = operar menos</span>');
      h += fila(2, 'Señal de alto acierto: caída rápida', p2 + p2e + '<span class="pr">EN PRUEBA</span> <span class="m">caída &gt; 2,5 ATR desde el máx. de 5 días + sobre media 200 · ETF 2007–26: ~92 % de acierto en los 3 · obj +0,5 ATR, stop −4 ATR: <b>cada pérdida borra ~8 ganancias</b>, no muevas el stop</span>');
      h += fila(3, 'Rebote de pánico (NAS100)', p3 + '<span class="m"> · 2007–26: 71 %, +0,31 %/op</span>');
      h += fila(4, 'Calendario', p4);
      h += fila(5, 'Tipo de día (gamma)', (p5 || pill('fn', 'calculando…')) + '<span class="m"> amplio = stops más anchos, no comprar "barato" · frenado = rangos</span>');
      h += fila(6, 'Mapa 4h en TradingView', ck('m6', 'Marqué la liquidez: PDH/PDL, PWH/PWL, $$$ EQH/EQL y el FVG más cercano', 'el mapa dice DÓNDE reaccionar, no la dirección (dirección por estructura = 45–52 %)'));
      h += fila(7, 'Gatillo en 15–30 min', ck('m7', 'Espero que toque el nivel, haga retest y cierre una vela de confirmación', 'entrar en la ruptura salió negativo; retest + confirmación es mejor'));
      h += fila(8, 'Riesgo antes de entrar', ck('m8', 'Stop donde se anula la idea · riesgo 0,5 % ' + (cap ? `(= ${f(cap * 0.005, 0)} USD)` : '(pon tu capital abajo)') + ' · objetivo ≥ 1,5R en la próxima liquidez', 'si no hay 1,5R hasta la próxima liquidez, no hay operación'));
      return h + '</div>';
    }
    // ── v5.2: ARRANCÓ EL MOVIMIENTO (SIN PROBAR) — fuera de sesión vigila el CFD contra su precio del cierre. Solo avisa; no es señal de entrada. ──
    const ARR_ATR = 0.75;
    async function arranque() {
      const t = ny(), dd = gmGet('ng_dia', null); if (mercadoAbierto() || !dd || !dd.Q) return;
      const px = await precioCFD(); let ref = gmGet('ng_arr_ref', {}), L = gmGet('ng_arranques', []);
      const trasCierre = !/Sat|Sun/.test(t.sem) && !esFeriado() && t.min >= cierreHoy();
      for (const sym of Object.keys(ACTIVOS)) {
        const a = ACTIVOS[sym], p = px && px[a.cfd]; if (!(p > 0)) continue;
        if (trasCierre && (!ref[sym] || ref[sym].dia !== t.dia)) ref[sym] = { dia: t.dia, px: p };
        const r = ref[sym]; if (!r) continue;
        const c = caida(dd, sym); if (c.estado || !(c.atr > 0) || !(c.px > 0)) continue;
        const atrs = (p / r.px - 1) / (c.atr / c.px);
        if (Math.abs(atrs) >= ARR_ATR) {
          const id = 'ar_' + sym + '_' + r.dia, dir = atrs > 0 ? 'sube' : 'baja';
          if (!L.some((x) => x.id === id)) { L.push({ id, dia: r.dia, sym, nm: a.nombre, dir, ref: r.px, px: p, atrs: +atrs.toFixed(2), t: Date.now(), hora: horaLima() }); L = L.slice(-500); }
          avisar(id, `⚡ ${a.nombre} ${dir} ${Math.abs(atrs).toFixed(1)} ATR fuera de sesión`, 'Sin probar: no es señal de entrada. Revisa tus niveles y espera tu regla.');
        }
      }
      gmSet('ng_arr_ref', ref); gmSet('ng_arranques', L);
    }

    // ── v5.0: VISTA RESUMEN — un semáforo por activo. Las reglas son las mismas de la rutina; el detalle completo sigue detrás de "Ver detalle". ──
    function vistaHTML(data, dd) {
      const tm = ny().min, ab = mercadoAbierto(), conf = ab && tm >= cierreHoy() - 15, comp = cierreHoy() === 960, Pn = panico(dd), tl = gmGet('ng_tvlive', null), P = proximoDato();
      const hFin = limaDeNY(cierreHoy() - 1), E = [], A = [], G = []; let cols = '';
      for (const sym of Object.keys(ACTIVOS)) {
        const a = ACTIVOS[sym], nm = a.nombre, it = data.items[sym];
        if (!it || it.error) { cols += `<section class="v-a v-off"><header><h3>${nm}</h3></header><div class="v-e">Sin datos</div><p>${it ? it.error : 'Esperando a Barchart.'}</p></section>`; continue; }
        const d = it.dec, k = it.ratio, c = caida(dd, sym), n = (v) => (k && v != null ? f(v * k, d) : '—');
        const px = (tl && Date.now() - tl.t < 60e3 && tl.px && tl.px[sym]) || (dd.px && dd.px[a.cfd]) || it.cfd;
        let st = 'esp', tit = 'Espera', mot = '', txt = '';
        if (c.estado) txt = 'Faltan datos diarios.';
        else {
          const m3 = sym !== 'GLD' && !c.ok.tend;
          if (c.señal && conf) { st = 'ent'; tit = 'Compra ahora'; mot = 'Caída rápida'; txt = `Objetivo <b>${n(c.obj)}</b><br>Stop <b>${n(c.stop)}</b><br>Entra antes de las ${hFin}`; }
          else if (sym === 'QQQ' && Pn.señal && conf) { st = 'ent'; tit = 'Compra ahora'; mot = 'Rebote de pánico'; txt = `Sale al primer cierre sobre <b>${n(Pn.prevHigh)}</b> o a los 5 días<br>Entra antes de las ${hFin}`; }
          else if (m3 && ab && comp && tm >= 750 && tm <= 870) { st = 'ent'; tit = 'Compra ahora'; mot = 'Tarde bajista'; txt = `Sin objetivo<br>Cierra a las ${hFin}`; }
          else if (c.señal && !cerrado()) { st = 'ate'; tit = 'Todavía no'; mot = 'Caída rápida formándose'; txt = `Se confirma desde las ${limaDeNY(cierreHoy() - 15)}.`; }
          else if (sym === 'QQQ' && Pn.señal && ab) { st = 'ate'; tit = 'Todavía no'; mot = 'Rebote de pánico formándose'; txt = `Se confirma desde las ${limaDeNY(cierreHoy() - 15)}.`; }
          else if (m3 && ab && comp && tm < 750) { st = 'ate'; tit = 'Hoy a las ' + limaDeNY(750); mot = 'Tarde bajista'; txt = `Compra hasta las ${limaDeNY(870)} y cierra a las ${hFin}.`; }
          else if (m3) txt = 'Bajo su media de 200: solo tarde bajista, en sesión completa.';
          else if (!c.ok.tend) txt = 'Bajo su media de 200: sin operación probada.';
          else if (c.gat > c.sma200) txt = `Compra solo si ${c.manana ? 'el próximo cierre' : 'hoy cierra'} en <b>${n(c.gat)}</b> o menos.`;
          else txt = 'Caída rápida fuera de alcance por ahora.';
        }
        if (st === 'ent') E.push(nm); if (st === 'ate') A.push(nm);
        const V = vwapDe((dd.o5 || {})[sym] || (dd.b5 || {})[sym]), Es = escenarios(sym, it, dd), ref = px || it.cfd, cerca = c.atr && k ? c.atr * k * 0.15 : 0,   // v5.1: sin max pain (probado, no funciona) ni niveles pegados al precio
          gx = gexDe(it), L = gx && k ? [...gx.C.map((x, i) => ({ v: x.k * k, n: 'C' + (i + 1) })), ...gx.P.map((x, i) => ({ v: x.k * k, n: 'P' + (i + 1) })), ...(gx.hvl != null ? [{ v: gx.hvl * k, n: 'HVL' }] : [])].sort((p, q) => p.v - q.v) : ((Es && Es.N) || []).map((x) => ({ v: x.v, n: x.n.split(' + ').filter((t) => t !== 'max pain').join(' + ') })).filter((x) => x.n), arr = L.filter((x) => x.v > ref + cerca)[0], abj = L.filter((x) => x.v < ref - cerca).slice(-1)[0];
        const ivp = ((dd.pch || {})[sym] || {}).ivp; if (ivp != null && ivp >= 0.75) G.push(nm);
        const fila = (l, v, cl) => `<tr><th>${l}</th><td class="${cl || ''}">${v}</td></tr>`;
        cols += `<section class="v-a v-${st}"><header><h3>${nm}</h3><span class="v-px">${f(px, d)}</span></header><div class="v-e">${tit}</div>${mot ? `<div class="v-m">${mot}</div>` : ''}<p>${txt}</p><table>`
          + fila('Tendencia', c.estado ? '—' : (c.ok.tend ? 'Sobre media 200' : 'Bajo media 200'), c.estado ? '' : (c.ok.tend ? 'v-u' : 'v-d'))
          + fila('VWAP', V && ab ? `${V.lado > 0 ? 'Sobre' : 'Bajo'} ${Math.abs(V.pct).toFixed(2)} %` : '—', V && ab ? (V.lado > 0 ? 'v-u' : 'v-d') : '')
          + fila('Tipo de día', Es && Es.modo ? (Es.modo === 'AMPLIO' ? 'Amplio' : 'Frenado') : '—')
          + fila(gexModo() === 'acum' ? 'HVL acum.' : 'HVL 1er venc.', gx && gx.hvl != null && k ? `${ref > gx.hvl * k ? 'Sobre' : 'Bajo'} ${f(gx.hvl * k, d)}` : '—', gx && gx.hvl != null && k ? (ref > gx.hvl * k ? 'v-u' : 'v-d') : '')
          + fila(gexModo() === 'acum' ? 'Arriba (acum.)' : 'Arriba (1er venc.)', arr ? `${f(arr.v, d)} <small>${arr.n}</small>` : '—')
          + fila(gexModo() === 'acum' ? 'Abajo (acum.)' : 'Abajo (1er venc.)', abj ? `${f(abj.v, d)} <small>${abj.n}</small>` : '—')
          + '</table></section>';
      }
      const claseB = E.length ? 'ent' : A.length ? 'ate' : 'esp';
      const tituloB = E.length ? `Entrada ahora en ${E.join(", ")}` : A.length ? `Atento a ${A.join(", ")}: todavía no entres` : (ab ? 'Sin entradas ahora' : 'Mercado cerrado: sin entradas');
      const extra = [];
      if (G.length) extra.push(`<span class="v-g">⚡ Posible día grande en ${G.join(', ')}. No indica dirección.</span>`);
      for (const x of gmGet('ng_arranques', []).filter((z) => Date.now() - z.t < 18 * 3600e3)) extra.push(`<span class="v-g">⚡ ${x.nm} ${x.dir} ${Math.abs(x.atrs).toFixed(1)} ATR fuera de sesión (${x.hora}). Sin probar: no entres solo por esto.</span>`);
      if (P && !P.fin) extra.push(`<span class="${P.imp >= 3 ? 'v-g' : ''}">Próximo dato: ${P.h} ${P.n}</span>`);
      return `<div class="v-b v-${claseB}"><strong>${tituloB}</strong>${extra.join('')}</div><div class="v-g3">${cols}</div>`;
    }
    function pintar(estado) {
      const abierto = gmGet('ng_abierto', true), data = gmGet('ng_data', null), dd = gmGet('ng_dia', null), F = fase();
      // v3.4: plegado = botón chico abajo a la izquierda, para no tapar el menú de Barchart
      host.style.cssText = abierto ? 'position:fixed;left:0;right:0;top:0;z-index:2147483646;' : 'position:fixed;left:10px;bottom:10px;z-index:2147483646;';
      if (!abierto) {
        // v4.9: con el panel plegado también se evalúan las señales, suenan los avisos y se anota el diario
        if (data && dd) { try { rutinaHTML(data, dd); } catch (e) {} }
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
        .v-b{display:flex;flex-wrap:wrap;gap:4px 18px;align-items:baseline;margin-top:8px;padding:10px 14px;border-radius:4px;background:#1a2a3a;color:#c6d3e0}
        .v-b strong{font-size:20px;line-height:1.2;color:#fff;margin-right:auto}.v-b.v-ent{background:#0f8f52}.v-b.v-ate{background:#a86a00}.v-b span{font-size:13px}.v-b .v-g{color:#ffd27a;font-weight:600}.v-b.v-ent span,.v-b.v-ate span{color:#fff}
        .v-g3{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1px;margin-top:8px;background:#2b3b4e;border:1px solid #2b3b4e}
        .v-a{background:#0d1824;padding:10px 14px 12px;border-top:6px solid #4a5d70}.v-a.v-ent{border-top-color:#2ed47a;background:#0c2a1b}.v-a.v-ate{border-top-color:#ffb020}.v-a.v-off{border-top-color:#ff5468}
        .v-a header{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.v-a h3{margin:0;font-size:14px;font-weight:600;color:#9fb3c8}.v-px{font-size:16px;font-weight:600;color:#fff;font-variant-numeric:tabular-nums}
        .v-e{font-size:28px;line-height:1.15;font-weight:800;color:#8fa3b8;margin-top:6px}.v-ent .v-e{color:#2ed47a}.v-ate .v-e{color:#ffb020}.v-off .v-e{color:#ff8a96}
        .v-m{font-size:13px;font-weight:600;color:#e8eef4;margin-top:2px}.v-a p{margin:6px 0 8px;font-size:13px;line-height:1.45;color:#c6d3e0;min-height:38px}.v-a p b{color:#fff;font-variant-numeric:tabular-nums}
        .v-a table{width:100%;border-collapse:collapse;font-size:12.5px}.v-a th{text-align:left;font-weight:400;color:#7f93a8;padding:3px 0;border-top:1px solid #1e2a36;width:40%}.v-a td{text-align:right;color:#e8eef4;padding:3px 0;border-top:1px solid #1e2a36;font-variant-numeric:tabular-nums}.v-a td small{color:#7f93a8;font-size:11px}.v-u{color:#5dffa5!important}.v-d{color:#ff8a96!important}
        input{width:110px;background:#0b1118;color:#fff;border:1px solid #2b3b4e;border-radius:5px;padding:2px 5px;font:inherit;font-size:12px}
      </style><div class="b"><div class="top"><b>Plan del día</b><span class="fs" title="${F.d}">${F.n}</span><span style="flex:1"></span><span class="m">${dd ? 'datos ' + dd.hora : ''}${data ? ' · gamma ' + data.hora : ''} ${estado || ''}</span>${(() => { const o = gmGet('ng_oanda', null); return `<button id="oa" title="Conectar precio en vivo de OANDA"${gmGet('ng_detalle', false) ? '' : ' style="display:none"'}>${o ? (dd && dd.px && dd.px._error ? '⚠ OANDA' : '● OANDA') : 'OANDA'}</button>`; })()}<button id="exp" title="Descargar el registro de datos"${gmGet('ng_detalle', false) ? '' : ' style="display:none"'}>📥 registro (${gmGet('ng_reg_dias', []).length} d)</button><button id="det">${gmGet('ng_detalle', false) ? 'Ocultar detalle' : 'Ver detalle'}</button><button id="ac" title="Actualizar">↻</button><button id="tg">Plegar</button></div>`;
      const h0 = h;
      if (abierto && data && dd) {
        const cap = gmGet('ng_capital', null);
        h += '<div class="g">';
        try {   // v4.7.2: la rutina va ARRIBA, antes de las tarjetas
          h += rutinaHTML(data, dd); } catch (e) { h += `<div class="c" style="flex-basis:100%"><span class="dn">Rutina: ${e.message}</span></div>`; }
        for (const sym of Object.keys(ACTIVOS)) {
          const it = data.items[sym]; if (!it || it.error) { h += `<div class="c"><h4>${ACTIVOS[sym].nombre}</h4><span class="dn">${it ? it.error : 'sin datos'}</span></div>`; continue; }
          const d = it.dec, E = escenarios(sym, it, dd), p = PASO[sym];
          const tvl = gmGet('ng_tvlive', null), tvOk = tvl && Date.now() - tvl.t < 60e3 && tvl.px && tvl.px[sym];
          const pxV = tvOk ? tvl.px[sym] : (dd && dd.px && dd.px[ACTIVOS[sym].cfd]);
          h += `<div class="c"><h4><span>${it.nombre} ${f(pxV || it.cfd, d)}${it.viejo ? ` <small class="am" style="font-size:10.5px">⚠ gamma de las ${it.viejo} (Barchart no respondió; reintenta solo)</small>` : ''}</span><span class="m" style="font-size:11px">${tvOk ? '<b style="color:#7dffb5">● en vivo (tu TradingView)</b>' : pxV ? '<b style="color:#7dffb5">● OANDA en vivo</b>' : (it.fuenteCfd || '')}</span></h4>` + filaLectura(sym, it, dd);
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
            if (Pn.señal) { h += `<div class="sem si"><b class="up">● REBOTE DE PÁNICO ACTIVO</b> · comprar al cierre (${limaDeNY(cierreHoy() - 5)} Lima) · salir en el primer cierre sobre ${f(Pn.prevHigh * it.ratio, 0)} o a los 5 días<br><span class="m">RSI2 ${Pn.rsi.toFixed(1)} · sobre la media de 200 · crédito sano · 2007–2026: 71 % acierto, +0,31 %/op</span><span class="pr ok">probado 19 años</span></div>`;
              }
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
        const txt = (tipo) => { const H = hechos.filter((x) => x.tipo === tipo); return H.length ? `${H.length} · ${Math.round(H.filter((x) => x.r > 0).length / H.length * 100)} % ganadas · media ${(H.reduce((a, x) => a + x.r, 0) / H.length).toFixed(2)}${tipo === 'panico' || tipo === 'caida' || tipo === 'tarde' ? ' %' : ' R'}` : 'aún sin resultados'; };
        h += `</div><div class="m" style="margin-top:6px">📒 Diario en vivo — impulso 1ª hora: ${txt('impulso')} · contexto 10:30: ${txt('contexto')} · pánico: se mide en el Terminal · caída rápida: ${txt('caida')} · tarde bajista: ${txt('tarde')} · Capital para el tamaño: <input id="cap" type="number" placeholder="FALTA" value="${cap || ''}"> USD · *Imán = gamma más negativa, NO probado que atraiga. No es asesoría: datos para que decidas tú.</div>`;
        const full = h.slice(h0.length); let v = '';
        try { v = vistaHTML(data, dd); } catch (e) { v = `<div class="v-b v-esp"><strong>No se pudo armar el resumen.</strong><span>Abre Ver detalle.</span></div>`; }
        h = h0 + v + (gmGet('ng_detalle', false) ? full : '');
      }
      h += '</div>';
      const bOld = sh.querySelector('.b'), scr = bOld ? bOld.scrollTop : 0;   // v4.2: conservar el desplazamiento al refrescar
      sh.innerHTML = h;
      { const bN = sh.querySelector('.b'); if (bN && scr) bN.scrollTop = scr; }
      sh.getElementById('tg').onclick = () => { gmSet('ng_abierto', !gmGet('ng_abierto', true)); pintar(); };
      sh.getElementById('ac').onclick = () => { ciclo(true); cicloDia(true); };
      { const db = sh.getElementById('det'); if (db) db.onclick = () => { gmSet('ng_detalle', !gmGet('ng_detalle', false)); pintar(); }; }
      { const eb = sh.getElementById('exp'); if (eb) eb.onclick = exportarRegistro; }
      { const b = sh.getElementById('oa'); if (b) b.onclick = () => {
        const o = gmGet('ng_oanda', null);
        if (o && !confirm('OANDA ya está conectado (' + (o.env === 'demo' ? 'demo' : 'real') + ').\nAceptar = cambiar token · Cancelar = dejarlo')) return;
        const tok = (prompt('Pega tu token de API de OANDA (Mi cuenta → Herramientas → API). Se guarda SOLO en tu Tampermonkey. Vacío = desconectar.') || '').trim();
        if (!tok) { gmSet('ng_oanda', null); pintar('· OANDA desconectado'); return; }
        const env = confirm('¿El token es de tu cuenta REAL?\nAceptar = real · Cancelar = demo') ? 'real' : 'demo';
        gmSet('ng_oanda', { tok, env }); pintar('· conectando OANDA…'); cicloDia(true);
      }; }
      { const nb = sh.getElementById('ntf'); if (nb) nb.onclick = () => { try { Notification.requestPermission().then(() => pintar()); } catch (e) {} }; }
      for (const x of sh.querySelectorAll('input.rt')) x.onchange = () => { const R0 = gmGet('ng_rutina', { dia: hoyNY(), m: {} }); R0.m[x.dataset.k] = x.checked; gmSet('ng_rutina', R0); };
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
      try { await datosDia(); try { registrar(); gexFoto(); } catch (e) {} } catch (e) {} finally { corriendoDia = false; gmSet('ng_dlock', 0); pintar(); }
    }
    pintar();
    setTimeout(() => cicloDia(false), 3000);
    setTimeout(() => ciclo(false), 9000);
    setTimeout(() => { arranque().catch(() => {}); }, 12000);
    setInterval(() => { arranque().catch(() => {}); }, 120e3);
    setInterval(() => { cicloDia(false); ciclo(false); }, 30e3);
    // v4.2: precio y VWAP en vivo (de tu TradingView) se repintan cada 5 s, sin F5
    setInterval(() => { try { if (gmGet('ng_abierto', true) && !document.hidden) pintar(); } catch (e) {} }, 5000);
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
    flip: { col: '#ffd166' }, muro: { col: '#2fbf71' }, iman: { col: '#ff5c6c' }, mp: { col: '#9aa7b4' }, flujo: { col: '#00b0ff' }, gexC: { col: '#2fbf71' }, gexP: { col: '#ff5c6c' }, hvl: { col: '#29c5f6' },
  };
  const idsGuardados = () => { try { return JSON.parse(localStorage.getItem('ng_ids') || '{}'); } catch (e) { return {}; } };
  const guardarIds = (o) => { try { localStorage.setItem('ng_ids', JSON.stringify(o)); } catch (e) {} };
  let ultimaFirma = '';

  // v5.6: los dibujos van en fila; un clic durante un dibujo ya no deja líneas sueltas
  let dibujando = false, dibPendiente = null;
  const GX_COL = { barP: '#2fbf72', barN: '#ff5c6d', linC: '#2fbf73', linP: '#ff5c6e', hvl: '#29c5f7', marca: '#ffb021', marcaAb: '#9d8cf0', bandaV: '#2fbf74', bandaR: '#ff5c6f' };
  const GX_MIOS = Object.values(GX_COL);
  let gxSymUlt = null, gxVista = null, gxClave = '', gxCv = null, gxOffsetPrevio = null;
  // v5.9: el perfil se pinta en una capa propia sobre el gráfico: no crea dibujos en TradingView, no se guarda en la plantilla y sigue zoom y desplazamiento
  function gxPintaCapa(cv, ch, v, r) {
    const ts = ch.getTimeScale(), ps = ch.getPanes()[0].getMainSourcePriceScale(), W = r.width, H = r.height, dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    if (!v) return;
    const Y = (p) => ps.priceToCoordinate(p), dentro = (y) => y != null && y > -5 && y < H + 5, FUENTE = 'ui-monospace,Consolas,monospace';
    c.textBaseline = 'middle';
    for (const l of v.lineas) { const y = Y(l.p); if (!dentro(y)) continue; c.strokeStyle = l.col; c.globalAlpha = l.a; c.lineWidth = l.w; c.setLineDash(l.est ? [3, 4] : []); c.beginPath(); c.moveTo(0, Math.round(y) + 0.5); c.lineTo(W, Math.round(y) + 0.5); c.stroke(); }
    c.globalAlpha = 1; c.setLineDash([]);
    const x0 = W - ts.rightOffset() * ts.barSpacing(), xa = Math.min(Math.max(x0 + 10, 0), W - 250), xBanda = xa + 34, b0 = xa + 56, L = Math.min(115, W * 0.11);
    if (v.hvl != null && v.S) { const y1 = Y(v.S), y2 = Y(v.hvl); if (y1 != null && y2 != null) { c.fillStyle = v.S > v.hvl ? GX_COL.bandaV : GX_COL.bandaR; c.globalAlpha = 0.28; c.fillRect(xBanda, Math.min(y1, y2), 13, Math.abs(y2 - y1)); c.globalAlpha = 1; } }
    const orden = v.barras.slice().sort((a, b) => b.f - a.f), usadosE = [], usadosS = [];
    for (const x of orden) { const y = Y(x.p); if (!dentro(y)) continue; const col = x.pos ? GX_COL.barP : GX_COL.barN, largo = Math.max(10, x.f * L), fuerza = 0.4 + 0.6 * x.f;
      // Barra rayada: más larga y más viva cuanto más GEX tiene el strike
      c.fillStyle = col; c.globalAlpha = fuerza; for (let px = 0; px < largo; px += 3) c.fillRect(b0 + px, Math.round(y) - 3, 2, 6); c.globalAlpha = 1;
      if (!usadosS.some((u) => Math.abs(u - y) < 9)) { usadosS.push(y); c.font = '9px ' + FUENTE; c.fillStyle = col; c.globalAlpha = 0.45 + 0.55 * x.f; c.fillText(String(x.p), xa, y - 5); c.globalAlpha = 1; }
      const e = v.etiq[x.k]; if (e && !usadosE.some((u) => Math.abs(u - y) < 9)) { usadosE.push(y); let xt = b0 + largo + 14; c.font = '10px ' + FUENTE; if (e.t) { c.fillStyle = e.col; c.globalAlpha = 0.45 + 0.55 * x.f; c.fillText(e.t, xt, y); c.globalAlpha = 1; xt += c.measureText(e.t).width + 12; }
        c.font = '9px ' + FUENTE; for (const m of e.m) { c.fillStyle = /^Ab\d/.test(m) ? GX_COL.marcaAb : GX_COL.marca; c.fillText(m, xt, y); xt += c.measureText(m).width + 8; } } }
    if (v.hvl != null && v.hvlTxt) { const y = Y(v.hvl); if (dentro(y)) { const yb = v.barras.some((x) => { const q = Y(x.p); return q != null && Math.abs(q - y) < 11; }) ? y - 12 : y; c.font = '9px ' + FUENTE; c.fillStyle = '#b6bec7'; if (!usadosS.some((u) => Math.abs(u - y) < 9)) c.fillText(String(Math.round(v.hvl)), xa, y - 5); c.beginPath(); c.arc(b0 + 4, yb, 4, 0, 7); c.fillStyle = v.S > v.hvl ? GX_COL.linC : GX_COL.linP; c.fill(); c.font = '10px ' + FUENTE; c.fillStyle = GX_COL.hvl; c.fillText(v.hvlTxt, b0 + 16, yb); } }
    if (v.viejo) { c.font = '600 12px system-ui,sans-serif'; c.fillStyle = '#ffd166'; c.fillText('Datos viejos: pulsa F5 en TODAS las pestañas de Barchart', 12, 118); }
  }
  // Deja sitio a la derecha del precio al encender; al apagar devuelve el margen que había
  function gxEspacio(ch, on) { try { const ts = ch.getTimeScale(); if (on) { if (gxOffsetPrevio === null && ts.rightOffset() * ts.barSpacing() < ts.width() * 0.3) { gxOffsetPrevio = ts.rightOffset(); ts.setRightOffset(Math.round(ts.width() * 0.3 / ts.barSpacing())); } } else if (gxOffsetPrevio !== null) { ts.setRightOffset(gxOffsetPrevio); gxOffsetPrevio = null; } } catch (e) {} }
  function gxCiclo() { try {
    if (window.top !== window.self) return;
    const api = W.TradingViewApi; if (!api || !api.activeChart) return;
    const ch = api.activeChart(), w = document.querySelector('.chart-gui-wrapper'); if (!w) return;
    if (!gxCv || !gxCv.isConnected) { gxCv = document.createElement('canvas'); gxCv.id = 'ng-gex-capa'; gxCv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:5;'; w.appendChild(gxCv); gxClave = ''; }
    const r = w.getBoundingClientRect(), ts = ch.getTimeScale(), pr = ch.getPanes()[0].getMainSourcePriceScale().getVisiblePriceRange(), sym = ch.symbol();
    if (sym !== gxSymUlt) { gxSymUlt = sym; dibujar(false); } // al cambiar de símbolo limpia y redibuja en seguida
    const v = gxVista && gxVista.sym === sym ? gxVista : null;
    const clave = [Math.round(r.width), Math.round(r.height), ts.rightOffset(), ts.barSpacing(), pr && pr.from, pr && pr.to, !!v].join('|');
    if (clave !== gxClave) { gxClave = clave; gxPintaCapa(gxCv, ch, v, r); }
  } catch (e) {} }
  if (window.top === window.self) setInterval(gxCiclo, 200);
  async function dibujar(forzar) {
    if (dibujando) { dibPendiente = !!(dibPendiente || forzar); return; }
    dibujando = true;
    try { await dibujarYa(forzar); } finally { dibujando = false; }
    if (dibPendiente !== null) { const f = dibPendiente; dibPendiente = null; await dibujar(f); }
  }
  async function dibujarYa(forzar) {
    const api = W.TradingViewApi;
    if (!api || !api.activeChart) return;
    let ch; try { ch = api.activeChart(); } catch (e) { return; }
    const sym = ch.symbol();
    const etf = ETF_DE(sym);
    const data = gmGet('ng_data', null);
    // v5.6: apagado borra siempre, aunque falten datos o el símbolo no tenga ETF
    const on = gmGet('ng_lineas', true);
    const it = etf && data && data.items[etf] && !data.items[etf].error ? data.items[etf] : null;
    if (on && !it) return;
    // v1.1: si el gráfico ES el ETF (QQQ, DIA, GLD de cualquier bolsa) los niveles van tal cual;
    // si es el CFD/índice, se convierten con la relación en vivo CFD/ETF.
    const esEtf = String(sym).split(':').pop().toUpperCase() === etf;
    if (on && !esEtf && !it.ratio && !it.gexI) return;
    const usaI = !esEtf && it && it.gexI, k = esEtf || usaI ? 1 : (it ? it.ratio : 1), dec = esEtf ? 2 : (it ? it.dec : 2);
    // v5.7: perfil al estilo de escalera: líneas finas sin texto, strikes, barras, etiquetas, marcas y banda precio–HVL
    const px = (v) => +(v * k).toFixed(dec), lineas = [], barras = [], etiq = {};
    const G = on && it ? (usaI ? it.gexI : it.gex) : null, gx = G ? G[gexModo()] : null;
    let hvlTxt = '';
    if (G && gx) {
      gx.C.forEach((x, i) => { etiq[x.k] = { t: `C${i + 1}`, col: GX_COL.linC, m: [] }; lineas.push({ p: px(x.k), col: GX_COL.linC, w: i === 0 ? 1.5 : 1, est: i > 0, a: i === 0 ? 0.85 : i < 3 ? 0.4 : 0.2 }); });
      gx.P.forEach((x, i) => { etiq[x.k] = { t: `P${i + 1}`, col: GX_COL.linP, m: [] }; lineas.push({ p: px(x.k), col: GX_COL.linP, w: i === 0 ? 1.5 : 1, est: i > 0, a: i === 0 ? 0.85 : i < 3 ? 0.4 : 0.2 }); });
      if (gx.hvl != null) { lineas.push({ p: px(gx.hvl), col: '#8a96a3', w: 1, est: false, a: 0.7 }); hvlTxt = gexModo() === 'acum' ? 'HVL Σ4V' : `HVL ${G.dte}DTE (${G.venc.slice(5).replace('-', '/')})`; }
      const marca = (kk, t) => { if (kk == null) return; if (!etiq[kk]) etiq[kk] = { t: '', col: GX_COL.marca, m: [] }; etiq[kk].m.push(t); };
      if (gx.M) { (gx.M.Ab || []).forEach((kk, i) => marca(kk, `Ab${i + 1}`)); for (const t of ['nCOI', 'COI', 'AbOI', 'nPOI', 'POI']) marca(gx.M[t], t); }
      // Solo strikes con etiqueta o marca, como en el diseño de referencia
      const mx = Math.max(1, ...gx.B.map((x) => Math.abs(x.g))), gde = {}; for (const x of [...gx.B, ...gx.C, ...gx.P]) gde[x.k] = x.g;
      for (const kk of Object.keys(etiq).map(Number)) barras.push({ k: kk, p: px(kk), f: Math.abs(gde[kk] || 0) / mx, pos: gde[kk] != null ? gde[kk] > 0 : etiq[kk].t[0] !== 'P' }); }
    gxVista = on && G && gx ? { sym, lineas, barras, etiq, S: G.S ? px(G.S) : null, hvl: gx.hvl != null ? px(gx.hvl) : null, hvlTxt, viejo: !gx.M || (!esEtf && it.gexI === undefined && ACTIVOS[etf].gexIdx) } : null; gxEspacio(ch, !!gxVista); gxClave = '';
    const firma = (on ? 'on|' : 'off|') + sym + '|' + (G ? G.S : '') + '|' + hvlTxt + JSON.stringify(lineas) + JSON.stringify(barras.map((x) => [x.p, +x.f.toFixed(2)])) + JSON.stringify(etiq);
    if (!forzar && firma === ultimaFirma) return;

    // borrar SOLO las líneas de este script: v2.2 las reconoce por su TEXTO ("S·…", "E·…", "MAXPAIN …" con "(DIA|QQQ|GLD …)"),
    // porque TradingView cambia el id interno al recargar el gráfico guardado y así quedaban líneas viejas duplicadas.
    const ids = idsGuardados();
    const MIA = /^(S·|E·|F·|MAXPAIN |C\d|P\d|HVL |GX )[\s\S]*\((DIA|QQQ|GLD) [\d.]+\)$/;
    for (const x of ch.getAllShapes() || []) {
      if (!['horizontal_line', 'trend_line', 'text', 'rectangle'].includes(x.name)) continue;
      let txt = '', colB = '';
      try { const pr = ch.getShapeById(x.id).getProperties() || {}; txt = pr.text || ''; colB = String(x.name === 'text' || x.name === 'rectangle' ? pr.color || '' : pr.linecolor || '').toLowerCase(); } catch (err) {}
      // v5.5: las barras no llevan texto; se reconocen por su color exclusivo
      if (GX_MIOS.includes(colB) || MIA.test(String(txt).trim()) || (ids[sym] || []).map(String).includes(String(x.id))) { try { ch.removeEntity(x.id); } catch (err) {} }
    }
    const nuevos = [];
    ids[sym] = nuevos; guardarIds(ids);
    ultimaFirma = firma;
  }

  try { GM_addValueChangeListener('ng_data', () => dibujar(false)); } catch (e) {}
  // v5.6: un solo botón GEX con tres estados: 1.er vencimiento → acumulado → apagado
  function botonGex() {
    if (window.top !== window.self || document.getElementById('ng-gex-btn')) return;
    const b = document.createElement('div'); b.id = 'ng-gex-btn';
    const pint = () => { const on = gmGet('ng_lineas', true), ac = gexModo() === 'acum';
      b.textContent = !on ? '○ GEX: apagado' : ac ? '● GEX: acumulado' : '● GEX: 1.er venc.';
      b.title = 'Clic para cambiar: 1.er vencimiento → acumulado → apagado';
      const col = on ? '#29c5f6' : '#8a96a3';
      b.style.cssText = 'position:fixed;left:400px;bottom:58px;z-index:99999;padding:3px 8px;border-radius:6px;cursor:pointer;user-select:none;font:600 11px system-ui,sans-serif;border:1px solid ' + (on ? '#29c5f6' : '#55606b') + ';background:rgba(11,21,32,.85);color:' + col + ';'; };
    b.onclick = () => {
      if (!gmGet('ng_lineas', true)) { gmSet('ng_gexmodo', 'primero'); gmSet('ng_lineas', true); }
      else if (gexModo() === 'primero') gmSet('ng_gexmodo', 'acum');
      else gmSet('ng_lineas', false);
      pint(); dibujar(true); };
    pint(); document.body.appendChild(b);
    for (const clave of ['ng_gexmodo', 'ng_lineas']) { try { GM_addValueChangeListener(clave, (k, o, n, remoto) => { if (remoto) { pint(); dibujar(true); } }); } catch (e) {} }
  }
  setTimeout(botonGex, 3000);
  // v4.4: botón PANEL ON/OFF → oculta o muestra el panel del indicador "Liquidez · Barridos" (cambia su opción "Panel resumen: tamaño")
  function liqPanel() {
    try {
      const ch = W.TradingViewApi && W.TradingViewApi.activeChart && W.TradingViewApi.activeChart(); if (!ch) return null;
      const s = ch.getAllStudies().find((x) => /Liquidez/i.test(x.name)); if (!s) return null;
      const st = ch.getStudyById(s.id); const inf = st.getInputsInfo(); const it = inf.find((x) => /Panel resumen: tama/i.test(x.name)); if (!it) return null;
      const v = (st.getInputValues().find((x) => x.id === it.id) || {}).value;
      return { st, id: it.id, v };
    } catch (e) { return null; }
  }
  function botonPanel() {
    if (window.top !== window.self || document.getElementById('ng-pan-btn')) return;
    const b = document.createElement('div'); b.id = 'ng-pan-btn';
    const pint = () => { const p = liqPanel(); b.style.display = p ? '' : 'none'; if (!p) return; const on = p.v !== 'Oculto';
      b.textContent = on ? '● PANEL ON' : '○ PANEL OFF';
      b.title = on ? 'Clic para OCULTAR el panel de Liquidez · Barridos' : 'Clic para MOSTRAR el panel de Liquidez · Barridos';
      b.style.cssText = 'position:fixed;left:540px;bottom:58px;z-index:99999;padding:3px 8px;border-radius:6px;cursor:pointer;user-select:none;'
        + 'font:600 11px system-ui,sans-serif;letter-spacing:.3px;border:1px solid ' + (on ? '#e040fb' : '#55606b') + ';'
        + 'background:rgba(11,21,32,.85);color:' + (on ? '#e040fb' : '#8a96a3') + ';'; };
    b.onclick = () => { const p = liqPanel(); if (!p) return;
      if (p.v !== 'Oculto') { gmSet('ng_panel_modo', p.v || 'Mínimo'); p.st.setInputValues([{ id: p.id, value: 'Oculto' }]); }
      else p.st.setInputValues([{ id: p.id, value: gmGet('ng_panel_modo', 'Mínimo') }]);
      setTimeout(pint, 400); };
    pint(); document.body.appendChild(b); setInterval(pint, 3000);
  }
  setTimeout(botonPanel, 4000);
  setInterval(() => dibujar(false), 15e3);

  // v3.9: PRECIO EN VIVO desde TU TradingView (la lista de seguimiento que ya ves en pantalla) → se comparte con el Plan del Día.
  // Lee solo lo que tu gráfico ya muestra; no abre conexiones nuevas. Además, si el gráfico está en NAS100/US30/ORO,
  // calcula el VWAP desde las 09:30 NY con las velas del propio gráfico (temporalidad ≤ 1 h).
  const LIVE = { 'OANDA:NAS100USD': 'QQQ', 'OANDA:US30USD': 'DIA', 'OANDA:XAUUSD': 'GLD' };
  const numTV = (t) => { t = String(t || '').replace(/[^\d.,-]/g, ''); if (!t) return null;
    const a = t.lastIndexOf(','), b = t.lastIndexOf('.'); if (a > -1 && b > -1) t = a > b ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    else if (a > -1) t = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
    else if (b > -1 && /^-?\d{1,3}(\.\d{3})+$/.test(t) && t.split('.').length > 2) t = t.replace(/\./g, '');
    const v = parseFloat(t); return isFinite(v) ? v : null; };
  function leerVivo() {
    try {
      const px = {};
      for (const row of document.querySelectorAll('[data-symbol-full]')) {
        const full = row.getAttribute('data-symbol-full'); if (!LIVE[full] || px[LIVE[full]]) continue;
        const cel = row.querySelector('[class*="last-"], [class*="last"]'); const v = numTV(cel && cel.textContent);
        if (v > 0) px[LIVE[full]] = v;
      }
      const vw = {}; const api = W.TradingViewApi;
      if (api && api.activeChart) { const ch = api.activeChart(), full = ch.symbol(), etf = LIVE[full];
        if (etf && +ch.resolution() <= 60) { try { const b = ch._chartWidget.model().mainSeries().bars(); let pv = 0, vv = 0, ult = null;
          const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          for (let i = b.firstIndex(); i <= b.lastIndex(); i++) { const x = b.valueAt(i); if (!x) continue; const d = new Date(x[0] * 1000);
            if (d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) !== hoy || d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) < '09:30') continue;
            const v = x[5] || 1; pv += (x[2] + x[3] + x[4]) / 3 * v; vv += v; ult = x[4]; }
          if (vv > 0) { vw[etf] = { vw: pv / vv, u: px[etf] || ult }; if (!px[etf] && ult) px[etf] = ult; } } catch (e) {} } }
      if (Object.keys(px).length) { const prev = gmGet('ng_tvlive', null) || {}; const vwM = { ...(prev.vw || {}) }; for (const k in vw) vwM[k] = { ...vw[k], t: Date.now() };
        gmSet('ng_tvlive', { t: Date.now(), px, vw: vwM }); }
    } catch (e) {}
  }
  setInterval(leerVivo, 3000);
  setTimeout(() => dibujar(true), 8000);
})();
