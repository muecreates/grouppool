require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

// Screenshots go to /data/screenshots/ (Railway volume) so they survive deploys
// and are downloadable via `railway volume files download`.
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/data/screenshots';
try { fs.mkdirSync(SHOT_DIR, { recursive: true }); } catch {}
function shot(name) { return `${SHOT_DIR}/${name}`; }

const BOT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Kartendaten aus .env, Fallback auf Stripe-Testkarte
const CARD = {
  number:    process.env.CARD_NUMBER    || '4242424242424242',
  expiry:    process.env.CARD_EXPIRY    || '12/26',
  cvv:       process.env.CARD_CVV       || '123',
  firstName: process.env.CARD_FIRSTNAME || 'Group',
  lastName:  process.env.CARD_LASTNAME  || 'Pool',
  address:   process.env.CARD_ADDRESS   || 'Musterstraße 1',
  plz:       process.env.CARD_PLZ       || '50667',
  city:      process.env.CARD_CITY      || 'Köln',
  email:     process.env.CARD_EMAIL     || 'pool@grouppool.de',
};

// TEST_MODE=true → kein Submit; TEST_MODE=false → echter Submit
const TEST_MODE = process.env.TEST_MODE !== 'false';

// ── AUFGABE 2: CAPTCHA-Detection + 2captcha-Lösung ───────────────────────────

async function solveCaptchaWith2captcha(page) {
  const apiKey = process.env.TWOCAPTCHA_KEY;
  if (!apiKey) throw new Error('CAPTCHA_REQUIRED'); // kein Key → eskalieren

  // Sitekey aus DOM extrahieren
  const sitekey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey], .g-recaptcha');
    if (el?.dataset?.sitekey) return el.dataset.sitekey;
    for (const s of document.querySelectorAll('script')) {
      const m = s.textContent.match(/['"](6L[A-Za-z0-9_-]{38})['"]/);
      if (m) return m[1];
    }
    return null;
  });

  if (!sitekey) {
    console.log('[CAPTCHA] Sitekey nicht gefunden – eskaliere');
    throw new Error('CAPTCHA_REQUIRED');
  }

  console.log(`[CAPTCHA] Sitekey: ${sitekey} | Sende an 2captcha...`);
  const { Solver } = require('2captcha');
  const solver = new Solver(apiKey);

  const result = await solver.recaptcha(sitekey, page.url());
  console.log('[CAPTCHA] Gelöst via 2captcha ✓');

  // Token in g-recaptcha-response injizieren und Callback feuern
  await page.evaluate((token) => {
    const ta = document.getElementById('g-recaptcha-response')
      || document.querySelector('textarea[name="g-recaptcha-response"]');
    if (ta) { ta.style.display = 'block'; ta.value = token; }
    // Invisible reCAPTCHA: Callback aufrufen
    if (typeof window.___grecaptcha_cfg === 'object') {
      try {
        const clients = window.___grecaptcha_cfg.clients || {};
        for (const k of Object.keys(clients)) {
          const cb = clients[k]?.['']?.['callback'];
          if (typeof cb === 'function') { cb(token); break; }
        }
      } catch {}
    }
  }, result.data);

  return result.data;
}

