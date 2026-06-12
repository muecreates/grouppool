require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2026-05-27.dahlia',
});

const app = express();

// Webhook muss raw body bekommen BEVOR express.json() parst
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

// ── Streamlabs ────────────────────────────────────────────────────────────────

async function sendStreamlabsDonation({ name, message, amount, currency = 'EUR' }) {
  const token = process.env.STREAMLABS_ACCESS_TOKEN;
  if (!token) {
    console.log('[Streamlabs] No token configured — skipping donation call');
    return { skipped: true, reason: 'no token' };
  }

  const params = new URLSearchParams({ access_token: token, name, message, amount, currency, identifier: 'grouppool@donation' });

  try {
    const res = await fetch('https://streamlabs.com/api/v2.0/donations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401 && data.message?.includes('whitelisted')) {
      console.log('[Streamlabs] App not whitelisted yet — donation logged locally only');
      console.log(`  → Would have sent: ${amount} ${currency} from "${name}": ${message}`);
      return { skipped: true, reason: 'not_whitelisted', wouldHaveSent: { name, message, amount, currency } };
    }

    console.log(`[Streamlabs] Donation response HTTP ${res.status}:`, data);
    return data;
  } catch (err) {
    console.error('[Streamlabs] Request failed:', err.message);
    return { skipped: true, reason: 'network_error', error: err.message };
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
    const data = await res.json().catch(() => ({}));
    console.log(`[Streamlabs] Alert response HTTP ${res.status}:`, data);
    return data;
  } catch (err) {
    return { skipped: true, reason: 'network_error' };
  }
}

// ── Twitch ────────────────────────────────────────────────────────────────────

const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID || '6jmi6nxcfqg5fgijmx6d66t3di6amo';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
let twitchTokenCache   = null;
let liveStreamerCache   = { streamers: [], expires: 0 };
let categoryCache      = { categories: [], expires: 0 };

async function getTwitchToken() {
  if (twitchTokenCache && twitchTokenCache.expires > Date.now()) return twitchTokenCache.token;
  if (!TWITCH_CLIENT_SECRET) return null;
  const res  = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
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
    // Top 100: two pages of 50
    const headers = { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` };
    const [r1, r2] = await Promise.all([
      fetch('https://api.twitch.tv/helix/streams?first=50', { headers }),
      fetch('https://api.twitch.tv/helix/streams?first=50&after=', { headers }),
    ]);
    const d1 = await r1.json();
    const d2 = await r2.json();
    const cursor = d1.pagination?.cursor;
    let streams = d1.data || [];
    if (cursor) {
      const r2b = await fetch(`https://api.twitch.tv/helix/streams?first=50&after=${cursor}`, { headers });
      streams = [...streams, ...((await r2b.json()).data || [])];
    }
    if (streams.length === 0) { liveStreamerCache = { streamers: [], expires: Date.now() + 5 * 60_000 }; return []; }

    // Batch user lookup (max 100 per request)
    const userIds = [...new Set(streams.map(s => s.user_id))];
    const batches = [];
    for (let i = 0; i < userIds.length; i += 100) batches.push(userIds.slice(i, i + 100));
    const userMap = {};
    await Promise.all(batches.map(async batch => {
      const r = await fetch(`https://api.twitch.tv/helix/users?${batch.map(id => `id=${id}`).join('&')}`, { headers });
      ((await r.json()).data || []).forEach(u => { userMap[u.id] = u.profile_image_url; });
    }));

    const streamers = streams.map(s => ({
      user_name:         s.user_name,
      user_login:        s.user_login,
      game_id:           s.game_id,
      game_name:         s.game_name,
      viewer_count:      s.viewer_count,
      title:             s.title,
      thumbnail_url:     (s.thumbnail_url || '').replace('{width}', '440').replace('{height}', '248'),
      profile_image_url: userMap[s.user_id] || '',
    }));
    liveStreamerCache = { streamers, expires: Date.now() + 5 * 60_000 };
    return streamers;
  } catch (e) { console.error('[Twitch] fetchLiveStreamers error:', e.message); return liveStreamerCache.streamers; }
}

