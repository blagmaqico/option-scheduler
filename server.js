const express = require('express');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const moment = require('moment-timezone');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── CONFIG ─────────────────────────────────────────────────────────────────
// Email credentials come from Render Environment Variables (trwałe)
// Reszta konfiguracji zapisywana do pliku (może zniknąć przy restarcie — ale
// na free tier Render dysk JEST dostępny w /opt/render/project/src)
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  let saved = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch(e) {}
  }
  return {
    tickers:      saved.tickers      || [],
    expiryDate:   saved.expiryDate   || '',
    times:        saved.times        || ['15:30', '15:45', '16:00'],
    schedulerOn:  saved.schedulerOn  || false,
    // Email — najpierw env vars, potem zapisany config, potem pusty
    emailTo:      process.env.EMAIL_TO      || saved.emailTo      || '',
    emailUser:    process.env.EMAIL_USER    || saved.emailUser    || '',
    emailPass:    process.env.EMAIL_PASS    || saved.emailPass    || '',
    emailService: process.env.EMAIL_SERVICE || saved.emailService || 'gmail',
  };
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch(e) {
    addLog(`Zapis config: ${e.message}`, 'warn');
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
  // Try v8 first, fallback to v7
  const ts = expiryDate ? Math.floor(new Date(expiryDate).getTime() / 1000) : null;
  const urls = [
    `https://query2.finance.yahoo.com/v8/finance/options/${ticker}${ts ? '?date='+ts : ''}`,
    `https://query1.finance.yahoo.com/v8/finance/options/${ticker}${ts ? '?date='+ts : ''}`,
    `https://query1.finance.yahoo.com/v7/finance/options/${ticker}${ts ? '?date='+ts : ''}`,
  ];

  let lastErr;
  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      if (!resp.ok) { lastErr = new Error(`HTTP ${resp.status}`); continue; }
      const json = await resp.json();
      const chain = json?.optionChain?.result?.[0];
      if (!chain) { lastErr = new Error('Brak danych option chain'); continue; }
      const opts = chain.options?.[0];
      if (!opts) { lastErr = new Error('Brak opcji dla tej daty'); continue; }

      const underlyingPrice = chain.quote?.regularMarketPrice || null;
      const calls = selectByDelta(opts.calls || [], [0.50, 0.40, 0.30, 0.20], underlyingPrice, 'call');
      const puts  = selectByDelta(opts.puts  || [], [0.50, 0.40, 0.30, 0.20], underlyingPrice, 'put');
      return { calls, puts, underlyingPrice, expirationDate: opts.expirationDate };
    } catch(e) { lastErr = e; }
  }
  throw lastErr || new Error('Wszystkie URL-e Yahoo zawiodły');
}

function selectByDelta(options, deltas, underlyingPrice, type) {
  if (!options.length) return [];
  const sorted = [...options].sort((a, b) => a.strike - b.strike);
  const result = [];
  for (const targetDelta of deltas) {
    let best = null, bestDiff = Infinity;
    for (const opt of sorted) {
      let d = opt.greeks?.delta;
      if (d == null && underlyingPrice) d = approximateDelta(opt.strike, underlyingPrice, type);
      if (d == null) {
        const idx = sorted.indexOf(opt);
        d = type === 'call' ? 1 - idx / sorted.length : idx / sorted.length;
      }
      const diff = Math.abs(Math.abs(d) - targetDelta);
      if (diff < bestDiff) { bestDiff = diff; best = { ...opt, approxDelta: d, targetDelta }; }
    }
    if (best && !result.find(r => r.strike === best.strike)) result.push(best);
  }
  return result.sort((a, b) => b.targetDelta - a.targetDelta);
}

function approximateDelta(strike, underlying, type) {
  const m = underlying / strike;
  if (type === 'call') {
    if (m > 1.05) return 0.75; if (m > 1.02) return 0.60;
    if (m > 0.99) return 0.50; if (m > 0.96) return 0.38;
    if (m > 0.93) return 0.27; return 0.15;
  } else {
    if (m < 0.95) return 0.75; if (m < 0.98) return 0.60;
    if (m < 1.01) return 0.50; if (m < 1.04) return 0.38;
    if (m < 1.07) return 0.27; return 0.15;
  }
}

