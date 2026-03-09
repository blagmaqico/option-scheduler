const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');
const moment = require('moment-timezone');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── CONFIG — wszystko w Render Environment Variables (trwałe przez restarty) ──
// Zapis przez Render API: PATCH /services/{id}/env-vars
// Odczyt: process.env.*

const RENDER_API_KEY = process.env.RENDER_API_KEY || '';
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || '';

// Załaduj config z env vars (trwałe) + fallback do pliku
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  // Najpierw spróbuj z env vars (trwałe)
  let fromEnv = {};
  if (process.env.APP_CONFIG) {
    try { fromEnv = JSON.parse(process.env.APP_CONFIG); } catch(e) {}
  }
  // Fallback do pliku
  let fromFile = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch(e) {}
  }
  const base = Object.keys(fromEnv).length ? fromEnv : fromFile;
  return {
    tickers:      base.tickers      || [],
    expiryDate:   base.expiryDate   || '',
    times:        base.times        || ['15:30', '15:45', '16:00'],
    schedulerOn:  base.schedulerOn  || false,
    emailTo:      process.env.EMAIL_TO      || base.emailTo      || '',
    emailUser:    process.env.EMAIL_USER    || base.emailUser    || '',
    emailPass:    process.env.EMAIL_PASS    || base.emailPass    || '',
    emailService: process.env.EMAIL_SERVICE || base.emailService || 'gmail',
  };
}

async function saveConfig(cfg) {
  // 1. Zawsze zapisz do pliku (backup)
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch(e) {
    addLog(`Zapis pliku: ${e.message}`, 'warn');
  }

  // 2. Zapisz do Render Environment Variables przez API (trwałe przez restarty)
  if (RENDER_API_KEY && RENDER_SERVICE_ID) {
    try {
      const appConfig = JSON.stringify({
        tickers: cfg.tickers,
        expiryDate: cfg.expiryDate,
        times: cfg.times,
        schedulerOn: cfg.schedulerOn,
      });
      const resp = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${RENDER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([
          { key: 'EMAIL_TO',      value: process.env.EMAIL_TO || cfg.emailTo || '' },
          { key: 'EMAIL_USER',    value: process.env.EMAIL_USER || cfg.emailUser || '' },
          { key: 'EMAIL_PASS',    value: process.env.EMAIL_PASS || cfg.emailPass || '' },
          { key: 'EMAIL_SERVICE', value: process.env.EMAIL_SERVICE || cfg.emailService || 'gmail' },
          { key: 'RESEND_API_KEY', value: process.env.RESEND_API_KEY || '' },
          { key: 'RAPIDAPI_KEY',  value: process.env.RAPIDAPI_KEY || '' },
          { key: 'RENDER_API_KEY', value: RENDER_API_KEY },
          { key: 'RENDER_SERVICE_ID', value: RENDER_SERVICE_ID },
          { key: 'APP_CONFIG',    value: appConfig },
        ])
      });
      if (resp.ok) {
        addLog('Config zapisany trwale w Render ENV ✓', 'ok');
      } else {
        const err = await resp.text();
        addLog(`Render API: ${resp.status} ${err.slice(0,100)}`, 'warn');
      }
    } catch(e) {
      addLog(`Render ENV save: ${e.message}`, 'warn');
    }
  } else {
    addLog('Brak RENDER_API_KEY/SERVICE_ID — config tylko w pliku', 'warn');
  }
}

let config = loadConfig();

// ─── LOG ────────────────────────────────────────────────────────────────────
const MAX_LOGS = 200;
let logs = [];

function addLog(msg, type = 'info') {
  const entry = { time: moment().tz('Europe/Warsaw').format('HH:mm:ss'), msg, type };
  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(0, MAX_LOGS);
  console.log(`[${entry.time}] [${type.toUpperCase()}] ${msg}`);
}

// ─── CRON ────────────────────────────────────────────────────────────────────
let activeCrons = [];

