# GroupPool – Fortschrittsdokumentation

## Session 3 — abgeschlossen ✅

| # | Aufgabe | Status | Ergebnis |
|---|---------|--------|----------|
| 1 | Stripe Checkout + 5% Fee | ✅ | /pool/:id/checkout, betrag_original in metadata, webhook-kompatibel |
| 2 | Pool-Detail /pool.html | ✅ | Fortschrittsbalken, Teilnehmer, Zeit-Ago, Share, Fee-Anzeige |
| 3 | Health-Monitor monitor.js | ✅ | dynamisches Intervall, 4 Plattformen, Telegram-Alert bei Degraded |
| 4 | Streamer-Link Cache | ✅ | streamer_links Tabelle, 6h TTL, Top-20 pre-cached bei Start |
| 5 | Bot-Robustheit + bot_logs | ✅ | withTimeout 30s/Step, onLog Callback, bot_logs Tabelle |
| 6 | Admin Dashboard /admin | ✅ | Stats, Pools, Logs, Trigger-Buttons, x-admin-secret geschützt |
| 7 | Fee-Logik + Mindestbetrag | ✅ | 5% in Stripe, original in DB, 1€ Minimum validiert |
| 8 | Telegram Notifications | ✅ | Start/Erfolg/CAPTCHA/Degraded/Recovery Alerts |
| 9 | Railway production ready | ✅ | https://groupdonation-production.up.railway.app live |
| 10 | Testplan | ✅ | Siehe unten |

---

## Architektur-Übersicht

```
Browser → index.html → /pool/:id/checkout → Stripe Checkout
                                 ↓
                          stripe webhook
                                 ↓
                     contribution.status = paid
                                 ↓
                     pool.ist_betrag >= ziel? → triggerPool()
                                                    ↓
                                           Bot-Queue (botActive flag)
                                                    ↓
                                         resolveDonationUrl() → Cache → Scrape
                                                    ↓
                                         runBotDonation() → TipeeeStream/SL/SE
                                                    ↓
                                         bot_logs + Telegram
```

## Endpoints

| Route | Methode | Auth | Beschreibung |
|-------|---------|------|-------------|
| `/api/pools` | GET | - | Alle Pools |
| `/api/live-streamers` | GET | - | Live Twitch Streams |
| `/pool/create` | POST | - | Pool erstellen |
| `/pool/:id` | GET | - | Pool + Contributions |
| `/pool/:id/join` | POST | - | Simulierter Join (Tests) |
| `/pool/:id/checkout` | POST | - | Stripe Checkout Session |
| `/webhook/stripe` | POST | Stripe-Sig | Payment Webhook |
| `/admin` | GET | x-admin-secret | Admin Dashboard HTML |
| `/api/admin/stats` | GET | x-admin-secret | Stats JSON |
| `/admin/pool/:id/manual-trigger` | POST | x-admin-secret | Manueller Trigger |
| `/pool.html` | GET | - | Pool-Detail-Seite |

## SQLite Tabellen

| Tabelle | Inhalt |
|---------|--------|
| `pools` | id, streamer, gruppe_name, message, ziel_betrag, ist_betrag, status |
| `contributions` | id, pool_id, teilnehmer_name, betrag, stripe_session, status |
| `platform_status` | platform, healthy, last_check, last_error, degraded_since |
| `streamer_links` | streamer, platform, url, last_checked (6h TTL Cache) |
| `bot_logs` | id, pool_id, timestamp, platform, status, message |

---

## 🧪 Testplan vor Launch — Checkliste

### 1. Echte Zahlung TipeeeStream
- [ ] `TEST_MODE=false` in .env setzen
- [ ] Echter Kreditkartendaten in `.env` (CARD_* Variablen)
- [ ] Pool erstellen: `curl -X POST /pool/create -d '{"streamer":"eliasn97","gruppe_name":"Test","message":"Test","ziel_betrag":1}'`
- [ ] Checkout-Session: `curl -X POST /pool/:id/checkout -d '{"teilnehmer_name":"Test","betrag":1}'`
- [ ] Stripe URL öffnen → Karte eingeben → Zahlung bestätigen
- [ ] Webhook empfangen: `stripe listen --forward-to localhost:3001/webhook/stripe`
- [ ] Pool-Status nach Webhook prüfen
- [ ] Bot startet automatisch, Screenshot in /tmp/

### 2. Echte Zahlung Streamlabs
- [ ] Streamer mit Streamlabs-Panel (z.B. MontanaBlack88) in Pool
- [ ] Gleiches Flow wie TipeeeStream
- [ ] Bot landet auf Streamlabs-Modal → PayPal-Flow

### 3. CAPTCHA-Fall
- [ ] `TWOCAPTCHA_KEY` in .env setzen (2captcha.com Account nötig)
- [ ] Pool mit Streamer triggern der reCAPTCHA verwendet
- [ ] Log zeigt `[CAPTCHA] Gelöst via 2captcha`
- [ ] Falls kein Key: Pool → captcha_required Status + Telegram-Alarm

### 4. Telegram Alert
- [ ] `TELEGRAM_BOT_TOKEN` und `TELEGRAM_CHAT_ID` in .env
- [ ] Pool triggern → Telegram-Nachricht "Bot gestartet"
- [ ] Bot erfolgreich → Telegram "erfolgreich"
- [ ] Monitor: Plattform deaktivieren → Telegram "degraded"

### 5. Monitor erkennt kaputten Selektor
- [ ] CHECKS in monitor.js Signal temporär ändern auf falschen String
- [ ] Nächster Monitor-Lauf → `[MONITOR] X DEGRADED: Selektor "..." nicht gefunden`
- [ ] platform_status.healthy = 0 in DB prüfen
- [ ] Telegram-Alert empfangen

### 6. Railway Neustart verliert keine Daten
- [ ] Pool erstellen auf Railway URL
- [ ] Railway Service neustarten (Dashboard → Restart)
- [ ] Gleiche Pool-ID abfragen → Daten noch vorhanden ✓
- [ ] (SQLite liegt in Railway Persistent Volume — falls kein Volume: externe DB einrichten)

### 7. Admin Dashboard
- [ ] `ADMIN_SECRET` in .env setzen
- [ ] `/admin` aufrufen → Login-Maske
- [ ] Secret eingeben → Stats erscheinen
- [ ] Manuellen Trigger klicken → Pool-Status ändert sich

### 8. Pool-Queue Test
- [ ] 3 Pools gleichzeitig auf Ziel setzen (3x curl /pool/:id/join)
- [ ] Log zeigt: `[QUEUE] Pool X eingereiht (Position 2)`
- [ ] Bots laufen sequenziell, nicht parallel

---

## NÄCHSTE SCHRITTE

1. **Railway SQLite Persistence** — Railway löscht `/tmp` bei Neustart; SQLite-Datei auf ein persistentes Volume legen oder auf PostgreSQL/PlanetScale migrieren
2. **Stripe Webhook auf Railway** — `STRIPE_WEBHOOK_SECRET` in Railway Env setzen, Webhook-URL `https://groupdonation-production.up.railway.app/webhook/stripe` in Stripe Dashboard eintragen
3. **TEST_MODE=false** — Echte Zahlungen aktivieren (nach Testplan oben)
4. **ADMIN_SECRET setzen** — Sicheres Secret in Railway Env
5. **Telegram konfigurieren** — Bot erstellen via @BotFather, Chat-ID ermitteln
6. **StreamElements OAuth** — Login-Flow für vollständige SE-Automation
