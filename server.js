const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const blocked = new Set(['/server.js', '/config.json', '/package.json', '/package-lock.json', '/server-fixed.js']);
  if (blocked.has(req.path)) return res.status(404).send('Not found');
  next();
});
app.use(express.static(path.join(__dirname)));

const CONFIG_FILE = path.join(__dirname, 'config.json');
const PROFILE_DIR = path.join(__dirname, 'chrome-profile');
const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const SESSION_FILE = path.join(__dirname, 'session.json');

let config = { email: '', senha: process.env.OUTLOOK_SENHA || '' };
try { if (fs.existsSync(CONFIG_FILE)) { const s = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); config.email = s.email || config.email; config.senha = s.senha || config.senha; } } catch (e) {}
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '';
let currentStatus = { code: 'idle', message: 'Aguardando busca.', detail: '', updatedAt: new Date().toISOString() };
let sessionState = { loggedIn: false, lastLogin: null, cookieCount: 0 };
try { if (fs.existsSync(SESSION_FILE)) sessionState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch (e) {}
function saveSession() { try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionState, null, 2)); } catch (e) {} }
function setStatus(code, message, detail) {
  currentStatus = { code, message, detail: detail ? String(detail).slice(0, 900) : '', updatedAt: new Date().toISOString() };
  console.log('[status]', code, '-', message);
}
function keepAlive() { if (!APP_URL) return; setInterval(() => { https.get(APP_URL + '/api/ping', () => {}).on('error', () => {}); }, 4 * 60 * 1000); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SERVICE_PATTERNS = {
  netflix_login: { type: 'code', label: 'Codigo de Login' },
  netflix_reset: { type: 'link', label: 'Redefinir Senha' },
  netflix_verify: { type: 'code', label: 'Verificacao' },
  netflix_temp: { type: 'link', label: 'Codigo Temporario' },
  netflix_house: { type: 'link', label: 'Atualizar Residencia' }
};

function findChrome() {
  const paths = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',(process.env.LOCALAPPDATA||'')+'\\Google\\Chrome\\Application\\chrome.exe','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',process.env.CHROME_PATH].filter(Boolean);
  for (const p of paths) { if (fs.existsSync(p)) return p; }
  return null;
}
function isServer() { return !!process.env.RENDER || !!process.env.RAILWAY_ENVIRONMENT || !!process.env.IS_SERVER; }

async function launchBrowser() {
  const chromePath = findChrome();
  const headless = isServer();
  const opts = {
    headless: headless ? 'new' : false,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--start-maximized'],
    defaultViewport: headless ? { width: 1920, height: 1080 } : null,
    userDataDir: PROFILE_DIR
  };
  if (chromePath && !isServer()) opts.executablePath = chromePath;
  return puppeteer.launch(opts);
}

async function isInboxReady(page) {
  try {
    if (!/outlook\.(live|office)\.com\/mail/i.test(page.url())) return false;
    return await page.evaluate(() => {
      const t = (document.body.innerText || '').toLowerCase();
      if (/cdnerror|bootresult|something went wrong/i.test(t)) return false;
      return /caixa de entrada|inbox|novo email|new mail|focused|conversations|filter/i.test(t);
    });
  } catch { return false; }
}

async function saveCookies(page) {
  try {
    const cookies = await page.browser().cookies();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    sessionState = { loggedIn: true, lastLogin: new Date().toISOString(), cookieCount: cookies.length };
    saveSession();
  } catch (e) {}
}
async function loadCookies(page) {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      if (cookies.length > 0) { await page.setCookie(...cookies); return true; }
    }
  } catch (e) {}
  return false;
}