function buildCronExpr(timeStr) {
  const [h, m] = timeStr.split(':');
  return `${parseInt(m)} ${parseInt(h)} * * 1-5`;
}

function startAllCrons() {
  stopAllCrons();
  if (!config.schedulerOn) return;
  for (const t of config.times) {
    const expr = buildCronExpr(t);
    addLog(`Cron: "${t}" → ${expr}`, 'info');
    const job = cron.schedule(expr, async () => {
      addLog(`⏰ Wyzwolono o ${t}`, 'info');
      await runFetchAndSend(t);
    }, { timezone: 'Europe/Warsaw' });
    activeCrons.push({ time: t, job });
  }
  addLog(`Scheduler aktywny — ${activeCrons.length} zadań`, 'ok');
}

function stopAllCrons() {
  for (const { job } of activeCrons) { try { job.destroy(); } catch(e) {} }
  activeCrons = [];
}

// ─── YAHOO FINANCE ───────────────────────────────────────────────────────────
async function fetchOptionChain(ticker, expiryDate) {
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  const ts = expiryDate ? Math.floor(new Date(expiryDate).getTime() / 1000) : null;

  if (rapidApiKey) {
    // Use RapidAPI Yahoo Finance
    try {
      addLog(`RapidAPI fetch: ${ticker}`, 'info');
      // Correct endpoint for options chain
      const url = `https://apidojo-yahoo-finance-v1.p.rapidapi.com/stock/v3/get-options?symbol=${ticker}${ts ? '&date='+ts : ''}`;
      const resp = await fetch(url, {
        headers: {
          'x-rapidapi-host': 'apidojo-yahoo-finance-v1.p.rapidapi.com',
          'x-rapidapi-key': rapidApiKey
        }
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`RapidAPI HTTP ${resp.status}: ${text.slice(0,200)}`);
      let json;
      try { json = JSON.parse(text); } catch(e) { throw new Error(`JSON parse: ${text.slice(0,200)}`); }
      const chain = json?.optionChain?.result?.[0];
      if (!chain) throw new Error(`Brak option chain. Keys: ${Object.keys(json||{}).join(',')}`);
      const opts = chain.options?.[0];
      if (!opts) throw new Error('Brak opcji dla tej daty');
      const underlyingPrice = chain.quote?.regularMarketPrice || null;
      const calls = selectByDelta(opts.calls || [], [0.50, 0.40, 0.30, 0.20], underlyingPrice, 'call');
      const puts  = selectByDelta(opts.puts  || [], [0.50, 0.40, 0.30, 0.20], underlyingPrice, 'put');
      addLog(`RapidAPI OK: ${ticker} $${underlyingPrice?.toFixed(2)||'?'}`, 'ok');
      return { calls, puts, underlyingPrice, expirationDate: opts.expirationDate };
    } catch(e) {
      addLog(`RapidAPI error: ${e.message} — próbuję bezpośrednio`, 'warn');
    }
  }

  // Fallback: direct Yahoo
  const urls = [
    `https://query2.finance.yahoo.com/v8/finance/options/${ticker}${ts ? '?date='+ts : ''}`,
    `https://query1.finance.yahoo.com/v8/finance/options/${ticker}${ts ? '?date='+ts : ''}`,
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
          'Referer': 'https://finance.yahoo.com/',
        }
      });
      if (!resp.ok) { lastErr = new Error(`HTTP ${resp.status}`); continue; }
      const json = await resp.json();
      const chain = json?.optionChain?.result?.[0];
      if (!chain) { lastErr = new Error('Brak danych'); continue; }
      const opts = chain.options?.[0];
      if (!opts) { lastErr = new Error('Brak opcji'); continue; }
      const underlyingPrice = chain.quote?.regularMarketPrice || null;
      const calls = selectByDelta(opts.calls || [], [0.50, 0.40, 0.30, 0.20], underlyingPrice, 'call');
      const puts  = selectByDelta(opts.puts  || [], [0.50, 0.40, 0.30, 0.20], underlyingPrice, 'put');
      return { calls, puts, underlyingPrice, expirationDate: opts.expirationDate };
    } catch(e) { lastErr = e; }
  }
  throw lastErr || new Error('Wszystkie metody zawiodły');
}