// ─── EMAIL ───────────────────────────────────────────────────────────────────
function createTransporter() {
  if (config.emailService === 'gmail') {
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: config.emailUser, pass: config.emailPass }
    });
  } else {
    return nodemailer.createTransport({
      host: 'smtp-mail.outlook.com',
      port: 587,
      secure: false,
      auth: { user: config.emailUser, pass: config.emailPass }
    });
  }
}

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
        <th colspan="3" style="background:#0d1a14;color:#00c98a;padding:10px;text-align:center;border:1px solid #1f2530;">CALL</th>
        <th style="background:#111318;color:#e8edf5;padding:10px;text-align:center;border:1px solid #1f2530;">DELTA</th>
        <th colspan="3" style="background:#1a0d12;color:#ff4d6d;padding:10px;text-align:center;border:1px solid #1f2530;">PUT</th>
      </tr>
      <tr>
        <th style="background:#111318;color:#00c98a;padding:8px 14px;border:1px solid #1f2530;text-align:center;">STRIKE</th>
        <th style="background:#111318;color:#00c98a;padding:8px 14px;border:1px solid #1f2530;text-align:center;">BID</th>
        <th style="background:#111318;color:#00c98a;padding:8px 14px;border:1px solid #1f2530;text-align:center;">ASK</th>
        <th style="background:#111318;padding:8px;border:1px solid #1f2530;"></th>
        <th style="background:#111318;color:#ff4d6d;padding:8px 14px;border:1px solid #1f2530;text-align:center;">STRIKE</th>
        <th style="background:#111318;color:#ff4d6d;padding:8px 14px;border:1px solid #1f2530;text-align:center;">BID</th>
        <th style="background:#111318;color:#ff4d6d;padding:8px 14px;border:1px solid #1f2530;text-align:center;">ASK</th>
      </tr>`;
    for (const d of deltas) {
      const c = data.calls.find(x => x.targetDelta === d) || {};
      const p = data.puts.find(x => x.targetDelta === d) || {};
      const fv = v => v != null ? '$'+Number(v).toFixed(2) : '—';
      html += `<tr>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;color:#00c98a;font-weight:bold;">${c.strike ? '$'+c.strike.toFixed(2) : '—'}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;">${fv(c.bid)}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;">${fv(c.ask)}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;background:#111318;">
          <span style="background:rgba(0,229,160,0.1);border:1px solid rgba(0,229,160,0.3);border-radius:4px;padding:2px 8px;color:#00e5a0;font-size:12px;">Δ${d.toFixed(2)}</span>
        </td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;color:#ff4d6d;font-weight:bold;">${p.strike ? '$'+p.strike.toFixed(2) : '—'}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;">${fv(p.bid)}</td>
        <td style="padding:9px 14px;border:1px solid #1f2530;text-align:center;">${fv(p.ask)}</td>
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
  if (!config.emailUser || !config.emailPass || !config.emailTo) {
    addLog(`Brak email config — user:${!!config.emailUser} pass:${!!config.emailPass} to:${!!config.emailTo}`, 'err');
    return false;
  }
  addLog(`Wysyłam email → ${config.emailTo}`, 'info');
  const transporter = createTransporter();
  const html = buildEmailHtml(results, scheduledTime);
  const date = moment().tz('Europe/Warsaw').format('DD.MM.YYYY');
  try {
    await transporter.sendMail({
      from: `"Option Scheduler" <${config.emailUser}>`,
      to: config.emailTo,
      subject: `📊 Option Chain ${config.tickers.join('/')} — ${scheduledTime} — ${date}`,
      html
    });
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

app.post('/api/config', (req, res) => {
  const prev = { ...config };
  config = { ...config, ...req.body };
  if (req.body.emailPass === '••••••••') config.emailPass = prev.emailPass;
  saveConfig(config);
  addLog('Konfiguracja zapisana ✓', 'ok');
  if (config.schedulerOn) startAllCrons(); else stopAllCrons();
  res.json({ ok: true });
});

app.post('/api/scheduler/toggle', (req, res) => {
  config.schedulerOn = req.body.on;
  saveConfig(config);
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
