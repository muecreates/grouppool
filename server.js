require('dotenv').config();
const { runBotDonation } = require('./bot');
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2026-05-27.dahlia',
});
const { initDb, dbGet, dbAll, dbRun, uid } = require('./db');

const app = express();
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML' }),
    });
  } catch {}
}

// ── Twitch ────────────────────────────────────────────────────────────────────

const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
let twitchTokenCache = null;
let liveStreamerCache = { streamers: [], expires: 0 };

async function getTwitchToken() {
  if (twitchTokenCache?.expires > Date.now()) return twitchTokenCache.token;
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
  const EXCLUDED_LANGS = new Set(['zh', 'ja', 'ko', 'ar']);
  try {
    const headers = { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` };
    const r1 = await fetch('https://api.twitch.tv/helix/streams?first=100', { headers });
    const d1 = await r1.json();
    const streamers = (d1.data || [])
      .filter(s => !EXCLUDED_LANGS.has(s.language))
      .map(s => ({
        user_name: s.user_name, user_login: s.user_login, viewer_count: s.viewer_count, title: s.title
      }));
    liveStreamerCache = { streamers, expires: Date.now() + 5 * 60_000 };
    return streamers;
  } catch { return liveStreamerCache.streamers; }
}

// ── Streamlabs API ────────────────────────────────────────────────────────────

async function sendStreamlabsDonation({ name, message, amount, currency = 'EUR' }) {
  const token = process.env.STREAMLABS_ACCESS_TOKEN;
  if (!token) return { skipped: true };
  try {
    const res = await fetch('https://streamlabs.com/api/v2.0/donations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: token, name, message, amount, currency, identifier: 'grouppool@donation' }).toString(),
    });
    return await res.json().catch(() => ({}));
  } catch { return { skipped: true }; }
}

async function sendStreamlabsAlert(message) {
  const token = process.env.STREAMLABS_ACCESS_TOKEN;
  if (!token) return { skipped: true };
  try {
    const res = await fetch('https://streamlabs.com/api/v2.0/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: token, type: 'donation', message }).toString(),
    });
    return await res.json().catch(() => ({}));
  } catch { return { skipped: true }; }
}

// ── Streamer-Link Cache (AUFGABE 4) ───────────────────────────────────────────

const DONATION_DOMAINS = ['streamlabs.com', 'tipeeestream.com', 'streamelements.com'];
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function getCachedLink(streamer) {
  const rows = await dbAll('SELECT * FROM streamer_links WHERE streamer = ? ORDER BY last_checked DESC', [streamer]);
  for (const row of rows) {
    if (Date.now() - new Date(row.last_checked).getTime() < CACHE_TTL_MS) {
      console.log(`[CACHE] Hit for ${streamer}: ${row.url}`);
      return row.url;
    }
  }
  return null;
}

async function setCachedLink(streamer, platform, url) {
  await dbRun(`INSERT OR REPLACE INTO streamer_links (streamer, platform, url, last_checked) VALUES (?, ?, ?, datetime('now'))`,
    [streamer, platform, url]);
}

async function scrapeStreamlabsLink(twitchUsername) {
  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      locale: 'de-DE',
    });

    const isDonationLink = (h) =>
      DONATION_DOMAINS.some(d => h.includes(d)) ||
      (h.includes('/tip') && !h.includes('twitch.tv') && !h.includes('twitter'));

    // Scrape both /about and main channel page for panel links
    for (const url of [
      `https://www.twitch.tv/${twitchUsername}/about`,
      `https://www.twitch.tv/${twitchUsername}`,
    ]) {
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        const consent = page.locator('button:has-text("Akzeptieren"), button:has-text("Accept"), button[data-a-target="consent-banner-accept"]');
        await consent.click({ timeout: 3_000 }).catch(() => {});
        // Scroll to load panels
        for (let i = 0; i < 4; i++) { await page.evaluate(s => window.scrollBy(0, s * 600), i + 1); await page.waitForTimeout(800); }
        // Extra wait for dynamic panel load
        await page.waitForTimeout(5_000);
        await page.waitForSelector('.channel-panels-container a, [data-target="channel-panels"] a', { timeout: 3_000 }).catch(() => {});
        const hrefs = await page.$$eval('a[href], iframe[src]', els => els.map(el => el.href || el.src).filter(Boolean));
        console.log(`[SCRAPE] ${hrefs.length} Links auf ${url}`);
        const found = hrefs.find(isDonationLink);
        if (found) {
          const platform = found.includes('streamlabs') ? 'streamlabs' : found.includes('streamelements') ? 'streamelements' : 'tipeeestream';
          await setCachedLink(twitchUsername, platform, found);
          return found;
        }
      } catch (err) {
        console.error(`[SCRAPE] ${url}: ${err.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
    return null;
  } catch (err) {
    console.error(`[SCRAPE] Fehler bei ${twitchUsername}:`, err.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

async function checkUrlValid(url, bodySignal) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) });
    if (!res.ok) return false;
    return (await res.text()).includes(bodySignal);
  } catch { return false; }
}

async function resolveDonationUrl(streamer) {
  // 1. Cache prüfen
  const cached = await getCachedLink(streamer);
  if (cached) return cached;

  // 2. Twitch-Panels scrapen
  const scraped = await scrapeStreamlabsLink(streamer);
  if (scraped) { console.log(`[RESOLVE] Gescrapeter Link: ${scraped}`); return scraped; }

  // 3. Streamlabs Content-Check
  const slUrl = `https://streamlabs.com/${streamer}/tip`;
  if (await checkUrlValid(slUrl, 'tip-user-input')) {
    await setCachedLink(streamer, 'streamlabs', slUrl);
    console.log(`[RESOLVE] Streamlabs: ${slUrl}`); return slUrl;
  }

  // 4. StreamElements Content-Check
  const seUrl = `https://streamelements.com/${streamer}/tip`;
  if (await checkUrlValid(seUrl, 'tipperUsername')) {
    await setCachedLink(streamer, 'streamelements', seUrl);
    console.log(`[RESOLVE] StreamElements: ${seUrl}`); return seUrl;
  }

  // 5. TipeeeStream — validate before using (streamer may not have an account)
  const tipeeeUrl = `https://www.tipeeestream.com/${streamer}/donation`;
  if (await checkUrlValid(tipeeeUrl, 'pseudo')) {
    await setCachedLink(streamer, 'tipeeestream', tipeeeUrl);
    console.log(`[RESOLVE] TipeeeStream: ${tipeeeUrl}`);
    return tipeeeUrl;
  }

  // 6. No valid donation link found
  console.log(`[RESOLVE] Kein Donation-Link für @${streamer} gefunden — alle Plattformen geprüft`);
  return null;
}

// ── Pool Queue ────────────────────────────────────────────────────────────────

let botActive = false;
const botQueue = [];

async function processNextInQueue() {
  if (botQueue.length === 0) { botActive = false; return; }
  const nextId = botQueue.shift();
  console.log(`[QUEUE] Nächster Pool: ${nextId} (${botQueue.length} verbleibend)`);
  await _runTrigger(nextId);
}

async function triggerPool(poolId) {
  if (botActive) {
    botQueue.push(poolId);
    console.log(`[QUEUE] Pool ${poolId} eingereiht (Position ${botQueue.length})`);
    return { success: true, queued: true };
  }
  botActive = true;
  await _runTrigger(poolId);
  return { success: true };
}

async function _runTrigger(poolId) {
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [poolId]);
  const contributors = await dbAll("SELECT teilnehmer_name FROM contributions WHERE pool_id = ? AND status = 'paid'", [poolId]);
  const names = contributors.map(c => c.teilnehmer_name).join(', ');
  const donationMessage = `${pool.gruppe_name}: ${names} — ${pool.message}`;

  await dbRun('UPDATE pools SET status = ? WHERE id = ?', ['triggered', poolId]);

  const donationUrl = await resolveDonationUrl(pool.streamer);
  if (!donationUrl) {
    const msg = `Kein Donation-Link für @${pool.streamer} gefunden — Pool wird nicht ausgelöst`;
    console.error(`[TRIGGER] ${msg}`);
    await dbRun('UPDATE pools SET status = ? WHERE id = ?', ['captcha_required', poolId]);
    await dbRun('INSERT INTO bot_logs (id, pool_id, platform, status, message) VALUES (?, ?, ?, ?, ?)',
      [uid(), poolId, 'unknown', 'error', msg]);
    await sendTelegram(`❌ <b>Kein Donation-Link</b>\nPool: <code>${poolId}</code>\nStreamer: @${pool.streamer}\n${msg}`);
    processNextInQueue();
    return;
  }
  const platform = donationUrl.includes('streamlabs') ? 'streamlabs' : donationUrl.includes('streamelements') ? 'streamelements' : 'tipeeestream';
  console.log(`[TRIGGER] ${poolId} → ${donationUrl}`);

  // Telegram: Bot gestartet
  await sendTelegram(`🚀 <b>GroupPool Bot gestartet</b>\nPool: <code>${poolId}</code>\nStreamer: @${pool.streamer}\nBetrag: ${pool.ist_betrag.toFixed(2)} €\nPlattform: ${platform}`);

  runBotDonation(pool.streamer, pool.ist_betrag, donationMessage, pool.gruppe_name, donationUrl,
    async (status, msg) => {
      await dbRun('INSERT INTO bot_logs (id, pool_id, platform, status, message) VALUES (?, ?, ?, ?, ?)',
        [uid(), poolId, platform, status, msg]);  // fresh uid() per log entry
    }
  )
  .then(async () => {
    await sendTelegram(`✅ <b>GroupPool Bot erfolgreich</b>\nStreamer: @${pool.streamer}\nBetrag: ${pool.ist_betrag.toFixed(2)} €\nPlattform: ${platform}`);
  })
  .catch(async (err) => {
    if (err.message === 'CAPTCHA_REQUIRED') {
      console.log(`[CAPTCHA-REQUIRED] Pool ${poolId}`);
      await dbRun('UPDATE pools SET status = ? WHERE id = ?', ['captcha_required', poolId]);
      await dbRun('INSERT INTO bot_logs (id, pool_id, platform, status, message) VALUES (?, ?, ?, ?, ?)',
        [uid(), poolId, platform, 'captcha', 'CAPTCHA blockiert']);
      await sendTelegram(`🚨 <b>CAPTCHA blockiert Bot!</b>\nPool: <code>${poolId}</code>\nStreamer: @${pool.streamer}\nPlatform: ${platform}\n→ Manuelle Zahlung nötig`);
    } else {
      console.error('[BOT-TRIGGER] Fehler:', err.message);
      await dbRun('INSERT INTO bot_logs (id, pool_id, platform, status, message) VALUES (?, ?, ?, ?, ?)',
        [uid(), poolId, platform, 'error', err.message.slice(0, 500)]);
    }
  })
  .finally(() => processNextInQueue());

  await Promise.all([
    sendStreamlabsDonation({ name: pool.gruppe_name, message: donationMessage, amount: pool.ist_betrag }),
    sendStreamlabsAlert(donationMessage),
  ]);
}

// ── Routes: Pools ─────────────────────────────────────────────────────────────

app.get('/api/live-streamers', async (req, res) => {
  res.json({ streamers: await fetchLiveStreamers() });
});

app.get('/api/pools', async (req, res) => {
  const pools = await dbAll(`
    SELECT p.*, COUNT(CASE WHEN c.status = 'paid' THEN 1 END) AS contributor_count
    FROM pools p LEFT JOIN contributions c ON c.pool_id = p.id
    WHERE p.status IN ('open','pending_creator','triggered','captcha_required','expired')
    GROUP BY p.id ORDER BY p.created_at DESC`);
  // AUFGABE 3: Live-Status aus Cache anhängen
  const liveSet = new Set(liveStreamerCache.streamers.map(s => s.user_login.toLowerCase()));
  const enriched = pools.map(p => ({ ...p, is_live: liveSet.has(p.streamer.toLowerCase()) }));
  res.json({ pools: enriched });
});

// AUFGABE 5: Pool erstellen + Ersteller-Beitrag via Stripe
app.post('/pool/create', async (req, res) => {
  const { streamer, ziel_betrag, message, gruppe_name, ersteller_name, ersteller_beitrag } = req.body;
  if (!streamer || !ziel_betrag || !message || !gruppe_name)
    return res.status(400).json({ error: 'Fehlende Felder' });
  if (Number(ziel_betrag) < 1)
    return res.status(400).json({ error: 'Mindest-Zielbetrag: 1 €' });
  if (Number(ziel_betrag) > 10)
    return res.status(400).json({ error: 'Maximaler Zielbetrag für Tests: 10 €' });

  const beitrag = Number(ersteller_beitrag) || 0;
  const base    = process.env.BASE_URL || 'http://localhost:3001';
  const id      = uid();

  // Pool mit status 'pending_creator' anlegen (erst sichtbar nach Ersteller-Zahlung)
  await dbRun(
    "INSERT INTO pools (id, streamer, gruppe_name, message, ziel_betrag, status) VALUES (?, ?, ?, ?, ?, 'pending_creator')",
    [id, streamer, gruppe_name, message, Number(ziel_betrag)]
  );

  // Wenn Ersteller-Beitrag ≥ 1 €: Stripe Checkout
  if (ersteller_name && beitrag >= 1) {
    const amountWithFee = Math.round(beitrag * (1 + FEE_RATE) * 100);
    const cid = uid();
    await dbRun("INSERT INTO contributions (id, pool_id, teilnehmer_name, betrag, status) VALUES (?, ?, ?, ?, 'pending')",
      [cid, id, ersteller_name, beitrag]);
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: { name: `GroupPool erstellen: ${gruppe_name} → @${streamer}`, description: 'Dein Starter-Beitrag (inkl. 5% Gebühr)' },
            unit_amount: amountWithFee,
          },
          quantity: 1,
        }],
        mode: 'payment',
        success_url: `${base}/pool.html?id=${id}&success=1`,
        cancel_url:  `${base}/?cancel=1`,
        metadata: { pool_id: id, teilnehmer_name: ersteller_name, contrib_id: cid, betrag_original: String(beitrag), is_creator: 'true' },
      });
      await dbRun('UPDATE contributions SET stripe_session = ? WHERE id = ?', [session.id, cid]);
      return res.status(201).json({ success: true, pool: { id, streamer, gruppe_name, message, ziel_betrag }, checkout_url: session.url });
    } catch (err) {
      await dbRun('DELETE FROM pools WHERE id = ?', [id]);
      await dbRun('DELETE FROM contributions WHERE id = ?', [cid]);
      return res.status(500).json({ error: err.message });
    }
  }

  // Kein Beitrag: Pool sofort 'open' (Rückwärtskompatibilität für Tests via /pool/create ohne Beitrag)
  await dbRun("UPDATE pools SET status = 'open' WHERE id = ?", [id]);
  res.status(201).json({ success: true, pool: { id, streamer, gruppe_name, message, ziel_betrag } });
});