function selectByDelta(options, deltas, underlyingPrice, type) {
  if (!options.length) return [];
  const sorted = [...options].sort((a, b) => a.strike - b.strike);

  // Assign BS-approximated delta to every option
  const withDelta = sorted.map(opt => {
    let d = opt.greeks?.delta;
    if (d == null) d = bsDelta(opt.strike, underlyingPrice, opt.impliedVolatility, type);
    // lastPrice: use lastPrice field, fallback to regularMarketPrice
    const last = opt.lastPrice ?? opt.regularMarketPrice ?? null;
    return { ...opt, approxDelta: Math.abs(d), lastPrice: last };
  });

  const result = [];
  for (const targetDelta of deltas) {
    let best = null, bestDiff = Infinity;
    for (const opt of withDelta) {
      const diff = Math.abs(opt.approxDelta - targetDelta);
      if (diff < bestDiff) { bestDiff = diff; best = { ...opt, targetDelta }; }
    }
    if (best && !result.find(r => r.strike === best.strike)) result.push(best);
  }
  return result.sort((a, b) => b.targetDelta - a.targetDelta);
}

// Black-Scholes delta approximation using IV from Yahoo
function bsDelta(strike, spot, iv, type) {
  if (!spot || !strike) return type === 'call' ? 0.5 : 0.5;

  // Use IV from Yahoo if available, otherwise estimate from moneyness
  const sigma = (iv && iv > 0 && iv < 5) ? iv : estimateIV(strike, spot);
  const T = 30 / 365; // assume ~30 days to expiry as fallback
  const r = 0.05; // risk-free rate

  const d1 = (Math.log(spot / strike) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const nd1 = normalCDF(d1);

  return type === 'call' ? nd1 : 1 - nd1;
}

function estimateIV(strike, spot) {
  // Rough IV estimate based on moneyness — typical for SPY/QQQ
  const m = Math.abs(Math.log(spot / strike));
  if (m < 0.01) return 0.15;
  if (m < 0.02) return 0.16;
  if (m < 0.04) return 0.18;
  if (m < 0.06) return 0.20;
  return 0.22;
}

function normalCDF(x) {
  // Abramowitz & Stegun approximation
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t*Math.exp(-x*x);
  return 0.5 * (1.0 + sign * y);
}

// ─── EMAIL (Resend API - HTTP port 443, works on Render free) ────────────────

function buildEmailHtml(results, scheduledTime) {
  const now = moment().tz('Europe/Warsaw').format('DD.MM.YYYY HH:mm:ss');
  const deltas = [0.50, 0.40, 0.30, 0.20];

  let html = `<div style="font-family:'Courier New',monospace;background:#0a0c0f;color:#e8edf5;padding:32px;border-radius:12px;max-width:900px;">
    <div style="border-bottom:2px solid #00e5a0;padding-bottom:16px;margin-bottom:24px;">
      <h2 style="color:#00e5a0;margin:0;font-size:22px;letter-spacing:2px;">📊 OPTION CHAIN REPORT</h2>
      <p style="color:#5a6478;margin:8px 0 0;font-size:13px;">
        Data: ${now} (CET/CEST) &nbsp;|&nbsp; Godzina: <strong style="color:#fff">${scheduledTime}</strong>
        &nbsp;|&nbsp; Expiration: <strong style="color:#fff">${config.expiryDate}</strong>
      </p>
    </div>`;

  for (const { ticker, data, error } of results) {
    html += `<div style="margin-bottom:32px;">
      <h3 style="color:#fff;font-size:16px;letter-spacing:2px;margin:0 0 4px;">${ticker}
        ${data?.underlyingPrice ? `<span style="color:#5a6478;font-size:13px;font-weight:normal;margin-left:12px;">Cena: <strong style="color:#00e5a0">$${data.underlyingPrice.toFixed(2)}</strong></span>` : ''}
      </h3>`;
    if (error || !data) {
      html += `<p style="color:#ff4d6d;">❌ Błąd: ${error || 'Brak danych'}</p></div>`;
      continue;
    }
    html += `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px;">
      <tr>
        <th colspan="4" style="background:#0d1a14;color:#00c98a;padding:10px;text-align:center;border:1px solid #1f2530;">CALL</th>
        <th style="background:#111318;color:#e8edf5;padding:10px;text-align:center;border:1px solid #1f2530;">DELTA</th>
        <th colspan="4" style="background:#1a0d12;color:#ff4d6d;padding:10px;text-align:center;border:1px solid #1f2530;">PUT</th>
      </tr>
      <tr>
        <th style="background:#111318;color:#00c98a;padding:8px 14px;border:1px solid #1f2530;text-align:center;">STRIKE</th>
        <th style="background:#111318;color:#00c98a;padding:8px 14px;border:1px solid #1f2530;text-align:center;">BID</th>
        <th style="background:#111318;color:#00c98a;padding:8px 14px;border:1px solid #1f2530;text-align:center;">ASK</th>
        <th style="background:#111318;color:#00c98a;padding:8px 14px;border:1px solid #1f2530;text-align:center;">LAST</th>
        <th style="background:#111318;padding:8px;border:1px solid #1f2530;"></th>
        <th style="background:#111318;color:#ff4d6d;padding:8px 14px;border:1px solid #1f2530;text-align:center;">STRIKE</th>
        <th style="background:#111318;color:#ff4d6d;padding:8px 14px;border:1px solid #1f2530;text-align:center;">BID</th>
        <th style="background:#111318;color:#ff4d6d;padding:8px 14px;border:1px solid #1f2530;text-align:center;">ASK</th>
        <th style="background:#111318;color:#ff4d6d;padding:8px 14px;border:1px solid #1f2530;text-align:center;">LAST</th>
      </tr>`;
    for (const d of deltas) {
      const c = data.calls.find(x => x.targetDelta === d) || {};
      const p = data.puts.find(x => x.targetDelta === d) || {};
      const fv = v => v != null ? '$'+Number(v).toFixed(2) : '—';
      html += `<tr>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;color:#00c98a;font-weight:bold;">${c.strike ? '$'+c.strike.toFixed(2) : '—'}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;">${fv(c.bid)}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;">${fv(c.ask)}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;color:#aaa;">${fv(c.lastPrice)}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;background:#111318;">
          <span style="background:rgba(0,229,160,0.1);border:1px solid rgba(0,229,160,0.3);border-radius:4px;padding:2px 8px;color:#00e5a0;font-size:12px;">Δ${d.toFixed(2)}</span>
        </td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;color:#ff4d6d;font-weight:bold;">${p.strike ? '$'+p.strike.toFixed(2) : '—'}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;">${fv(p.bid)}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;">${fv(p.ask)}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;color:#aaa;">${fv(p.lastPrice)}</td>
      </tr>`;
    }
    html += `</table></div>`;
  }
  html += `<div style="border-top:1px solid #1f2530;margin-top:24px;padding-top:16px;color:#5a6478;font-size:11px;">
    Option Chain Scheduler • Europe/Warsaw
  </div></div>`;
  return html;
}

async function sendEmail(scheduledTime, results) {
  const resendKey = process.env.RESEND_API_KEY || config.resendApiKey;
  if (!resendKey) {
    addLog('Brak RESEND_API_KEY — ustaw w Render Environment', 'err');
    return false;
  }
  if (!config.emailTo) {
    addLog('Brak EMAIL_TO', 'err');
    return false;
  }
  addLog(`Wysyłam email → ${config.emailTo}`, 'info');
  const html = buildEmailHtml(results, scheduledTime);
  const date = moment().tz('Europe/Warsaw').format('DD.MM.YYYY');
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Option Scheduler <onboarding@resend.dev>',
        to: [config.emailTo],
        subject: `📊 Option Chain ${config.tickers.join('/')} — ${scheduledTime} — ${date}`,
        html
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || JSON.stringify(data));
    addLog(`✅ Email wysłany → ${config.emailTo}`, 'ok');
    return true;
  } catch(e) {
    addLog(`❌ Błąd email: ${e.message}`, 'err');
    return false;
  }
}