async function checkCaptcha(page) {
  const url = page.url();

  if (url.includes('challenges.cloudflare.com')) {
    console.log(`[CAPTCHA] Cloudflare-Challenge auf ${url}`);
    throw new Error('CAPTCHA_REQUIRED');
  }

  for (const frame of page.frames()) {
    const fu = frame.url();
    if (fu.includes('recaptcha/api2/anchor') || fu.includes('recaptcha/enterprise/anchor')) {
      try {
        const visible = await frame.evaluate(() => {
          const el = document.querySelector('.recaptcha-checkbox') || document.body;
          return el.getBoundingClientRect().width > 0;
        });
        if (visible) {
          console.log(`[CAPTCHA] Sichtbares reCAPTCHA auf ${url} – versuche 2captcha...`);
          await solveCaptchaWith2captcha(page);
          return; // erfolgreich gelöst
        }
      } catch (e) {
        if (e.message === 'CAPTCHA_REQUIRED') throw e;
      }
    }
    if (fu.includes('hcaptcha.com/captcha')) {
      console.log(`[CAPTCHA] hCaptcha auf ${url}`);
      throw new Error('CAPTCHA_REQUIRED');
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function dismissCookies(page) {
  const btn = page.locator(
    '#onetrust-accept-btn-handler, button:has-text("Alle akzeptieren"), button:has-text("Accept All"), button:has-text("Accept")'
  ).first();
  if (await btn.isVisible({ timeout: 4_000 }).catch(() => false)) {
    await btn.click();
    console.log('[BOT] Cookies akzeptiert.');
  }
}

async function fillIfVisible(page, selector, value, label) {
  const el = page.locator(selector).first();
  if (await el.isVisible({ timeout: 4_000 }).catch(() => false)) {
    await el.fill(value);
    console.log(`[BOT] ${label} → "${value}" ✓`);
    return true;
  }
  console.log(`[BOT] ${label} – nicht sichtbar`);
  return false;
}

async function clickSubmit(page, selector, label) {
  if (TEST_MODE) {
    console.log(`[BOT] TEST_MODE=true – kein Submit (${label})`);
    return false;
  }
  const btn = page.locator(selector).first();
  if (await btn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    console.log(`[BOT] Submit: "${label}" ✓`);
    await btn.click();
    return true;
  }
  console.log(`[BOT] Submit-Button "${label}" nicht gefunden`);
  return false;
}

// ── Shared: PayPal classic checkout card form (popup flow) ───────────────────

async function fillPayPalCardForm(page) {
  await page.waitForSelector('input[name="card_number"]', { timeout: 15_000 });
  await page.waitForTimeout(1000);

  const countryInput = page.locator('input[name="combo_t_country"]').first();
  if (await countryInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const current = await countryInput.inputValue().catch(() => '');
    if (!current.toLowerCase().includes('germany') && !current.toLowerCase().includes('deutschland')) {
      await countryInput.triple_click?.().catch(() => countryInput.click());
      await countryInput.fill('Germany');
      const suggestion = page.locator('[role="option"]:has-text("Germany"), li:has-text("Germany")').first();
      if (await suggestion.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await suggestion.click();
      } else {
        await page.keyboard.press('Enter');
      }
      console.log('[BOT] Country → Germany ✓');
      await page.waitForTimeout(3_000);
      await page.waitForSelector('input[name="card_number"]', { timeout: 10_000 });
      await page.waitForTimeout(800);
    } else {
      console.log(`[BOT] Country bereits: "${current}" ✓`);
    }
  }

  const phone = process.env.CARD_PHONE || '01512345678';
  const fields = [
    ['input[name="card_number"]',       CARD.number,    'card_number'],
    ['input[name="card_expiration"]',   CARD.expiry,    'card_expiration'],
    ['input[name="card_cvv"]',          CARD.cvv,       'card_cvv'],
    ['input[name="firstName"]',         CARD.firstName, 'firstName'],
    ['input[name="lastName"]',          CARD.lastName,  'lastName'],
    ['input[name="addressLine1"]',      CARD.address,   'addressLine1'],
    ['input[name="postalCode"]',        CARD.plz,       'postalCode'],
    ['input[name="adminArea2"]',        CARD.city,      'adminArea2'],
    ['input[name="email"]',             CARD.email,     'email'],
    ['input[name="phoneInput-phone"]',  phone,          'phone'],
    ['input[name="phoneInput-mobile"]', phone,          'mobile'],
  ];
  for (const [sel, val, label] of fields) await fillIfVisible(page, sel, val, label);

  const saveBox = page.locator('input[name="isSignupOpted"]').first();
  if (await saveBox.isVisible({ timeout: 1_000 }).catch(() => false)) {
    if (await saveBox.isChecked().catch(() => false)) {
      await saveBox.uncheck();
      console.log('[BOT] Save-Checkbox deaktiviert ✓');
    }
  }
}

// ── PayPal smart card-fields (inline iframe-per-field component) ──────────────
// PayPal renders number/expiry/cvv each in their own sub-iframe under
// paypal.com/smart/card-fields. There is no input[name="card_number"] —
// each frame has a single bare <input>. We type into them via keyboard.

async function typeIntoFrame(frames, urlFragment, value, label) {
  const frame = frames.find(f => (f.url?.() ?? '').includes(urlFragment));
  if (!frame) { console.log(`[BOT] Frame für ${label} nicht gefunden`); return; }
  try {
    const input = frame.locator('input').first();
    await input.waitFor({ state: 'visible', timeout: 8_000 });
    await input.click();
    await input.fill('');
    await frame.keyboard.type(value, { delay: 80 });
    console.log(`[BOT] ${label} → "${value}" ✓`);
  } catch (e) {
    console.log(`[BOT] ${label} Fehler: ${e.message}`);
  }
}

async function fillPayPalCardFields(cardFieldsFrame) {
  await cardFieldsFrame.waitForTimeout(3000);

  // Exact field names from PayPal's card-fields iframe (confirmed via diagnostic run):
  // cardnumber, expiry-date, credit-card-security, givenName, familyName,
  // line1, city, postcode, phone, email
  const typeIn = async (name, value, label) => {
    const loc = cardFieldsFrame.locator(`input[name="${name}"]`).first();
    if (!await loc.isVisible({ timeout: 3_000 }).catch(() => false)) {
      console.log(`[BOT] ${label} – nicht sichtbar`); return;
    }
    await loc.click();
    await loc.fill('');
    await loc.type(value, { delay: 60 }); // loc.type dispatches keydown/keyup per char
    console.log(`[BOT] ${label} → "${value}" ✓`);
  };

  const phone = process.env.CARD_PHONE || '01512345678';
  await typeIn('cardnumber',            CARD.number,                    'card_number');
  await typeIn('expiry-date',           CARD.expiry,                    'card_expiry');
  await typeIn('credit-card-security',  CARD.cvv,                       'card_cvv');
  await typeIn('givenName',             CARD.firstName,                 'firstName');
  await typeIn('familyName',            CARD.lastName,                  'lastName');
  await typeIn('line1',                 CARD.address,                   'address');
  await typeIn('city',                  CARD.city,                      'city');
  await typeIn('postcode',              CARD.plz,                       'postcode');
  // State — PayPal renders this as a <select> dropdown, not a text input
  const stateVal = process.env.CARD_STATE || '';
  if (stateVal) {
    const stateSel = cardFieldsFrame.locator('select[name="state"], select[id*="state"], select[id*="region"]').first();
    if (await stateSel.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await stateSel.selectOption({ value: stateVal }).catch(() =>
        stateSel.selectOption({ label: stateVal }).catch(() => {})
      );
      console.log(`[BOT] state (select) → "${stateVal}" ✓`);
    } else {
      // Fallback: try as text input (some locales render it differently)
      await typeIn('state', stateVal, 'state');
    }
  }
  await typeIn('phone',                 phone,                          'phone');
  await typeIn('email',                 CARD.email,                     'email');

  // Keep "Ship to billing address" CHECKED — unchecking it expands a separate
  // shipping form with additional required fields that the bot doesn't fill.
  const shipBox = cardFieldsFrame.locator('input[name="shipToBillingAddress"]').first();
  if (await shipBox.isVisible({ timeout: 1_000 }).catch(() => false) &&
      !await shipBox.isChecked().catch(() => true)) {
    const shipLabel = cardFieldsFrame.locator('label:has(input[name="shipToBillingAddress"]), label[for="shipToBillingAddress"]').first();
    if (await shipLabel.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await shipLabel.click();
    } else {
      await shipBox.evaluate(el => el.click());
    }
    console.log('[BOT] shipToBillingAddress aktiviert ✓');
  }
}

// ── TipeeeStream ──────────────────────────────────────────────────────────────

async function flowTipeeeStream(page, context, { amount, message, groupName }) {
  console.log('\n[BOT] ── STEP 1: TipeeeStream Formular ──');
  await dismissCookies(page);
  await checkCaptcha(page);

  await fillIfVisible(page, 'input[name="pseudo"]',  groupName,         'pseudo');
  await fillIfVisible(page, 'input[name="amount"]',  amount.toString(), 'amount');
  await fillIfVisible(page, 'input[name="message"]', message,           'message');
  await fillIfVisible(page, 'input[name="email"]',   CARD.email,        'email');
  await page.locator('input[name="fees"]').check().catch(() => {});

  await page.locator('.cart-streamer-payment img').click();
  console.log('[BOT] PayPal-Button geklickt...');

  console.log('\n[BOT] ── STEP 2: PayPal ──');
  // PayPal öffnet manchmal als Popup (neues Tab), manchmal als Redirect
  let paypalPage = page;
  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: 10_000 }).catch(() => null),
    page.waitForURL(/paypal\.com/, { timeout: 10_000 }).catch(() => null),
  ]);
  if (popup) {
    paypalPage = popup;
    await paypalPage.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    console.log('[BOT] PayPal Popup geladen:', paypalPage.url());
  } else if (page.url().includes('paypal.com')) {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    console.log('[BOT] PayPal Redirect geladen:', page.url());
  } else {
    throw new Error('PayPal nicht erreichbar nach Klick');
  }
  await paypalPage.waitForTimeout(1500);
  await checkCaptcha(paypalPage);

  const cardBtn = paypalPage.locator('button:has-text("Debit"), button:has-text("Kredit"), button:has-text("Credit")').first();
  await cardBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await cardBtn.click();

  console.log('\n[BOT] ── STEP 3: Kreditkartenformular ──');
  await fillPayPalCardForm(paypalPage);
  await checkCaptcha(paypalPage);

  // echter Submit wenn TEST_MODE=false (paypalPage = popup oder main page)
  await clickSubmit(paypalPage, 'button:has-text("Zustimmen und weiter"), button:has-text("Agree and Continue")', 'Zustimmen und weiter');
}

