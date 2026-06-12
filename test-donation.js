const fs = require('fs');
const https = require('https');
const querystring = require('querystring');

// Load .env
const env = fs.readFileSync('.env', 'utf8');
const token = env.match(/STREAMLABS_ACCESS_TOKEN=(.+)/)?.[1]?.trim();
if (!token) { console.error('No STREAMLABS_ACCESS_TOKEN found'); process.exit(1); }
console.log('Token loaded:', token.slice(0, 20) + '...\n');

function post(path, data) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(data);
    const options = {
      hostname: 'streamlabs.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
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
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('--- POST /api/v2.0/donations ---');
  const donationRes = await post('/api/v2.0/donations', {
    name: 'GroupPool-Test',
    message: 'Wir sind 5 Viewer und sagen Danke!',
    amount: '1.00',
    currency: 'EUR',
    identifier: 'test@grouppool.com',
  });
  console.log(JSON.stringify(donationRes, null, 2));

  console.log('\n--- POST /api/v2.0/alerts ---');
  const alertRes = await post('/api/v2.0/alerts', {
    type: 'donation',
    message: 'GroupPool Alert Test!',
  });
  console.log(JSON.stringify(alertRes, null, 2));
}

main().catch(console.error);