// ─── FETCH & SEND ─────────────────────────────────────────────────────────────
async function runFetchAndSend(scheduledTime) {
  const results = [];
  for (const ticker of config.tickers) {
    addLog(`Pobieram: ${ticker} exp ${config.expiryDate}`, 'info');
    try {
      const data = await fetchOptionChain(ticker, config.expiryDate);
      results.push({ ticker, data });
      addLog(`${ticker} ✓ cena: $${data.underlyingPrice?.toFixed(2) || '?'}`, 'ok');
    } catch(e) {
      addLog(`${ticker} ✗ ${e.message}`, 'err');
      results.push({ ticker, data: null, error: e.message });
    }
  }
  await sendEmail(scheduledTime, results);
  return results;
}

// ─── API ──────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    config: { ...config, emailPass: config.emailPass ? '••••••••' : '' },
    logs: logs.slice(0, 50),
    activeCrons: activeCrons.map(c => c.time),
    serverTime: moment().tz('Europe/Warsaw').format('HH:mm:ss'),
    serverDate: moment().tz('Europe/Warsaw').format('YYYY-MM-DD'),
    isWeekend: [0, 6].includes(moment().tz('Europe/Warsaw').day())
  });
});

app.post('/api/config', async (req, res) => {
  const prev = { ...config };
  config = { ...config, ...req.body };
  if (req.body.emailPass === '••••••••') config.emailPass = prev.emailPass;
  await saveConfig(config);
  addLog('Konfiguracja zapisana ✓', 'ok');
  if (config.schedulerOn) startAllCrons(); else stopAllCrons();
  res.json({ ok: true });
});