// ── Streamlabs ────────────────────────────────────────────────────────────────

async function flowStreamlabs(page, context, { amount, message, groupName }) {
  console.log('\n[BOT] ── Streamlabs Formular ──');
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await dismissCookies(page);
  await checkCaptcha(page);

  await fillIfVisible(page, 'input[name="username"]',   groupName,         'username');
  await fillIfVisible(page, 'input[name="tip amount"]', amount.toString(), 'tip amount');
  await fillIfVisible(page, 'textarea[name="message"]', message,           'message');

  await page.screenshot({ path: shot('streamlabs-filled.png'), fullPage: true });

  const donateBtn = page.locator('button:has-text("Donate"), button:has-text("Tip"), button.button--action').first();
  if (!await donateBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
    console.log('[BOT] Streamlabs: Donate-Button nicht gefunden — Abbruch');
    throw new Error('Streamlabs Donate-Button nicht gefunden');
  }

  console.log('[BOT] Donate-Button gefunden — klicke...');

  // ── STEP 2: click Donate, listen for popup simultaneously ────────────────
  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: 10_000 }).catch(() => null),
    donateBtn.click(),
  ]);

  await page.waitForTimeout(3000);
  await checkCaptcha(page);
  await page.screenshot({ path: shot('streamlabs-after-donate.png'), fullPage: true });

  // ── STEP 3: hand off to shared PayPal card flow ──────────────────────────
  let ppCtx = page;
  if (popup) {
    await popup.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    console.log('[BOT] PayPal Popup geladen:', popup.url());
    await checkCaptcha(popup);
    ppCtx = popup;
  } else {
    console.log('[BOT] Kein Popup — suche PayPal-Modal auf Hauptseite...');
  }

  await handlePayPalCardPayment(context, ppCtx, 'streamlabs');
}

