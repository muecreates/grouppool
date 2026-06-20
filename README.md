# GroupPool

Gemeinsam spenden — GroupPool sammelt Beiträge mehrerer Nutzer in einem Pool und sendet die Gesamtsumme automatisch per Bot an den Twitch-Streamer.

## Was es tut

1. Nutzer erstellen einen Pool für einen Streamer (Zielbetrag + Nachricht)
2. Andere Nutzer treten bei und zahlen einen Betrag
3. Sobald der Zielbetrag erreicht ist, triggert der Bot automatisch
4. Der Bot öffnet die Donation-Seite des Streamers (Streamlabs / StreamElements / TipeeeStream) und füllt das Formular aus

## Setup

```bash
git clone https://github.com/...
cd groupdonation
npm install          # installiert auch Playwright + Chromium via postinstall
cp .env.example .env # .env befüllen
node server.js
```

## .env Variablen

| Variable | Beschreibung |
|----------|-------------|
| `TWITCH_CLIENT_ID` | Twitch App Client-ID |
| `TWITCH_CLIENT_SECRET` | Twitch App Secret |
| `STREAMLABS_ACCESS_TOKEN` | Streamlabs OAuth Token (für API-Alerts) |
| `STRIPE_SECRET_KEY` | Stripe Secret Key (sk_test_... oder sk_live_...) |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook Signing Secret |
| `ADMIN_SECRET` | Sicheres Passwort für Admin-Endpunkte |
| `HEADLESS` | `false` = Browser sichtbar (lokal), leer = headless (Produktion) |
| `CARD_NUMBER` | Kartennummer für Bot-Zahlung |
| `CARD_EXPIRY` | Ablaufdatum (MM/JJ) |
| `CARD_CVV` | CVV-Code |
| `CARD_FIRSTNAME` / `CARD_LASTNAME` | Karteninhaber |
| `CARD_ADDRESS` / `CARD_PLZ` / `CARD_CITY` | Rechnungsadresse |
| `CARD_EMAIL` | E-Mail für Zahlungsbestätigung |
| `PORT` | Server-Port (Standard: 3001) |

## curl Beispiele

### Pool erstellen
```bash
curl -X POST http://localhost:3001/pool/create \
  -H "Content-Type: application/json" \
  -d '{"streamer":"eliasn97","gruppe_name":"Die Crew","message":"Super Stream!","ziel_betrag":20}'
```

### Pool joinen (simuliert)
```bash
curl -X POST http://localhost:3001/pool/POOL_ID/join \
  -H "Content-Type: application/json" \
  -d '{"teilnehmer_name":"Julian","betrag":20}'
```

### Pool manuell triggern (Admin)
```bash
curl -X POST http://localhost:3001/admin/pool/POOL_ID/manual-trigger \
  -H "x-admin-secret: DEIN_ADMIN_SECRET"
```

### Live-Streams abrufen
```bash
curl http://localhost:3001/api/live-streamers
```

## Unterstützte Plattformen

| Plattform | Status | Zahlungsweg |
|-----------|--------|-------------|
| TipeeeStream | ✅ Voll automatisiert | PayPal → Kreditkarte |
| Streamlabs | ⚠️ Teilweise | PayPal (Kreditkarte erfordert Login) |
| StreamElements | ⚠️ Teilweise | ESC schließt Login-Modal, Tip-Button führt zu Login |

## CAPTCHA Handling

Falls ein CAPTCHA erkannt wird, setzt der Bot den Pool-Status auf `captcha_required`. Im Frontend erscheint eine rote Badge mit Pool-ID und Betrag für manuelle Zahlung. Admin kann dann mit `/admin/pool/:id/manual-trigger` den Pool manuell auf `triggered` setzen.

## Railway Deployment

1. Repository pushen
2. Railway: neues Projekt → GitHub-Repo verbinden
3. Alle `.env`-Variablen in Railway Settings setzen
4. `npm install` läuft automatisch und installiert Playwright Chromium via `postinstall`
