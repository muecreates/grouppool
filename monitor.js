'use strict';
const fetch = require('node-fetch');

// ── Zeitplan-Logik ────────────────────────────────────────────────────────────

function getIntervalMs() {
  const now = new Date();
  const hour = now.getHours();
  const day  = now.getDay(); // 0=So, 5=Fr, 6=Sa

  // Fr/Sa Nacht bis 3 Uhr: 30 Min
  if ((day === 5 || day === 6) && hour < 3) return 30 * 60_000;
  // Nacht 23-6 Uhr: 2 Stunden
  if (hour >= 23 || hour < 6) return 2 * 60 * 60_000;
  // Tagsüber 6-23 Uhr: 30 Min
  return 30 * 60_000;
}

// ── Plattform-Checks ──────────────────────────────────────────────────────────

const CHECKS = [
  {
    platform: 'streamlabs',
    url:      'https://streamlabs.com/eliasn97/tip',
    signal:   'Streamlabs',   // in page title / meta — SSR-safe
    label:    'Streamlabs',
  },
  {
    platform: 'tipeeestream',
    url:      'https://www.tipeeestream.com/eliasn97/donation',
    signal:   'tipeeestream', // in canonical URL / meta — SSR-safe
    label:    'TipeeeStream',
  },
  {
    platform: 'streamelements',
    url:      'https://streamelements.com/eliasn97/tip',
    signal:   'StreamElements',
    label:    'StreamElements',
  },
];

async function checkPlatform(check) {
  try {
    const res = await fetch(check.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GroupPool-Monitor/1.0)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.text();
    const ok = body.includes(check.signal);
    return { ok, error: ok ? null : `Selektor "${check.signal}" nicht gefunden` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkTwitchApi(fetchLiveStreamers) {
  try {
    const streamers = await fetchLiveStreamers();
    return { ok: Array.isArray(streamers), error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Cache-Refresh ─────────────────────────────────────────────────────────────

async function refreshStreamerCache(dbAll, dbRun, sendTelegram) {
  try {
    const links = await dbAll('SELECT DISTINCT streamer FROM streamer_links');
    for (const { streamer } of links) {
      const rows = await dbAll(
        'SELECT * FROM streamer_links WHERE streamer = ? ORDER BY last_checked ASC LIMIT 1',
        [streamer]
      );
      if (!rows.length) continue;
      const ageMs = Date.now() - new Date(rows[0].last_checked).getTime();
      if (ageMs > 6 * 60 * 60_000) {
        console.log(`[MONITOR] Cache refresh für ${streamer}...`);
        // Re-scrape läuft beim nächsten resolveDonationUrl automatisch (Cache miss)
        await dbRun('DELETE FROM streamer_links WHERE streamer = ?', [streamer]);
      }
    }
  } catch (err) {
    console.error('[MONITOR] Cache-Refresh-Fehler:', err.message);
  }
}

// ── Haupt-Monitor-Schleife ────────────────────────────────────────────────────

function start(db, dbGet, dbAll, dbRun, sendTelegram, fetchLiveStreamers) {
  console.log('[MONITOR] Gestartet');

  async function runChecks() {
    const now = new Date().toISOString();
    console.log(`[MONITOR] Checks um ${now}`);

    // Plattform-Checks
    for (const check of CHECKS) {
      const { ok, error } = await checkPlatform(check);
      const prev = await dbGet('SELECT * FROM platform_status WHERE platform = ?', [check.platform]);

      if (ok) {
        await dbRun(
          'UPDATE platform_status SET healthy = 1, last_check = ?, last_error = NULL, degraded_since = NULL WHERE platform = ?',
          [now, check.platform]
        );
        if (prev && !prev.healthy) {
          console.log(`[MONITOR] ${check.label} wieder gesund ✓`);
          await sendTelegram(`✅ <b>${check.label} wieder verfügbar</b>\nWar degraded seit: ${prev.degraded_since || '?'}`);
        }
      } else {
        const degradedSince = (prev && !prev.healthy) ? prev.degraded_since : now;
        await dbRun(
          'UPDATE platform_status SET healthy = 0, last_check = ?, last_error = ?, degraded_since = ? WHERE platform = ?',
          [now, error, degradedSince, check.platform]
        );
        console.error(`[MONITOR] ${check.label} DEGRADED: ${error}`);
        if (prev?.healthy !== 0) { // nur beim ersten Mal alarmieren
          await sendTelegram(`🚨 <b>${check.label} degraded!</b>\nFehler: ${error}\nURL: ${check.url}`);
        }
      }
    }

    // Twitch API Check
    const twitchResult = await checkTwitchApi(fetchLiveStreamers);
    const tw = await dbGet('SELECT * FROM platform_status WHERE platform = ?', ['twitch']);
    if (!twitchResult.ok) {
      await dbRun('UPDATE platform_status SET healthy = 0, last_check = ?, last_error = ? WHERE platform = ?',
        [now, twitchResult.error, 'twitch']);
      if (tw?.healthy !== 0) await sendTelegram(`🚨 <b>Twitch API degraded!</b>\n${twitchResult.error}`);
    } else {
      await dbRun('UPDATE platform_status SET healthy = 1, last_check = ?, last_error = NULL WHERE platform = ?', [now, 'twitch']);
    }

    // Cache-Refresh
    await refreshStreamerCache(dbAll, dbRun, sendTelegram);
  }

  // Sofort laufen, dann selbst-planend
  runChecks().catch(e => console.error('[MONITOR] Fehler:', e.message));

  function schedule() {
    const ms = getIntervalMs();
    console.log(`[MONITOR] Nächster Check in ${Math.round(ms / 60_000)} Minuten`);
    setTimeout(async () => {
      await runChecks().catch(e => console.error('[MONITOR] Fehler:', e.message));
      schedule(); // rekursiv neu planen
    }, ms);
  }

  schedule();
}

module.exports = { start };
