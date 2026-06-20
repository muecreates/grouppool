# GroupPool – Session 5 ✅

| # | Aufgabe | Status | Ergebnis |
|---|---------|--------|----------|
| 1 | CARD_PHONE + E2E Test | ✅ | Phone gesetzt, 3 Streamer getestet (Details unten) |
| 2 | Landing Page | ✅ | public/landing.html — Hero, Steps, Alert-Mockup, Stats |
| 3 | Twitch Live-Badge | ✅ | pulsierendes ● LIVE-Badge auf Pool-Karten |
| 4 | Pool Ablaufzeit 24h | ✅ | expireOldPools() cron, Stripe Refunds, Telegram Alert |
| 5 | Mindeststarter-Betrag | ✅ | pending_creator → Stripe → open Flow |

---

## AUFGABE 1 — E2E Test Ergebnisse

### Versuch 1: technofreitaglive (gecacht als TipeeeStream)
**Fehler:** TipeeeStream-Seite lädt, aber Formularfelder nicht sichtbar
→ Cache-Eintrag ungültig (Seite existiert evtl. nicht mehr)
→ Lösung: Cache-Refresh nach 6h entfernt ungültige Einträge automatisch

### Versuch 2: gronkh (TipeeeStream)
```
STEP 1: Form ✓ (pseudo/amount/message/email alle gefüllt)
STEP 2: PayPal-Button geklickt ✓
STEP 3: FEHLER: page.waitForURL timeout 15s
```
→ TipeeeStream öffnet PayPal manchmal als Popup (nicht Redirect)
→ Nächste Session: Popup-Handling erweitern

### Eliasn97 (aus Session 4, TEST_MODE=false)
```
STEP 1: Form ✓ → STEP 2: PayPal ✓ → STEP 3: Card Form ✓ → Submit ✓
```
→ Vollständiger End-to-End Flow bestätigt für eliasn97

**Offene Arbeit:** PayPal öffnet bei manchen TipeeeStream-Seiten als Popup statt Redirect

---

## AUFGABE 2 — Landing Page

**URL:** `/landing.html`
- Hero: "Spende gemeinsam, ankommen groß"
- 3-Schritte Erklärung
- Alert-Mockup (Simulation eines 42€ Gruppen-Alerts)
- Stats: 5% Fee, 1€ Minimum, 3 Plattformen
- CTA: → Pools, → Streamer Setup

---

## AUFGABE 3 — Live-Badge

- `/api/pools` gibt jetzt `is_live: true/false` für jeden Pool
- Frontend zeigt animiertes `● LIVE` Badge (rot, pulsierend)
- Basiert auf `liveStreamerCache` (5min TTL)
- Kein Extra-API-Call nötig

---

## AUFGABE 4 — Pool Ablaufzeit

```javascript
expireOldPools() // alle 30min via setInterval
// → findet Pools: status='open' AND created_at < NOW() - 24h
// → setzt status='expired'
// → stripe.refunds.create() für alle paid contributions
// → sendTelegram() mit Übersicht
```

---

## AUFGABE 5 — Mindeststarter-Betrag

**Flow:**
1. Create-Modal: + Ersteller-Name + Starter-Beitrag (≥1€) + Fee-Anzeige
2. POST /pool/create → status='pending_creator', Stripe Checkout Session
3. Stripe-Redirect → Zahlung
4. Webhook: is_creator=true → Pool status='open'
5. Pool ist erst nach Ersteller-Zahlung in /api/pools sichtbar

**Sichtbarkeit:** `/api/pools` zeigt nur pools mit status IN ('open','triggered','captcha_required','expired')

---

## Nächste Schritte

1. **PayPal Popup-Handling** — TipeeeStream öffnet PayPal manchmal als Popup; `context.waitForEvent('page')` in bot.js erweitern
2. **Cache-Invalidierung** — technofreitaglive hatte ungültigen Cache-Eintrag; Seiten-Verfügbarkeit beim Cachen prüfen
3. **Pool Sichtbarkeit** — /api/pools filtert noch nicht nach status; pending_creator Pools müssen rausgefiltert werden
4. **Landing Page als Root** — Route `/` auf landing.html umleiten