// ── Shared: PayPal "Debit or Credit Card" flow ────────────────────────────────
// Used by both Streamlabs and StreamElements after a PayPal button is clicked.
// ppCtx: the Page/popup where PayPal rendered (main page or popup window).

async function handlePayPalCardPayment(context, ppCtx, label) {
  const CARD_BTN_SEL = [
    'button:has-text("Debit or Credit Card")',
    'button:has-text("Debit or credit card")',
    'button:has-text("Credit Card")',
    'button:has-text("Debit")',
    '[data-funding-source="card"]',
  ].join(', ');

  let cardBtn = null;
  for (const frame of [ppCtx, ...ppCtx.frames()]) {
    try {
      const loc = frame.locator(CARD_BTN_SEL).first();
      if (await loc.isVisible({ timeout: 3_000 }).catch(() => false)) {
        cardBtn = loc;
        console.log('[BOT] "Debit or Credit Card" Button gefunden');
        break;
      }
    } catch {}
  }

  if (!cardBtn) {
    await ppCtx.screenshot({ path: shot(`${label}-paypal-modal.png`), fullPage: true }).catch(() => {});
    throw new Error(`${label}: PayPal "Debit or Credit Card" Button nicht gefunden`);
  }

  const [cardPopup] = await Promise.all([
    context.waitForEvent('page', { timeout: 10_000 }).catch(() => null),
    cardBtn.click(),
  ]);

  let formCtx;
  if (cardPopup) {
    await cardPopup.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    console.log('[BOT] Karten-Popup geladen:', cardPopup.url());
    await checkCaptcha(cardPopup);
    formCtx = cardPopup;
  } else {
    await ppCtx.waitForTimeout(4000);
    console.log('[BOT] Suche Karten-Formular in Frames...');
    formCtx = ppCtx;
    for (const frame of [ppCtx, ...ppCtx.frames()]) {
      try {
        const hasCard = await frame.locator('input[name="cardnumber"], input[name="card_number"], input[id*="card"]').first()
          .isVisible({ timeout: 3_000 }).catch(() => false);
        if (hasCard) {
          console.log('[BOT] Karten-Formular gefunden in Frame:', frame.url?.() ?? 'main');
          formCtx = frame;
          break;
        }
      } catch {}
    }
  }

  console.log(`\n[BOT] ── Kreditkartenformular (${label}/PayPal) ──`);
  await ppCtx.screenshot({ path: shot(`${label}-card-form.png`), fullPage: true }).catch(() => {});

  if (cardPopup) {
    await fillPayPalCardForm(formCtx);
  } else {
    await fillPayPalCardFields(formCtx);
  }

  await checkCaptcha(ppCtx);

  const SUBMIT_SEL = 'button:has-text("Pay Now"), button:has-text("Pay"), button:has-text("Confirm"), button:has-text("Agree and Continue"), button:has-text("Zustimmen und weiter"), button:has-text("Continue")';
  let submitted = await clickSubmit(formCtx, SUBMIT_SEL, 'PayPal Karten-Submit');
  if (!submitted) submitted = await clickSubmit(ppCtx, SUBMIT_SEL, 'PayPal Karten-Submit (Hauptseite)');
  if (submitted) await capturePayPalResult(ppCtx, label);
}