async function loginOutlook(browser, email, senha) {
  setStatus('opening_outlook', 'Verificando sessao...');
  const page = await browser.newPage();
  await page.setBypassCSP(true);
  await loadCookies(page);
  await page.goto('https://outlook.live.com/mail/', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(5000);
  if (await isInboxReady(page)) { console.log('[Login] JA LOGADO!'); return page; }

  console.log('[Login] Fazendo login...');
  await page.goto('https://login.live.com/login.srf', { waitUntil: 'networkidle2', timeout: 120000 });
  await sleep(3000);
  setStatus('email_step', 'Preenchendo e-mail...');
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  const ei = await page.$('input[type="email"]');
  await ei.click({ clickCount: 3 }); await ei.type(email, { delay: 80 });
  await sleep(500); await page.keyboard.press('Enter'); await sleep(6000);
  setStatus('password_step', 'Preenchendo senha...');
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  const pi = await page.$('input[type="password"]');
  await pi.click({ clickCount: 3 }); await pi.type(senha, { delay: 80 });
  await sleep(500); await page.keyboard.press('Enter'); await sleep(6000);
  try { await page.keyboard.press('Enter'); await sleep(3000); } catch(e) {}

  console.log('[Login] ABRINDO NOVA GUIA...');
  const newPage = await browser.newPage();
  await newPage.setBypassCSP(true);
  await newPage.goto('https://outlook.live.com/mail/', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(8000);
  let ready = await isInboxReady(newPage);
  for (let i = 0; i < 3 && !ready; i++) { await newPage.reload({ waitUntil: 'networkidle2', timeout: 30000 }); await sleep(6000); ready = await isInboxReady(newPage); }
  if (ready) { await saveCookies(newPage); return newPage; }
  await newPage.screenshot({ path: path.join(__dirname, 'debug-fim.png'), fullPage: true });
  throw new Error('Inbox nao carregou.');
}

async function findNetflixResult(page, svc) {
  setStatus('searching', 'Procurando emails Netflix...');
  await sleep(3000);

  // CLICA OUTROS
  console.log('[Busca] Clicando Outros...');
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, span, div[role="button"], a'));
    for (const el of els) {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (t === 'outros' || t === 'other') { el.click(); return; }
    }
  });
  await sleep(4000);

  // CLICA PRIMEIRO EMAIL
  console.log('[Busca] Clicando primeiro email...');
  await page.evaluate(() => {
    const sels = ['div[data-convid]', '[role="option"]', '[role="listitem"]', 'div[data-testid="message-item"]', '.eeumf'];
    for (const sel of sels) { const items = document.querySelectorAll(sel); if (items.length > 0) { items[0].click(); return; } }
  });
  await sleep(5000);

  // ===== EXTRAI CODIGO (NUMERO) =====
  if (svc.type === 'code') {
    console.log('[Busca] Procurando codigo no painel de leitura...');
    
    const codigo = await page.evaluate(() => {
      // Pega APENAS o conteudo do painel de leitura do email
      let texto = '';
      
      // Tenta seletores do corpo do email no Outlook
      const painelSelectors = [
        '[aria-label*="Corpo da mensagem" i]',
        '[aria-label*="Message body" i]',
        '[role="document"]',
        'div[class*="readingPane" i]',
        'div[class*="message-body" i]',
        'div[class*="email-body" i]',
        'div[data-app-section="ReadingPane"]',
        '#readingPaneContainer'
      ];
      
      for (const sel of painelSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length > 5) {
          texto = el.innerText;
          break;
        }
      }
      
      // Fallback: procura iframes (onde o email renderiza)
      if (!texto) {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            if (doc && doc.body && doc.body.innerText.trim().length > 5) {
              texto = doc.body.innerText;
              break;
            }
          } catch(e) {}
        }
      }
      
      if (!texto) return null;
      
      console.log('[Browser] Texto do email:', texto.slice(0, 300));
      
      // Prioridade 1: numero perto de "codigo/entrar/informe"
      let m = texto.match(/(?:codigo|code|informe|digite|entrar|enter|acima|c.digo).{0,80}?(\d{4})(?!\d)/i);
      if (!m) m = texto.match(/(?:codigo|code|informe|digite|entrar|enter|acima|c.digo).{0,80}?(\d{6})(?!\d)/i);
      
      // Prioridade 2: numero perto de Netflix
      if (!m) m = texto.match(/(?:netflix).{0,100}?(\d{4})(?!\d)/i);
      if (!m) m = texto.match(/(?:netflix).{0,100}?(\d{6})(?!\d)/i);
      
      // Prioridade 3: qualquer 4 digitos que NAO seja ano (20xx)
      if (!m) {
        const regex = /\b(\d{4})\b/g;
        let match;
        while ((match = regex.exec(texto)) !== null) {
          const num = match[1];
          if (!num.startsWith('20') && !num.startsWith('19')) {
            m = match;
            break;
          }
        }
      }
      
      // Prioridade 4: 6 digitos
      if (!m) m = texto.match(/\b(\d{6})\b/);
      
      return m ? m[1] : null;
    });
    
    if (codigo) {
      console.log('[Busca] CODIGO:', codigo);
      setStatus('found', 'Codigo: ' + codigo);
      return { type: 'code', value: codigo, label: svc.label };
    }
    console.log('[Busca] Nenhum codigo encontrado no painel.');
  }

  // ===== EXTRAI LINK =====
  if (svc.type === 'link') {
    console.log('[Busca] Procurando link...');
    const link = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a')) {
        if ((a.href || '').toLowerCase().includes('netflix.com')) return a.href;
      }
      return null;
    });
    if (link) {
      console.log('[Busca] LINK:', link);
      setStatus('found', 'Link encontrado!');
      return { type: 'link', value: link, label: svc.label };
    }
    console.log('[Busca] Nenhum link encontrado.');
  }

  return null;
}