app.get('/pool/:id', async (req, res) => {
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
  const contributions = await dbAll("SELECT * FROM contributions WHERE pool_id = ? AND status = 'paid' ORDER BY created_at ASC", [req.params.id]);
  res.json({ pool, contributions });
});

// Simulierter Join (bleibt für Tests)
app.post('/pool/:id/join', async (req, res) => {
  const { teilnehmer_name, betrag } = req.body;
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
  if (Number(betrag) < 1) return res.status(400).json({ error: 'Mindestbetrag: 1 €' });
  const cid = uid();
  await dbRun("INSERT INTO contributions (id, pool_id, teilnehmer_name, betrag, status) VALUES (?, ?, ?, ?, 'paid')",
    [cid, pool.id, teilnehmer_name, Number(betrag)]);
  await dbRun('UPDATE pools SET ist_betrag = ist_betrag + ? WHERE id = ?', [Number(betrag), pool.id]);
  const updated = await dbGet('SELECT * FROM pools WHERE id = ?', [pool.id]);
  if (updated.ist_betrag >= updated.ziel_betrag && updated.status === 'open') await triggerPool(pool.id);
  res.json({ success: true, msg: 'Simuliert erfolgreich' });
});

// ── Stripe Checkout (AUFGABEN 1 + 7) ─────────────────────────────────────────

