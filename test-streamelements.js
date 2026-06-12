const fs = require('fs');
const https = require('https');

// Load .env
const env = fs.readFileSync('.env', 'utf8');
const get = (key) => env.match(new RegExp(`${key}=(.+)`))?.[1]?.trim();

const JWT_TOKEN = get('SE_JWT_TOKEN');
const CHANNEL_ID = get('SE_CHANNEL_ID');

if (!JWT_TOKEN || JWT_TOKEN === 'DEIN_JWT_TOKEN_HIER') {
  console.error('Fehler: SE_JWT_TOKEN fehlt in .env');
  process.exit(1);
}
if (!CHANNEL_ID || CHANNEL_ID === 'DEINE_CHANNEL_ID_HIER') {
  console.error('Fehler: SE_CHANNEL_ID fehlt in .env');
  process.exit(1);
}

console.log('JWT Token:', JWT_TOKEN.slice(0, 20) + '...');
console.log('Channel ID:', CHANNEL_ID, '\n');

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.streamelements.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${JWT_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(payload && { 'Content-Length': Buffer.byteLength(payload) }),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => raw += chunk);
      res.on('end', () => {
        console.log(`HTTP ${res.statusCode}`);
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  // 1. Channel Info
  console.log('=== GET /kappa/v2/channels/me ===');
  const me = await request('GET', '/kappa/v2/channels/me');
  console.log(JSON.stringify(me, null, 2));

  // 2. Test Alert (triggert sofort auf dem Stream)
  console.log('\n=== POST /kappa/v2/activities/{channelId}/test ===');
  const alert = await request('POST', `/kappa/v2/activities/${CHANNEL_ID}/test`, {
    type: 'tip',
    data: {
      username: 'GroupPool-Test',
      amount: 1.00,
      currency: 'EUR',
      message: 'Wir sind 5 Viewer und sagen Danke!',
    },
  });
  console.log(JSON.stringify(alert, null, 2));

  // 3. Echte Test-Donation
  console.log('\n=== POST /kappa/v2/tips/{channelId} ===');
  const tip = await request('POST', `/kappa/v2/tips/${CHANNEL_ID}`, {
    user: {
      username: 'GroupPool-Test',
      email: 'test@grouppool.com',
    },
    donation: {
      amount: 1.00,
      currency: 'EUR',
      message: 'Wir sind 5 Viewer und sagen Danke!',
    },
    amount: 1.00,
  });
  console.log(JSON.stringify(tip, null, 2));
}

main().catch(console.error);