// ROTAS
app.post('/api/logout', (req, res) => {
  try {
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    if (fs.existsSync(PROFILE_DIR)) { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); fs.mkdirSync(PROFILE_DIR, { recursive: true }); }
    sessionState = { loggedIn: false, lastLogin: null, cookieCount: 0 };
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/session', (req, res) => res.json(sessionState));
app.get('/api/ping', (req, res) => res.json({ ok: true }));
app.get('/api/status', (req, res) => res.json(currentStatus));
app.post('/api/status/reset', (req, res) => { setStatus('idle', 'Aguardando busca.'); res.json(currentStatus); });
app.get('/api/config', (req, res) => res.json({ email: config.email || '' }));
app.post('/api/config', (req, res) => {
  const { email, senha } = req.body || {};
  if (email) config.email = email.trim();
  if (senha) config.senha = senha.trim();
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) {}
  res.json({ ok: true });
});
app.post('/api/search', async (req, res) => {
  const { service } = req.body || {};
  const svc = SERVICE_PATTERNS[service];
  if (!svc) return res.status(400).json({ error: 'Servico invalido.' });
  if (!config.email || !config.senha) return res.status(400).json({ error: 'Configure e-mail e senha primeiro.' });
  let browser;
  try {
    setStatus('starting', 'Iniciando navegador...');
    browser = await launchBrowser();
    const inboxPage = await loginOutlook(browser, config.email, config.senha);
    const result = await findNetflixResult(inboxPage, svc);
    if (result) return res.json({ found: true, result: result.value, type: result.type, service: result.label, code: 'found', status: currentStatus });
    return res.json({ error: 'Nenhum resultado encontrado.', code: 'not_found', status: currentStatus });
  } catch (e) {
    setStatus('error', e.message);
    return res.json({ error: e.message, code: 'error', status: currentStatus });
  } finally { if (browser) { try { await browser.close(); } catch (_) {} } }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('BKLOGINS v15 | Porta:', PORT, '|', isServer() ? 'SERVIDOR' : 'LOCAL');
  console.log('Email:', config.email || '(nao configurado)');
  keepAlive();
});