async function fetchCategories() {
  if (categoryCache.expires > Date.now()) return categoryCache.categories;
  const token = await getTwitchToken();
  if (!token) return [];
  try {
    const headers = { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` };
    const r = await fetch('https://api.twitch.tv/helix/games/top?first=10', { headers });
    const categories = ((await r.json()).data || []).map(g => ({
      id:       g.id,
      name:     g.name,
      box_art:  (g.box_art_url || '').replace('{width}', '144').replace('{height}', '192'),
    }));
    categoryCache = { categories, expires: Date.now() + 15 * 60_000 };
    return categories;
  } catch { return categoryCache.categories; }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/live-streamers
app.get('/api/live-streamers', async (req, res) => {
  const streamers = await fetchLiveStreamers();
  if (streamers.length === 0 && !TWITCH_CLIENT_SECRET)
    return res.status(503).json({ error: 'TWITCH_CLIENT_SECRET nicht gesetzt.' });
  res.json({ streamers });
});

// GET /api/categories → Top 10 Twitch Games mit Box Art
app.get('/api/categories', async (req, res) => {
  const categories = await fetchCategories();
  res.json({ categories });
});

// GET /api/pools → alle offenen Pools mit Contributor-Count
app.get('/api/pools', async (req, res) => {
  const pools = await dbAll(`
    SELECT
      p.*,
      COUNT(CASE WHEN c.status = 'paid' THEN 1 END) AS contributor_count
    FROM pools p
    LEFT JOIN contributions c ON c.pool_id = p.id
    WHERE p.status = 'open'
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `, []);
  res.json({ pools });
});

// POST /pool/create
app.post('/pool/create', async (req, res) => {
  const { streamer, ziel_betrag, message, gruppe_name } = req.body;

  if (!streamer || !ziel_betrag || !message || !gruppe_name) {
    return res.status(400).json({ error: 'Fehlende Felder: streamer, ziel_betrag, message, gruppe_name' });
  }
  if (isNaN(ziel_betrag) || Number(ziel_betrag) <= 0) {
    return res.status(400).json({ error: 'ziel_betrag muss eine positive Zahl sein' });
  }

  // Streamer muss aktuell live sein (Cache 5 Minuten)
  const liveList = await fetchLiveStreamers();
  if (liveList.length > 0) {
    const q = streamer.toLowerCase().trim();
    const isLive = liveList.some(s =>
      s.user_login.toLowerCase() === q || s.user_name.toLowerCase() === q
    );
    if (!isLive) {
      return res.status(400).json({ error: 'Dieser Streamer ist gerade nicht live' });
    }
  }

  const id = uid();
  await dbRun(
    'INSERT INTO pools (id, streamer, gruppe_name, message, ziel_betrag) VALUES (?, ?, ?, ?, ?)',
    [id, streamer, gruppe_name, message, Number(ziel_betrag)]
  );

  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [id]);
  res.status(201).json({ success: true, pool });
});

// GET /pool/:id
app.get('/pool/:id', async (req, res) => {
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });

  const contributions = await dbAll(
    'SELECT teilnehmer_name, betrag, status, created_at FROM contributions WHERE pool_id = ?',
    [req.params.id]
  );

  res.json({
    pool,
    contributions,
    fortschritt_prozent: Math.min(100, Math.round((pool.ist_betrag / pool.ziel_betrag) * 100)),
    ziel_erreicht: pool.ist_betrag >= pool.ziel_betrag,
  });
});

// POST /pool/:id/join  → erstellt Stripe Checkout Session
app.post('/pool/:id/join', async (req, res) => {
  const { teilnehmer_name, betrag } = req.body;
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);

  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
  if (pool.status !== 'open') return res.status(400).json({ error: 'Pool ist nicht mehr offen' });
  if (!teilnehmer_name || !betrag || isNaN(betrag) || Number(betrag) <= 0) {
    return res.status(400).json({ error: 'Fehlende Felder: teilnehmer_name, betrag' });
  }

  const contrib_id = uid();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';

  // Wenn kein echter Stripe-Key → simuliere Checkout
  if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    await dbRun(
      'INSERT INTO contributions (id, pool_id, teilnehmer_name, betrag, stripe_session, status) VALUES (?, ?, ?, ?, ?, ?)',
      [contrib_id, pool.id, teilnehmer_name, Number(betrag), 'simulated', 'paid']
    );
    await dbRun('UPDATE pools SET ist_betrag = ist_betrag + ? WHERE id = ?', [Number(betrag), pool.id]);

    const updated = await dbGet('SELECT * FROM pools WHERE id = ?', [pool.id]);
    const triggered = updated.ist_betrag >= updated.ziel_betrag;

    return res.json({
      success: true,
      mode: 'simulated',
      contribution_id: contrib_id,
      pool_betrag_jetzt: updated.ist_betrag,
      ziel_erreicht: triggered,
      hinweis: 'Kein Stripe-Key gesetzt — Zahlung simuliert. Setze STRIPE_SECRET_KEY in .env für echte Payments.',
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `GroupPool: ${pool.gruppe_name} → ${pool.streamer}` },
          unit_amount: Math.round(Number(betrag) * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${baseUrl}/pool/${pool.id}/success?session_id={CHECKOUT_SESSION_ID}&contrib_id=${contrib_id}`,
      cancel_url: `${baseUrl}/pool/${pool.id}`,
      metadata: { pool_id: pool.id, contrib_id, teilnehmer_name, betrag },
    });

    await dbRun(
      'INSERT INTO contributions (id, pool_id, teilnehmer_name, betrag, stripe_session, status) VALUES (?, ?, ?, ?, ?, ?)',
      [contrib_id, pool.id, teilnehmer_name, Number(betrag), session.id, 'pending']
    );

    res.json({ success: true, checkout_url: session.url, contribution_id: contrib_id });
  } catch (err) {
    res.status(500).json({ error: 'Stripe Fehler: ' + err.message });
  }
});