const FEE_RATE = 0.05; // 5%

app.post('/pool/:id/checkout', async (req, res) => {
  const { teilnehmer_name, betrag } = req.body;
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
  if (!teilnehmer_name) return res.status(400).json({ error: 'Name erforderlich' });
  const amount = Number(betrag);
  if (!amount || amount < 1) return res.status(400).json({ error: 'Mindestbetrag: 1 €' });

  const amountWithFee = Math.round(amount * (1 + FEE_RATE) * 100); // Cents inkl. 5% Fee
  const cid  = uid();
  const base = process.env.BASE_URL || 'http://localhost:3001';

  // Contribution ohne Fee speichern
  await dbRun("INSERT INTO contributions (id, pool_id, teilnehmer_name, betrag, status) VALUES (?, ?, ?, ?, 'pending')",
    [cid, pool.id, teilnehmer_name, amount]);
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `GroupPool: ${pool.gruppe_name} → @${pool.streamer}`, description: `inkl. 5% Servicegebühr` },
          unit_amount: amountWithFee,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${base}/pool.html?id=${pool.id}&success=1`,
      cancel_url:  `${base}/pool.html?id=${pool.id}&cancel=1`,
      metadata: { pool_id: pool.id, teilnehmer_name, contrib_id: cid, betrag_original: String(amount) },
    });
    await dbRun('UPDATE contributions SET stripe_session = ? WHERE id = ?', [session.id, cid]);
    res.json({ url: session.url, amount_with_fee: (amountWithFee / 100).toFixed(2) });
  } catch (err) {
    await dbRun('DELETE FROM contributions WHERE id = ?', [cid]);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe Webhook ────────────────────────────────────────────────────────────

app.post('/webhook/stripe', async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  let event;
  try {
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[WEBHOOK] Sig-Fehler:', err.message, '| secret set:', !!secret, '| body type:', typeof req.body);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object;
    const poolId    = session.metadata?.pool_id;
    const teilnehmer = session.metadata?.teilnehmer_name || 'Anonym';
    const betrag    = parseFloat(session.metadata?.betrag_original || '0'); // ohne Fee!
    console.log(`[WEBHOOK] paid | Pool: ${poolId} | €${betrag}`);

    if (poolId && betrag > 0) {
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
        // AUFGABE 5: Ersteller-Zahlung aktiviert den Pool
        if (session.metadata?.is_creator === 'true') {
          await dbRun("UPDATE pools SET status = 'open' WHERE id = ? AND status = 'pending_creator'", [poolId]);
          console.log(`[WEBHOOK] Pool ${poolId} durch Ersteller-Zahlung aktiviert`);
        }
        const updated = await dbGet('SELECT * FROM pools WHERE id = ?', [poolId]);
        if (updated?.status === 'open' && updated.ist_betrag >= updated.ziel_betrag) await triggerPool(poolId);
      } catch (err) {
        console.error('[WEBHOOK] Fehler:', err.message);
      }
    }
  }
  res.json({ received: true });
});

// ── Admin Routes ──────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/pool/:id/manual-trigger', requireAdmin, async (req, res) => {
  const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
  await triggerPool(req.params.id);
  res.json({ success: true, pool_id: req.params.id });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const [pools, logs, platforms] = await Promise.all([
    dbAll('SELECT * FROM pools ORDER BY created_at DESC LIMIT 50'),
    dbAll("SELECT * FROM bot_logs WHERE timestamp > datetime('now', '-24 hours') ORDER BY timestamp DESC"),
    dbAll('SELECT * FROM platform_status'),
  ]);
  res.json({ pools, logs, platforms });
});

// ── Pool Detail Page (mit OpenGraph) ─────────────────────────────────────────

app.get('/pool/:id/og', async (req, res) => {
  try {
    const pool  = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.redirect('/');
    const contribs = await dbAll("SELECT COUNT(*) AS cnt FROM contributions WHERE pool_id = ? AND status = 'paid'", [req.params.id]);
    const cnt  = contribs[0]?.cnt || 0;
    const pct  = Math.min(100, Math.round(pool.ist_betrag / pool.ziel_betrag * 100));
    const base = process.env.BASE_URL || 'http://localhost:3001';
    const pageUrl = `${base}/pool.html?id=${pool.id}`;
    const title = `GroupPool: ${pool.gruppe_name} für @${pool.streamer}`;
    const desc  = `${pool.ist_betrag.toFixed(2)} € von ${pool.ziel_betrag.toFixed(2)} € gesammelt (${pct}%) · ${cnt} Teilnehmer · "${pool.message}"`;
    res.set('Content-Type', 'text/html').send(`<!DOCTYPE html><html><head>
      <meta charset="UTF-8">
      <title>${esc(title)}</title>
      <meta name="description" content="${esc(desc)}">
      <meta property="og:title" content="${esc(title)}">
      <meta property="og:description" content="${esc(desc)}">
      <meta property="og:url" content="${esc(pageUrl)}">
      <meta property="og:type" content="website">
      <meta property="og:site_name" content="GroupPool">
      <meta name="twitter:card" content="summary">
      <meta name="twitter:title" content="${esc(title)}">
      <meta name="twitter:description" content="${esc(desc)}">
      <meta http-equiv="refresh" content="0;url=${esc(pageUrl)}">
    </head><body><a href="${esc(pageUrl)}">→ Zum Pool</a></body></html>`);
  } catch (e) {
    res.redirect('/');
  }
});

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

app.get('/pool.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pool.html'));
});

// ── Streamer Onboarding ───────────────────────────────────────────────────────

app.get('/streamer/:name', async (req, res) => {
  const name = req.params.name.toLowerCase().trim();
  try {
    // Cache prüfen
    const cached = await getCachedLink(name);
    if (cached) {
      const platform = cached.includes('streamlabs') ? 'streamlabs' : cached.includes('streamelements') ? 'streamelements' : 'tipeeestream';
      return res.json({ streamer: name, platform, donationUrl: cached, cached: true });
    }
    // Scrapen
    const donationUrl = await resolveDonationUrl(name);
    if (!donationUrl) return res.status(404).json({ error: `Kein Donation-Link für @${name} gefunden` });
    const platform = donationUrl.includes('streamlabs') ? 'streamlabs' : donationUrl.includes('streamelements') ? 'streamelements' : 'tipeeestream';
    res.json({ streamer: name, platform, donationUrl, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/streamer.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'streamer.html'));
});

// ── Start + Monitor ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

// ── Pool-Ablauf (AUFGABE 4) ────────────────────────────────────────────────────

async function expireOldPools() {
  const expired = await dbAll(
    "SELECT * FROM pools WHERE status = 'open' AND created_at < datetime('now', '-24 hours')"
  );
  for (const pool of expired) {
    console.log(`[EXPIRE] Pool ${pool.id} abgelaufen — initiiere Refunds...`);
    await dbRun("UPDATE pools SET status = 'expired' WHERE id = ?", [pool.id]);

    const contribs = await dbAll(
      "SELECT * FROM contributions WHERE pool_id = ? AND status = 'paid' AND stripe_session IS NOT NULL",
      [pool.id]
    );
    for (const c of contribs) {
      try {
        const refund = await stripe.refunds.create({ payment_intent: c.stripe_session }).catch(async () => {
          // stripe_session might be a checkout session ID, try to get payment_intent
          const session = await stripe.checkout.sessions.retrieve(c.stripe_session);
          return stripe.refunds.create({ payment_intent: session.payment_intent });
        });
        await dbRun("UPDATE contributions SET status = 'refunded' WHERE id = ?", [c.id]);
        console.log(`[REFUND] ${c.id} → ${refund.id}`);
      } catch (e) {
        console.error(`[REFUND] Fehler für ${c.id}:`, e.message);
      }
    }

    const totalRefunded = contribs.reduce((s, c) => s + c.betrag, 0);
    await sendTelegram(
      `⏰ <b>Pool abgelaufen</b>\nPool: <code>${pool.id}</code>\nStreamer: @${pool.streamer}\n` +
      `Gesammelt: ${pool.ist_betrag.toFixed(2)} € / ${pool.ziel_betrag.toFixed(2)} €\n` +
      `Refunds: ${contribs.length} Beiträge (${totalRefunded.toFixed(2)} €) zurückgezahlt`
    );
  }
  if (expired.length) console.log(`[EXPIRE] ${expired.length} Pools abgelaufen`);
}

initDb().then(() => {
  app.listen(PORT, async () => {
    console.log(`GroupPool läuft auf http://localhost:${PORT}`);
    const whSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    console.log(`[CONFIG] STRIPE_WEBHOOK_SECRET: ${whSecret ? `gesetzt (${whSecret.length} Zeichen, beginnt mit "${whSecret.slice(0,8)}...")` : 'NICHT GESETZT — Webhooks werden fehlschlagen!'}`);
    console.log(`[CONFIG] STRIPE_SECRET_KEY: ${process.env.STRIPE_SECRET_KEY ? 'gesetzt' : 'NICHT GESETZT'}`);
    console.log(`[CONFIG] BASE_URL: ${process.env.BASE_URL || '(nicht gesetzt, Standard: http://localhost:3001)'}`);
    console.log(`[CONFIG] DATABASE_URL: ${process.env.DATABASE_URL ? 'gesetzt (PostgreSQL)' : 'nicht gesetzt (SQLite)'}`);

    try {
      const streamers = await fetchLiveStreamers();
      streamers.slice(0, 20).forEach(s => resolveDonationUrl(s.user_login).catch(() => {}));
      console.log(`[STARTUP] Pre-caching ${Math.min(20, streamers.length)} Streamer-Links...`);
    } catch {}
    try { require('./monitor').start(null, dbGet, dbAll, dbRun, sendTelegram, fetchLiveStreamers); }
    catch (e) { console.error('[MONITOR] Start-Fehler:', e.message); }
    // AUFGABE 4: Pool-Ablauf alle 30 Minuten prüfen
    expireOldPools().catch(e => console.error('[EXPIRE]', e.message));
    setInterval(() => expireOldPools().catch(e => console.error('[EXPIRE]', e.message)), 30 * 60_000);
  });
}).catch(e => {
  console.error('[FATAL] DB init fehlgeschlagen:', e.message);
  process.exit(1);
});

module.exports = { dbGet, dbAll, dbRun, sendTelegram };
