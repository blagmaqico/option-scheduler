const express = require('express');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const moment = require('moment-timezone');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG FILE (persists settings) ───────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch(e) {}
  }
  return {
    tickers: [],
    expiryDate: '',
    times: ['15:30', '15:45', '16:00'],
    emailTo: '',
    emailUser: '',
    emailPass: '',
    emailService: 'gmail',
    schedulerOn: false
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ─── LOG ────────────────────────────────────────────────────────────────────
const MAX_LOGS = 200;
let logs = [];

function addLog(msg, type = 'info') {
  const entry = {
    time: moment().tz('Europe/Warsaw').format('HH:mm:ss'),
    msg,
    type
  };
  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(0, MAX_LOGS);
  console.log(`[${entry.time}] [${type.toUpperCase()}] ${msg}`);
}

// ─── CRON MANAGEMENT ────────────────────────────────────────────────────────
let activeCrons = [];

function buildCronExpr(timeStr) {
  // timeStr = "HH:MM"
  const [h, m] = timeStr.split(':');
  // Run Mon–Fri at that time, Warsaw timezone
  return `${parseInt(m)} ${parseInt(h)} * * 1-5`;
}

function startAllCrons() {
  stopAllCrons();
  if (!config.schedulerOn) return;

  for (const t of config.times) {
    const expr = buildCronExpr(t);
    addLog(`Rejestruję cron: "${t}" → ${expr}`, 'info');

    const job = cron.schedule(expr, async () => {
      const now = moment().tz('Europe/Warsaw').format('YYYY-MM-DD HH:mm');
      addLog(`⏰ Wyzwolono o ${t} (${now}) — start pobierania`, 'info');
      await runFetchAndSend(t);
    }, {
      timezone: 'Europe/Warsaw'
    });

    activeCrons.push({ time: t, job });
  }

  addLog(`Scheduler aktywny — ${activeCrons.length} zadań zaplanowanych`, 'ok');
}

function stopAllCrons() {
  for (const { job } of activeCrons) {
    try { job.destroy(); } catch(e) {}
  }
  activeCrons = [];
}

// ─── YAHOO FINANCE ──────────────────────────────────────────────────────────
async function fetchOptionChain(ticker, expiryDate) {
  let url = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}`;
  if (expiryDate) {
    const ts = Math.floor(new Date(expiryDate).getTime() / 1000);
    url += `?date=${ts}`;
  }

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; OptionScheduler/1.0)',
      'Accept': 'application/json'
    }
  });

  if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
  const json = await resp.json();

  const chain = json?.optionChain?.result?.[0];
  if (!chain) throw new Error('Brak danych option chain');

  const opts = chain.options?.[0];
  if (!opts) throw new Error('Brak opcji dla tej daty');

  const underlyingPrice = chain.quote?.regularMarketPrice || null;
  const expirationDate = opts.expirationDate;

  const calls = selectByDelta(opts.calls || [], [0.50, 0.40, 0.30, 0.20], underlyingPrice, 'call');
  const puts  = selectByDelta(opts.puts  || [], [0.50, 0.40, 0.30, 0.20], underlyingPrice, 'put');

  return { calls, puts, underlyingPrice, expirationDate };
}

function selectByDelta(options, deltas, underlyingPrice, type) {
  if (!options.length) return [];

  // Sort strikes
  const sorted = [...options].sort((a, b) => a.strike - b.strike);

  const result = [];
  for (const targetDelta of deltas) {
    let best = null;
    let bestDiff = Infinity;

    for (const opt of sorted) {
      // Use greeks if available
      let d = opt.greeks?.delta;

      // Fallback: BS delta approximation
      if (d == null && underlyingPrice) {
        d = approximateDelta(opt.strike, underlyingPrice, type);
      }

      if (d == null) {
        // Last fallback: linear position
        const idx = sorted.indexOf(opt);
        d = type === 'call'
          ? 1 - idx / sorted.length
          : idx / sorted.length;
      }

      const diff = Math.abs(Math.abs(d) - targetDelta);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = { ...opt, approxDelta: d, targetDelta };
      }
    }

    if (best && !result.find(r => r.strike === best.strike)) {
      result.push(best);
    }
  }

  return result.sort((a, b) => b.targetDelta - a.targetDelta);
}

function approximateDelta(strike, underlying, type) {
  // Very rough moneyness-based approximation
  const m = underlying / strike;
  if (type === 'call') {
    if (m > 1.05) return 0.75;
    if (m > 1.02) return 0.60;
    if (m > 0.99) return 0.50;
    if (m > 0.96) return 0.38;
    if (m > 0.93) return 0.27;
    return 0.15;
  } else {
    if (m < 0.95) return 0.75;
    if (m < 0.98) return 0.60;
    if (m < 1.01) return 0.50;
    if (m < 1.04) return 0.38;
    if (m < 1.07) return 0.27;
    return 0.15;
  }
}

// ─── EMAIL ──────────────────────────────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransporter({
    service: config.emailService === 'gmail' ? 'gmail' : undefined,
    host: config.emailService === 'outlook' ? 'smtp-mail.outlook.com' : undefined,
    port: config.emailService === 'outlook' ? 587 : undefined,
    secure: false,
    auth: {
      user: config.emailUser,
      pass: config.emailPass
    }
  });
}

function buildEmailHtml(results, scheduledTime) {
  const now = moment().tz('Europe/Warsaw').format('DD.MM.YYYY HH:mm:ss');
  const deltas = [0.50, 0.40, 0.30, 0.20];

  let html = `
  <div style="font-family: 'Courier New', monospace; background:#0a0c0f; color:#e8edf5; padding:32px; border-radius:12px; max-width:900px;">
    <div style="border-bottom:2px solid #00e5a0; padding-bottom:16px; margin-bottom:24px;">
      <h2 style="color:#00e5a0; margin:0; font-size:22px; letter-spacing:2px;">📊 OPTION CHAIN REPORT</h2>
      <p style="color:#5a6478; margin:8px 0 0; font-size:13px;">
        Data: ${now} (CET/CEST) &nbsp;|&nbsp; Godzina zapisu: <strong style="color:#fff">${scheduledTime}</strong>
        &nbsp;|&nbsp; Expiration: <strong style="color:#fff">${config.expiryDate}</strong>
      </p>
    </div>
  `;

  for (const { ticker, data, error } of results) {
    html += `<div style="margin-bottom:32px;">`;
    html += `<h3 style="color:#fff; font-size:16px; letter-spacing:2px; margin:0 0 4px;">
      ${ticker}
      ${data?.underlyingPrice ? `<span style="color:#5a6478; font-size:13px; font-weight:normal; margin-left:12px;">Cena: <strong style="color:#00e5a0">$${data.underlyingPrice.toFixed(2)}</strong></span>` : ''}
    </h3>`;

    if (error || !data) {
      html += `<p style="color:#ff4d6d;">❌ Błąd: ${error || 'Brak danych'}</p></div>`;
      continue;
    }

    html += `
    <table style="width:100%; border-collapse:collapse; font-size:13px; margin-top:12px;">
      <thead>
        <tr>
          <th colspan="3" style="background:#0d1a14; color:#00c98a; padding:10px; text-align:center; border:1px solid #1f2530; letter-spacing:2px;">CALL</th>
          <th style="background:#111318; color:#e8edf5; padding:10px; text-align:center; border:1px solid #1f2530; letter-spacing:2px;">DELTA</th>
          <th colspan="3" style="background:#1a0d12; color:#ff4d6d; padding:10px; text-align:center; border:1px solid #1f2530; letter-spacing:2px;">PUT</th>
        </tr>
        <tr>
          <th style="background:#111318; color:#00c98a; padding:8px 14px; border:1px solid #1f2530; text-align:center;">STRIKE</th>
          <th style="background:#111318; color:#00c98a; padding:8px 14px; border:1px solid #1f2530; text-align:center;">BID</th>
          <th style="background:#111318; color:#00c98a; padding:8px 14px; border:1px solid #1f2530; text-align:center;">ASK</th>
          <th style="background:#111318; color:#5a6478; padding:8px 14px; border:1px solid #1f2530; text-align:center;"></th>
          <th style="background:#111318; color:#ff4d6d; padding:8px 14px; border:1px solid #1f2530; text-align:center;">STRIKE</th>
          <th style="background:#111318; color:#ff4d6d; padding:8px 14px; border:1px solid #1f2530; text-align:center;">BID</th>
          <th style="background:#111318; color:#ff4d6d; padding:8px 14px; border:1px solid #1f2530; text-align:center;">ASK</th>
        </tr>
      </thead>
      <tbody>
    `;

    for (const d of deltas) {
      const call = data.calls.find(c => c.targetDelta === d) || {};
      const put  = data.puts.find(p => p.targetDelta === d) || {};
      const fv   = v => (v != null ? '$' + Number(v).toFixed(2) : '—');

      html += `
        <tr>
          <td style="padding:9px 14px; border:1px solid #1f2530; text-align:center; color:#00c98a; font-weight:bold;">${call.strike ? '$'+call.strike.toFixed(2) : '—'}</td>
          <td style="padding:9px 14px; border:1px solid #1f2530; text-align:center; color:#e8edf5;">${fv(call.bid)}</td>
          <td style="padding:9px 14px; border:1px solid #1f2530; text-align:center; color:#e8edf5;">${fv(call.ask)}</td>
          <td style="padding:9px 14px; border:1px solid #1f2530; text-align:center; background:#111318;">
            <span style="background:rgba(0,229,160,0.1); border:1px solid rgba(0,229,160,0.3); border-radius:4px; padding:2px 8px; color:#00e5a0; font-size:12px;">Δ${d.toFixed(2)}</span>
          </td>
          <td style="padding:9px 14px; border:1px solid #1f2530; text-align:center; color:#ff4d6d; font-weight:bold;">${put.strike ? '$'+put.strike.toFixed(2) : '—'}</td>
          <td style="padding:9px 14px; border:1px solid #1f2530; text-align:center; color:#e8edf5;">${fv(put.bid)}</td>
          <td style="padding:9px 14px; border:1px solid #1f2530; text-align:center; color:#e8edf5;">${fv(put.ask)}</td>
        </tr>
      `;
    }

    html += `</tbody></table></div>`;
  }

  html += `
    <div style="border-top:1px solid #1f2530; margin-top:24px; padding-top:16px; color:#5a6478; font-size:11px; letter-spacing:1px;">
      Option Chain Scheduler • ${moment().tz('Europe/Warsaw').format('YYYY')} • Czas serwera: Europe/Warsaw
    </div>
  </div>`;

  return html;
}

async function sendEmail(scheduledTime, results) {
  if (!config.emailUser || !config.emailPass || !config.emailTo) {
    addLog('Brak konfiguracji email — pomijam wysyłkę', 'err');
    return false;
  }

  const transporter = createTransporter();
  const html = buildEmailHtml(results, scheduledTime);
  const date = moment().tz('Europe/Warsaw').format('DD.MM.YYYY');
  const tickers = config.tickers.join('/');

  try {
    await transporter.sendMail({
      from: `"Option Scheduler" <${config.emailUser}>`,
      to: config.emailTo,
      subject: `📊 Option Chain ${tickers} — ${scheduledTime} — ${date}`,
      html
    });
    addLog(`✅ Email wysłany → ${config.emailTo}`, 'ok');
    return true;
  } catch(e) {
    addLog(`❌ Błąd email: ${e.message}`, 'err');
    return false;
  }
}

// ─── FETCH & SEND ────────────────────────────────────────────────────────────
async function runFetchAndSend(scheduledTime) {
  const results = [];

  for (const ticker of config.tickers) {
    addLog(`Pobieram: ${ticker} exp ${config.expiryDate}`, 'info');
    try {
      const data = await fetchOptionChain(ticker, config.expiryDate);
      results.push({ ticker, data });
      addLog(`${ticker} ✓ — cena: $${data.underlyingPrice?.toFixed(2) || '?'}`, 'ok');
    } catch(e) {
      addLog(`${ticker} ✗ — ${e.message}`, 'err');
      results.push({ ticker, data: null, error: e.message });
    }
  }

  await sendEmail(scheduledTime, results);
  return results;
}

// ─── API ROUTES ──────────────────────────────────────────────────────────────

// Get current config + logs
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

// Save config
app.post('/api/config', (req, res) => {
  const prev = { ...config };
  config = { ...config, ...req.body };
  // Never overwrite pass with masked value
  if (req.body.emailPass === '••••••••') config.emailPass = prev.emailPass;
  saveConfig(config);
  addLog('Konfiguracja zapisana ✓', 'ok');

  // Restart crons if scheduler is on
  if (config.schedulerOn) startAllCrons();
  else stopAllCrons();

  res.json({ ok: true });
});

// Toggle scheduler
app.post('/api/scheduler/toggle', (req, res) => {
  config.schedulerOn = req.body.on;
  saveConfig(config);
  if (config.schedulerOn) {
    startAllCrons();
    addLog('Scheduler WŁĄCZONY ✓', 'ok');
  } else {
    stopAllCrons();
    addLog('Scheduler WYŁĄCZONY', 'warn');
  }
  res.json({ ok: true, on: config.schedulerOn });
});

// Manual fetch + send
app.post('/api/fetch-now', async (req, res) => {
  addLog('Manualne pobieranie danych...', 'info');
  const results = await runFetchAndSend('MANUALNE');
  res.json({ ok: true, results: results.map(r => ({ ticker: r.ticker, ok: !!r.data, error: r.error })) });
});

// Preview only (no email)
app.post('/api/preview', async (req, res) => {
  const { ticker, expiryDate } = req.body;
  try {
    const data = await fetchOptionChain(ticker, expiryDate);
    res.json({ ok: true, data });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Test email
app.post('/api/test-email', async (req, res) => {
  addLog('Wysyłam testowy email...', 'info');
  const fakeResults = [{ ticker: 'TEST', data: null, error: 'To jest testowy email — dane nie są pobierane' }];
  const ok = await sendEmail('TEST', fakeResults);
  res.json({ ok });
});

// Health check (keeps Render free tier alive)
app.get('/health', (req, res) => res.send('OK'));

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog(`Serwer uruchomiony na porcie ${PORT}`, 'ok');
  addLog(`Strefa czasowa: Europe/Warsaw`, 'info');
  // Resume scheduler if it was on
  if (config.schedulerOn) {
    startAllCrons();
  }
});