// GET /pool/:id/success  → Stripe Redirect nach Zahlung
app.get('/pool/:id/success', async (req, res) => {
  const { contrib_id } = req.query;
  const contrib = await dbGet('SELECT * FROM contributions WHERE id = ?', [contrib_id]);
  if (!contrib) return res.status(404).send('Contribution nicht gefunden');

  if (contrib.status === 'pending') {
    await dbRun('UPDATE contributions SET status = ? WHERE id = ?', ['paid', contrib_id]);
    await dbRun('UPDATE pools SET ist_betrag = ist_betrag + ? WHERE id = ?', [contrib.betrag, contrib.pool_id]);
  }

  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [contrib.pool_id]);
  if (pool.ist_betrag >= pool.ziel_betrag && pool.status === 'open') {
    await triggerPool(pool.id);
  }

  res.json({ success: true, message: 'Zahlung erfolgreich!', pool_id: pool.id });
});

// ── Fee calculation ───────────────────────────────────────────────────────────
// Fees werden auf den Contributor aufgeschlagen (Pass-through Modell):
//   Platform fee : 5 %
//   Stripe fee   : 1.5 % + €0.25 (EU-Karten)
// Formel stellt sicher dass der Streamer genau `amount` erhält:
//   contributor_pays = (amount + 0.25) / (1 - 0.065)
function calcFees(amountEuros) {
  const totalCharge = Math.round(((amountEuros + 0.25) / (1 - 0.065)) * 100) / 100;
  const serviceFee  = Math.round(amountEuros * 0.05 * 100) / 100;
  const stripeFee   = Math.round((amountEuros * 0.015 + 0.25) * 100) / 100;
  return { totalCharge, serviceFee, stripeFee };
}

// GET /api/fees?amount=<euros> → gibt Fee-Breakdown zurück (für Live-Vorschau)
app.get('/api/fees', (req, res) => {
  const amount = parseFloat(req.query.amount);
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount als Query-Parameter erforderlich' });
  }
  res.json({ amount, ...calcFees(amount) });
});

