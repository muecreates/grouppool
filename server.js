require('dotenv').config();
const { runBotDonation } = require('./bot');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2026-05-27.dahlia',
});

const app = express();

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────

const fs = require('fs');
const DB_PATH = './grouppool.db';
console.log(`[DB] Opening database at ${DB_PATH}`);

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[DB] Failed to open database:', err.message);
  } else {
    console.log('[DB] Connected successfully');
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS pools (
      id          TEXT PRIMARY KEY,
      streamer    TEXT NOT NULL,
      gruppe_name TEXT NOT NULL,
      message     TEXT NOT NULL,
      ziel_betrag REAL NOT NULL,
      ist_betrag  REAL NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'open',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `, (err) => { if (err) console.error('[DB] pools table error:', err.message); });
  db.run(`
    CREATE TABLE IF NOT EXISTS contributions (
      id              TEXT PRIMARY KEY,
      pool_id         TEXT NOT NULL,
      teilnehmer_name TEXT NOT NULL,
      betrag          REAL NOT NULL,
      stripe_session  TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (pool_id) REFERENCES pools(id)
    )
  `, (err) => { if (err) console.error('[DB] contributions table error:', err.message); });
});

function dbGet(sql, params) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );
}
function dbAll(sql, params) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
}
function dbRun(sql, params) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })
  );
}
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ── Twitch panel scraper ──────────────────────────────────────────────────────

const DONATION_DOMAINS = ['streamlabs.com', 'tipeeestream.com', 'streamelements.com'];

async function scrapeStreamlabsLink(twitchUsername) {
  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'de-DE',
    });
    const page = await ctx.newPage();
    await page.goto(`https://www.twitch.tv/${twitchUsername}/about`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    // dismiss cookie/consent overlay if present
    const consentBtn = page.locator('button:has-text("Akzeptieren"), button:has-text("Accept"), button[data-a-target="consent-banner-accept"]');
    await consentBtn.click({ timeout: 3_000 }).catch(() => {});

    // scroll down in steps to trigger lazy-loading of panels
    for (let i = 0; i < 4; i++) {
      await page.evaluate((step) => window.scrollBy(0, step * 600), i + 1);
      await page.waitForTimeout(800);
    }

    // wait for at least one panel link to appear (best-effort)
    await page.waitForSelector('.channel-panels-container a, [data-target="channel-panels"] a', { timeout: 5_000 }).catch(() => {});

    const hrefs = await page.$$eval('a[href], iframe[src]', (els) =>
      els.map((el) => el.href || el.src).filter(Boolean)
    );
    console.log(`[SCRAPE] ${hrefs.length} Links gefunden auf twitch.tv/${twitchUsername}/about`);
    // Match: bekannte Donation-Domains ODER /tip-Pfad auf fremden Domains (nicht twitch.tv selbst)
    const found = hrefs.find((href) =>
      DONATION_DOMAINS.some((d) => href.includes(d)) ||
      (href.includes('/tip') && !href.includes('twitch.tv') && !href.includes('twitter'))
    );
    return found ?? null;
  } catch (err) {
    console.error(`[SCRAPE] Fehler bei ${twitchUsername}:`, err.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// ── Streamlabs ────────────────────────────────────────────────────────────────

async function sendStreamlabsDonation({ name, message, amount, currency = 'EUR' }) {
  const token = process.env.STREAMLABS_ACCESS_TOKEN;
  if (!token) return { skipped: true, reason: 'no token' };
  const params = new URLSearchParams({ access_token: token, name, message, amount, currency, identifier: 'grouppool@donation' });
  try {
    const res = await fetch('https://streamlabs.com/api/v2.0/donations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    return data;
  } catch (err) {
    return { skipped: true, reason: 'network_error' };
  }
}

async function sendStreamlabsAlert(message) {
  const token = process.env.STREAMLABS_ACCESS_TOKEN;
  if (!token) return { skipped: true, reason: 'no token' };
  const params = new URLSearchParams({ access_token: token, type: 'donation', message });
  try {
    const res = await fetch('https://streamlabs.com/api/v2.0/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    return await res.json().catch(() => ({}));
  } catch (err) {
    return { skipped: true, reason: 'network_error' };
  }
}

// ── Twitch ────────────────────────────────────────────────────────────────────

const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID || '6jmi6nxcfqg5fgijmx6d66t3di6amo';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
let twitchTokenCache   = null;
let liveStreamerCache   = { streamers: [], expires: 0 };

async function getTwitchToken() {
  if (twitchTokenCache && twitchTokenCache.expires > Date.now()) return twitchTokenCache.token;
  if (!TWITCH_CLIENT_SECRET) return null;
  const res  = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) return null;
  twitchTokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

async function fetchLiveStreamers() {
  if (liveStreamerCache.expires > Date.now()) return liveStreamerCache.streamers;
  const token = await getTwitchToken();
  if (!token) return [];
  try {
    const headers = { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` };
    const r1 = await fetch('https://api.twitch.tv/helix/streams?first=50', { headers });
    const d1 = await r1.json();
    const streamers = (d1.data || []).map(s => ({
      user_name: s.user_name, user_login: s.user_login, viewer_count: s.viewer_count, title: s.title
    }));
    liveStreamerCache = { streamers, expires: Date.now() + 5 * 60_000 };
    return streamers;
  } catch { return liveStreamerCache.streamers; }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/live-streamers', async (req, res) => {
  const streamers = await fetchLiveStreamers();
  res.json({ streamers });
});

app.get('/api/pools', async (req, res) => {
  const pools = await dbAll("SELECT p.*, COUNT(CASE WHEN c.status = 'paid' THEN 1 END) AS contributor_count FROM pools p LEFT JOIN contributions c ON c.pool_id = p.id WHERE p.status = 'open' GROUP BY p.id ORDER BY p.created_at DESC", []);
  res.json({ pools });
});

app.post('/pool/create', async (req, res) => {
  const { streamer, ziel_betrag, message, gruppe_name } = req.body;
  if (!streamer || !ziel_betrag || !message || !gruppe_name) return res.status(400).json({ error: 'Fehlende Felder' });
  const id = uid();
  await dbRun('INSERT INTO pools (id, streamer, gruppe_name, message, ziel_betrag) VALUES (?, ?, ?, ?, ?)', [id, streamer, gruppe_name, message, Number(ziel_betrag)]);
  res.status(201).json({ success: true, pool: { id, streamer, gruppe_name, message, ziel_betrag } });
});

app.get('/pool/:id', async (req, res) => {
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
  const contributions = await dbAll('SELECT * FROM contributions WHERE pool_id = ?', [req.params.id]);
  res.json({ pool, contributions });
});

app.post('/pool/:id/join', async (req, res) => {
  const { teilnehmer_name, betrag } = req.body;
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
  
  const contrib_id = uid();
  await dbRun("INSERT INTO contributions (id, pool_id, teilnehmer_name, betrag, status) VALUES (?, ?, ?, ?, 'paid')", [contrib_id, pool.id, teilnehmer_name, Number(betrag)]);
  await dbRun('UPDATE pools SET ist_betrag = ist_betrag + ? WHERE id = ?', [Number(betrag), pool.id]);

  const updated = await dbGet('SELECT * FROM pools WHERE id = ?', [pool.id]);
  if (updated.ist_betrag >= updated.ziel_betrag && updated.status === 'open') {
    await triggerPool(pool.id);
  }
  res.json({ success: true, msg: 'Simuliert erfolgreich' });
});

async function checkUrlValid(url, bodySignal) {
  try {
    const res = await fetch(url, {
      method: 'GET', redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.includes(bodySignal);
  } catch { return false; }
}

async function resolveDonationUrl(streamer) {
  // 1. Twitch-Panels scrapen — gibt echten Link zurück falls im Panel verlinkt
  const scraped = await scrapeStreamlabsLink(streamer);
  if (scraped) {
    console.log(`[RESOLVE] Gescrapeter Link: ${scraped}`);
    return scraped;
  }

  // 2. Fallback 1: Streamlabs — nur wenn Seite echtes Tip-Formular enthält
  const slUrl = `https://streamlabs.com/${streamer}/tip`;
  if (await checkUrlValid(slUrl, 'tip-user-input')) {
    console.log(`[RESOLVE] Streamlabs-Fallback: ${slUrl}`);
    return slUrl;
  }

  // 3. Fallback 2: StreamElements — nur wenn Seite tipperUsername-Feld enthält
  const seUrl = `https://streamelements.com/${streamer}/tip`;
  if (await checkUrlValid(seUrl, 'tipperUsername')) {
    console.log(`[RESOLVE] StreamElements-Fallback: ${seUrl}`);
    return seUrl;
  }

  // 4. Fallback 3: TipeeeStream — sicherer letzter Fallback
  const tipeeeUrl = `https://www.tipeeestream.com/${streamer}/donation`;
  console.log(`[RESOLVE] TipeeeStream-Fallback: ${tipeeeUrl}`);
  return tipeeeUrl;
}

// ── Pool-Queue (verhindert parallele Bot-Instanzen) ───────────────────────────

let botActive = false;
const botQueue = [];

async function processNextInQueue() {
  if (botQueue.length === 0) { botActive = false; return; }
  const nextId = botQueue.shift();
  console.log(`[QUEUE] Starte nächsten Pool aus Queue: ${nextId} (${botQueue.length} verbleibend)`);
  await _runTrigger(nextId);
}

async function triggerPool(poolId) {
  if (botActive) {
    botQueue.push(poolId);
    console.log(`[QUEUE] Bot beschäftigt – Pool ${poolId} eingereiht (Position ${botQueue.length})`);
    return { success: true, queued: true };
  }
  botActive = true;
  await _runTrigger(poolId);
  return { success: true };
}

async function _runTrigger(poolId) {
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [poolId]);
  const contributors = await dbAll("SELECT teilnehmer_name FROM contributions WHERE pool_id = ? AND status = 'paid'", [poolId]);
  const names = contributors.map((c) => c.teilnehmer_name).join(', ');
  const donationMessage = `${pool.gruppe_name}: ${names} — ${pool.message}`;

  await dbRun('UPDATE pools SET status = ? WHERE id = ?', ['triggered', poolId]);

  const donationUrl = await resolveDonationUrl(pool.streamer);
  console.log(`[TRIGGER] Finaler Donation-Link: ${donationUrl}`);

  runBotDonation(pool.streamer, pool.ist_betrag, donationMessage, pool.gruppe_name, donationUrl)
    .catch(async (err) => {
      if (err.message === 'CAPTCHA_REQUIRED') {
        console.log(`[CAPTCHA-REQUIRED] Pool ${poolId} — manuelle Zahlung nötig`);
        await dbRun('UPDATE pools SET status = ? WHERE id = ?', ['captcha_required', poolId]);
      } else {
        console.error('[BOT-TRIGGER] Fehler:', err.message);
      }
    })
    .finally(() => processNextInQueue());

  await Promise.all([
    sendStreamlabsDonation({ name: pool.gruppe_name, message: donationMessage, amount: pool.ist_betrag }),
    sendStreamlabsAlert(donationMessage),
  ]);
}

// ── Stripe Webhook ────────────────────────────────────────────────────────────

app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[WEBHOOK] Signature-Fehler:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const poolId  = session.metadata?.pool_id;
    const teilnehmer = session.metadata?.teilnehmer_name || 'Anonym';
    const betrag  = (session.amount_total || 0) / 100;
    console.log(`[WEBHOOK] checkout.session.completed | Pool: ${poolId} | €${betrag}`);

    if (poolId) {
      try {
        const existing = await dbGet('SELECT * FROM contributions WHERE stripe_session = ?', [session.id]);
        if (existing) {
          await dbRun("UPDATE contributions SET status = 'paid' WHERE stripe_session = ?", [session.id]);
        } else {
          const cid = uid();
          await dbRun("INSERT INTO contributions (id, pool_id, teilnehmer_name, betrag, stripe_session, status) VALUES (?, ?, ?, ?, ?, 'paid')",
            [cid, poolId, teilnehmer, betrag, session.id]);
        }
        await dbRun('UPDATE pools SET ist_betrag = ist_betrag + ? WHERE id = ?', [betrag, poolId]);
        const updated = await dbGet('SELECT * FROM pools WHERE id = ?', [poolId]);
        if (updated?.status === 'open' && updated.ist_betrag >= updated.ziel_betrag) {
          await triggerPool(poolId);
        }
      } catch (err) {
        console.error('[WEBHOOK] Fehler bei Pool-Update:', err.message);
      }
    }
  }
  res.json({ received: true });
});

// ── Stripe Checkout Session erstellen ─────────────────────────────────────────

app.post('/pool/:id/checkout', async (req, res) => {
  const { teilnehmer_name, betrag } = req.body;
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
  if (!teilnehmer_name || !betrag || Number(betrag) <= 0)
    return res.status(400).json({ error: 'Name und Betrag erforderlich' });

  const cid = uid();
  await dbRun("INSERT INTO contributions (id, pool_id, teilnehmer_name, betrag, status) VALUES (?, ?, ?, ?, 'pending')",
    [cid, pool.id, teilnehmer_name, Number(betrag)]);

  const base = process.env.BASE_URL || 'http://localhost:3001';
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `GroupPool: ${pool.gruppe_name} → @${pool.streamer}` },
          unit_amount: Math.round(Number(betrag) * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${base}/?success=1&pool=${pool.id}`,
      cancel_url:  `${base}/?cancel=1&pool=${pool.id}`,
      metadata: { pool_id: pool.id, teilnehmer_name, contrib_id: cid },
    });
    await dbRun('UPDATE contributions SET stripe_session = ? WHERE id = ?', [session.id, cid]);
    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    await dbRun('DELETE FROM contributions WHERE id = ?', [cid]);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin Routes ──────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers['x-admin-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/admin/pool/:id/manual-trigger', requireAdmin, async (req, res) => {
  try {
    const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
    await dbRun('UPDATE pools SET status = ? WHERE id = ?', ['triggered', req.params.id]);
    console.log(`[ADMIN] Pool ${req.params.id} manuell auf 'triggered' gesetzt`);
    res.json({ success: true, pool_id: req.params.id, status: 'triggered' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`GroupPool Backend läuft auf http://localhost:${PORT}`);
});