app.post('/api/scheduler/toggle', async (req, res) => {
  config.schedulerOn = req.body.on;
  await saveConfig(config);
  if (config.schedulerOn) { startAllCrons(); addLog('Scheduler WŁĄCZONY ✓', 'ok'); }
  else { stopAllCrons(); addLog('Scheduler WYŁĄCZONY', 'warn'); }
  res.json({ ok: true, on: config.schedulerOn });
});

app.post('/api/fetch-now', async (req, res) => {
  addLog('Manualne pobieranie...', 'info');
  const results = await runFetchAndSend('MANUALNE');
  res.json({ ok: true, results: results.map(r => ({ ticker: r.ticker, ok: !!r.data, error: r.error })) });
});

app.post('/api/preview', async (req, res) => {
  const { ticker, expiryDate } = req.body;
  try {
    const data = await fetchOptionChain(ticker, expiryDate);
    res.json({ ok: true, data });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/test-email', async (req, res) => {
  addLog('Testowy email...', 'info');
  addLog(`Config: user=${config.emailUser} to=${config.emailTo} pass=${config.emailPass ? 'OK' : 'BRAK'}`, 'info');
  const fakeResults = [{ ticker: 'TEST', data: null, error: 'Testowy email — bez danych' }];
  const ok = await sendEmail('TEST', fakeResults);
  res.json({ ok });
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog(`Serwer na porcie ${PORT}`, 'ok');
  addLog(`Email user: ${config.emailUser || 'BRAK — ustaw EMAIL_USER w Render Environment'}`, config.emailUser ? 'ok' : 'warn');
  addLog(`Email to: ${config.emailTo || 'BRAK — ustaw EMAIL_TO w Render Environment'}`, config.emailTo ? 'ok' : 'warn');
  if (config.schedulerOn) startAllCrons();
});