// POST /pool/:id/checkout → erstellt Stripe Checkout Session mit Fee-Aufschlag
// amount wird in Cents übergeben (Stripe-Standard), z.B. 500 = €5.00
app.post('/pool/:id/checkout', async (req, res) => {
  const { contributor_name, amount } = req.body;
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);

  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
  if (pool.status !== 'open') return res.status(400).json({ error: 'Pool ist nicht mehr offen' });
  if (!contributor_name || !amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Fehlende Felder: contributor_name, amount (in Cents)' });
  }

  const amountEuros   = Math.round(Number(amount)) / 100;
  const { totalCharge, serviceFee, stripeFee } = calcFees(amountEuros);
  const totalCents    = Math.round(totalCharge * 100);
  const platformCents = Math.round(serviceFee * 100);
  const contrib_id    = uid();
  const baseUrl       = process.env.BASE_URL || 'http://localhost:3001';

  if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.startsWith('sk_test_...')) {
    return res.status(400).json({ error: 'Kein gültiger STRIPE_SECRET_KEY gesetzt.' });
  }

  try {
    const sessionParams = {
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `GroupPool: ${pool.gruppe_name} → @${pool.streamer}`,
            description: `Dein Beitrag: €${amountEuros.toFixed(2)} | Service: €${serviceFee.toFixed(2)} | Stripe: €${stripeFee.toFixed(2)}`,
          },
          unit_amount: totalCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${baseUrl}/pool/${pool.id}?payment=success`,
      cancel_url:  `${baseUrl}/pool/${pool.id}?payment=cancelled`,
      metadata: {
        pool_id:         pool.id,
        contrib_id,
        contributor_name,
        amount_euros:    amountEuros.toString(),   // nur der echte Beitrag fürs Ziel
        total_charge:    totalCharge.toString(),
        service_fee:     serviceFee.toString(),
      stripe_fee:      stripeFee.toString(),
      },
    };

    if (process.env.STRIPE_CONNECTED_ACCOUNT_ID) {
      sessionParams.application_fee_amount = platformCents;
      sessionParams.transfer_data = { destination: process.env.STRIPE_CONNECTED_ACCOUNT_ID };
    } else {
      console.log(`[Checkout] Platform fee €${serviceFee.toFixed(2)} | Stripe fee €${stripeFee.toFixed(2)}`);
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // DB speichert nur den echten Beitrag (ohne Fees) → trackt korrekt gegen Ziel
    await dbRun(
      'INSERT INTO contributions (id, pool_id, teilnehmer_name, betrag, stripe_session, status) VALUES (?, ?, ?, ?, ?, ?)',
      [contrib_id, pool.id, contributor_name, amountEuros, session.id, 'pending']
    );

    res.json({
      success:         true,
      checkout_url:    session.url,
      contribution_id: contrib_id,
      amount_euros:    amountEuros,
      service_fee:     serviceFee,
      stripe_fee:      stripeFee,
      total_charge:    totalCharge,
    });
  } catch (err) {
    res.status(500).json({ error: 'Stripe Fehler: ' + err.message });
  }
});

// POST /webhook/stripe → empfängt Stripe Webhook Events
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // Kein Secret gesetzt → direkt parsen (nur für lokale Tests ohne stripe listen)
      event = JSON.parse(req.body.toString());
      console.warn('[Webhook] STRIPE_WEBHOOK_SECRET nicht gesetzt — Signature nicht verifiziert!');
    }
  } catch (err) {
    console.error('[Webhook] Signature-Verification fehlgeschlagen:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { pool_id, contrib_id, contributor_name, amount_euros } = session.metadata;

    console.log(`[Webhook] checkout.session.completed — Pool ${pool_id}, ${contributor_name}, €${amount_euros}`);

    const contrib = await dbGet('SELECT * FROM contributions WHERE id = ?', [contrib_id]);
    if (contrib && contrib.status === 'pending') {
      await dbRun('UPDATE contributions SET status = ? WHERE id = ?', ['paid', contrib_id]);
      await dbRun('UPDATE pools SET ist_betrag = ist_betrag + ? WHERE id = ?', [Number(amount_euros), pool_id]);

      const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [pool_id]);
      console.log(`[Webhook] Pool ${pool_id} Fortschritt: €${pool.ist_betrag} / €${pool.ziel_betrag}`);

      if (pool.ist_betrag >= pool.ziel_betrag && pool.status === 'open') {
        console.log(`[Webhook] Ziel erreicht! Triggere Pool ${pool_id}...`);
        await triggerPool(pool_id);
      }
    } else {
      console.log(`[Webhook] Contribution ${contrib_id} bereits verarbeitet oder nicht gefunden.`);
    }
  }

  res.json({ received: true });
});

// POST /pool/:id/trigger  → manueller Trigger wenn Ziel erreicht
app.post('/pool/:id/trigger', async (req, res) => {
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
  if (pool.status === 'triggered') return res.status(400).json({ error: 'Pool wurde bereits ausgelöst' });

  const result = await triggerPool(pool.id);
  res.json(result);
});

async function triggerPool(poolId) {
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [poolId]);
  const contributors = await dbAll(
    'SELECT teilnehmer_name FROM contributions WHERE pool_id = ? AND status = ?',
    [poolId, 'paid']
  );

  const names = contributors.map((c) => c.teilnehmer_name).join(', ');
  const donationMessage = `${pool.gruppe_name}: ${names} — ${pool.message}`;

  await dbRun('UPDATE pools SET status = ? WHERE id = ?', ['triggered', poolId]);

  const [donationResult, alertResult] = await Promise.all([
    sendStreamlabsDonation({
      name: pool.gruppe_name,
      message: donationMessage,
      amount: pool.ist_betrag,
    }),
    sendStreamlabsAlert(donationMessage),
  ]);

  console.log(`[Pool ${poolId}] Triggered. Betrag: ${pool.ist_betrag}€, Teilnehmer: ${names}`);

  return {
    success: true,
    pool_id: poolId,
    betrag_gesendet: pool.ist_betrag,
    teilnehmer: names,
    streamlabs_donation: donationResult,
    streamlabs_alert: alertResult,
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`GroupPool Backend läuft auf http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log('  POST /pool/create');
  console.log('  GET  /pool/:id');
  console.log('  POST /pool/:id/join');
  console.log('  POST /pool/:id/checkout');
  console.log('  POST /pool/:id/trigger');
  console.log('  POST /webhook/stripe');
});