async function capturePayPalResult(ppCtx, label) {
  console.log('[BOT] Warte 10s auf PayPal-Antwort...');
  await ppCtx.waitForTimeout(10_000);
  const resultUrl = ppCtx.url();
  console.log(`[BOT] Ergebnis-URL: ${resultUrl}`);
  const resultShot = shot(`${label}-result-${Date.now()}.png`);
  await ppCtx.screenshot({ path: resultShot, fullPage: true }).catch(() => {});
  console.log(`[BOT] Ergebnis-Screenshot: ${resultShot}`);
  const resultText = await ppCtx.evaluate(() => document.body?.innerText?.slice(0, 500)).catch(() => '');
  console.log(`[BOT] Seiten-Inhalt: ${resultText.replace(/\n+/g, ' ').trim()}`);
}

// ── StreamElements ────────────────────────────────────────────────────────────

async function flowStreamElements(page, context, { amount, message, groupName }) {
  console.log('\n[BOT] ── StreamElements Formular ──');
  await page.waitForLoadState('networkidle', { timeout: 20_000 });
  await page.waitForTimeout(3000);
  await checkCaptcha(page);

  // ESC schließt Login-Modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  console.log('[BOT] ESC gedrückt – Modal sollte geschlossen sein');

  // ── Betrag: custom input oder Preset-Radio ────────────────────────────────
  const amountInput = page.locator('input[name="amount"], input[type="number"]').first();
  if (await amountInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await amountInput.fill(amount.toString());
    console.log(`[BOT] amount → "${amount}" ✓`);
  } else {
    const otherRadio = page.locator('label:has-text("OTHER"), label:has-text("Other")').first();
    if (await otherRadio.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await otherRadio.click();
      console.log('[BOT] "OTHER" Preset geklickt');
      await fillIfVisible(page, 'input[type="number"], input[name="amount"]', amount.toString(), 'custom amount');
    } else {
      const firstPreset = page.locator('input[name="preset"]').first();
      if (await firstPreset.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await firstPreset.click();
        console.log('[BOT] Erstes Preset-Radio geklickt');
      }
    }
  }

  await fillIfVisible(page, 'textarea[name="message"]',    message,   'message');
  await fillIfVisible(page, 'input[name="tipperUsername"]', groupName, 'tipperUsername');

  await page.screenshot({ path: shot('se-filled.png'), fullPage: true });

  if (TEST_MODE) {
    console.log('[BOT] TEST_MODE=true – kein Payment-Klick');
    await page.screenshot({ path: shot('se-payment.png'), fullPage: true });
    console.log(`[BOT] Screenshot: ${shot('se-payment.png')}`);
    return;
  }

  // ── PayPal-Button im rechten Panel anklicken ──────────────────────────────
  // SE zeigt den PayPal-Button direkt im rechten Panel via PayPal SDK iframe.
  console.log('[BOT] Suche PayPal-Button im rechten Panel...');
  await page.waitForTimeout(5000); // PayPal Smart Buttons brauchen Zeit zum Laden

  // SE PayPal button has data-tipping-option-name="paypalV2" (confirmed from DOM scan)
  const paypalBtn = page.locator('[data-tipping-option-name="paypalV2"]').first();
  if (!await paypalBtn.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await page.screenshot({ path: shot('se-no-paypal-btn.png'), fullPage: true }).catch(() => {});
    throw new Error('StreamElements: PayPal-Button [data-tipping-option-name="paypalV2"] nicht gefunden');
  }
  console.log('[BOT] SE PayPal-Button gefunden: [data-tipping-option-name="paypalV2"]');

  // PayPal öffnet als Popup oder Inline-Modal
  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: 12_000 }).catch(() => null),
    paypalBtn.click(),
  ]);

  let ppCtx = page;
  if (popup) {
    await popup.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    console.log('[BOT] SE PayPal Popup geladen:', popup.url());
    await checkCaptcha(popup);
    ppCtx = popup;
  } else {
    await page.waitForTimeout(3000);
    console.log('[BOT] Kein Popup — PayPal-Modal auf Hauptseite...');
  }

  await handlePayPalCardPayment(context, ppCtx, 'streamelements');
}

// ── Main ──────────────────────────────────────────────────────────────────────

const STEP_TIMEOUT = 30_000; // 30s pro Step

async function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`Timeout nach ${ms / 1000}s: ${label}`)), ms)
  );
  return Promise.race([promise, timeout]);
}

async function runBotDonation(streamer, amount, message, groupName, donationUrl, onLog = async () => {}) {
  console.log(`[BOT] @${streamer} | €${amount} | TEST_MODE=${TEST_MODE} | ${donationUrl}`);
  await onLog('start', `Bot gestartet für @${streamer} €${amount}`);

  const platform =
    donationUrl.includes('streamlabs.com')     ? 'streamlabs'     :
    donationUrl.includes('streamelements.com') ? 'streamelements' :
                                                 'tipeeestream';
  console.log(`[BOT] Plattform: ${platform}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: BOT_UA });
  const page    = await context.newPage();

  try {
    await withTimeout(
      page.goto(donationUrl, { waitUntil: 'networkidle', timeout: STEP_TIMEOUT }),
      STEP_TIMEOUT, 'goto'
    );

    const opts = { amount, message, groupName };
    if      (platform === 'streamlabs')     await withTimeout(flowStreamlabs(page, context, opts),     STEP_TIMEOUT * 4, 'flowStreamlabs');
    else if (platform === 'streamelements') await withTimeout(flowStreamElements(page, context, opts),  STEP_TIMEOUT * 5, 'flowStreamElements');
    else                                    await withTimeout(flowTipeeeStream(page, context, opts),    STEP_TIMEOUT * 4, 'flowTipeeeStream');

    const shotPath = shot(`grouppool_${platform}_${Date.now()}.png`);
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    console.log(`[BOT] Screenshot: ${shotPath}`);
    await onLog('success', `Abgeschlossen auf ${platform}`);

    if (TEST_MODE) await page.waitForTimeout(3_000);

  } catch (err) {
    if (err.message === 'CAPTCHA_REQUIRED') throw err;
    console.error('[BOT] Fehler:', err.message);
    await page.screenshot({ path: shot(`grouppool_error_${Date.now()}.png`), fullPage: true }).catch(() => {});
    await onLog('error', err.message.slice(0, 500));
  } finally {
    await browser.close();
    console.log('[BOT] Browser geschlossen.');
  }
}

module.exports = { runBotDonation };
