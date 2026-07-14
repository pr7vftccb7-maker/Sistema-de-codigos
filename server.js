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

// ============ SERVICE PATTERNS ============
const SERVICE_PATTERNS = {
  netflix_login: {
    type: 'code', label: 'Codigo de Login',
    subjectKeywords: /login|entrar|sign.?in|acesso|autentic/i,
    bodyKeywords: /login|entrar|sign.?in|faça.?login|conecte.?se/i,
    blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i,
    blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i
  },
  netflix_reset: {
    type: 'link', label: 'Redefinir Senha',
    subjectKeywords: /redefinir|reset|senha|password|alterar.*senha|change.*password/i,
    bodyKeywords: /redefinir.*senha|reset.*password|nova.*senha|new.*password|clique.*(botão|button|aqui|link).*(redefinir|alterar|reset)/i,
    blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i,
    blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i
  },
  netflix_verify: {
    type: 'code', label: 'Verificacao',
    subjectKeywords: /verific|verif|código|code|confirme|confirm/i,
    bodyKeywords: /código.*verificação|verification.*code|confirme.*código|confirm.*code|segurança|security/i,
    blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i,
    blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i
  },
  netflix_temp: {
    type: 'link', label: 'Codigo Temporario',
    subjectKeywords: /temporári|temporary|acesso.*temp|temp.*access|código.*tempor/i,
    bodyKeywords: /temporári|temporary|código.*login|sign.?in.*code|acesse.*agora|login.*now/i,
    blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i,
    blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i
  },
  netflix_house: {
    type: 'link', label: 'Atualizar Residencia',
    subjectKeywords: /residência|residence|household|domicílio|atualizar.*(residência|local|casa)|update.*(home|household|address)/i,
    bodyKeywords: /residência|residence|household|domicílio|moradia|atualizar.*(local|endereço|residência)/i,
    blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i,
    blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i
  }
};

const BLOCKED_EMAIL_PATTERNS = [
  /confirme a alteração da sua conta/i,
  /confirm.*(change|update).*(your|da sua).*(account|conta)/i,
  /change.*your.*email/i,
  /update.*your.*email.*address/i,
  /altere.*seu.*email/i,
  /mudar.*(seu|o).*email/i,
  /alteração.*(de|da).*email/i,
  /novo.*email.*(cadastrado|adicionado)/i,
  /email.*(alterado|atualizado|modificado).*com.*sucesso/i,
  /verify.*your.*new.*email/i,
  /confirme.*novo.*email/i
];

function isServer() { return !!process.env.RENDER || !!process.env.RAILWAY_ENVIRONMENT || !!process.env.IS_SERVER; }

function findChrome() {
  // Prioridade: variável de ambiente
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

 if (isServer()) return null;
  const paths = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',(process.env.LOCALAPPDATA||'')+'\\Google\\Chrome\\Application\\chrome.exe','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',process.env.CHROME_PATH].filter(Boolean);
  for (const p of paths) { if (fs.existsSync(p)) return p; }
  return null;
}

async function launchBrowser() {
  const chromePath = findChrome();
  const headless = isServer();
  const opts = {
    headless: "new",
    args: [
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-extensions","--disable-background-networking","--disable-sync","--no-first-run","--no-zygote","--single-process","--disable-features=TranslateUI","--disable-accelerated-2d-canvas"],
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
  await page.goto('https://outlook.live.com/mail/', { waitUntil: "load", timeout: 120000 });
  await sleep(5000);
  if (await isInboxReady(page)) { console.log('[Login] JA LOGADO!'); return page; }

  console.log('[Login] Fazendo login...');
  await page.goto('https://login.live.com/login.srf', { waitUntil: "load", timeout: 120000 });
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
  await newPage.goto('https://outlook.live.com/mail/', { waitUntil: "load", timeout: 120000 });
  await sleep(8000);
  let ready = await isInboxReady(newPage);
  for (let i = 0; i < 3 && !ready; i++) { await newPage.reload({ waitUntil: "load", timeout: 30000 }); await sleep(6000); ready = await isInboxReady(newPage); }
  if (ready) { await saveCookies(newPage); return newPage; }
  await newPage.screenshot({ path: path.join(__dirname, 'debug-fim.png'), fullPage: true });
  throw new Error('Inbox nao carregou.');
}

async function getEmailSubject(page) {
  return await page.evaluate(() => {
    const selectors = ['[aria-label*="Assunto" i]','[role="heading"]','h1','h2','h3','[class*="subject" i]','[data-testid="message-header-subject"]','.readingPaneSubject','[id*="subject" i]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 2) return el.innerText.trim();
    }
    return '';
  });
}

async function getEmailBody(page) {
  return await page.evaluate(() => {
    let texto = '';
    const painelSelectors = ['[aria-label*="Corpo da mensagem" i]','[aria-label*="Message body" i]','[role="document"]','div[class*="readingPane" i]','div[class*="message-body" i]','div[class*="email-body" i]','div[data-app-section="ReadingPane"]','#readingPaneContainer'];
    for (const sel of painelSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 5) { texto = el.innerText; break; }
    }
    if (!texto) {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow.document;
          if (doc && doc.body && doc.body.innerText.trim().length > 5) { texto = doc.body.innerText; break; }
        } catch(e) {}
      }
    }
    return texto;
  });
}

function isEmailBlocked(subject, body) {
  const combined = (subject + ' ' + body).toLowerCase();
  for (const pattern of BLOCKED_EMAIL_PATTERNS) {
    if (pattern.test(combined)) { console.log('[Bloqueio] Email bloqueado!'); return true; }
  }
  return false;
}

function emailMatchesService(subject, body, svc) {
  if (svc.blockedSubjects && svc.blockedSubjects.test(subject)) return false;
  if (svc.blockedBody && svc.blockedBody.test(body)) return false;
  const subjectMatch = svc.subjectKeywords.test(subject);
  const bodyMatch = svc.bodyKeywords.test(body);
  return subjectMatch || bodyMatch;
}

async function findCorrectEmail(page, svc) {
  console.log('[Busca] Clicando Outros...');
  const clickedOutros = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, span, div[role="button"], a'));
    for (const el of els) {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (t === 'outros' || t === 'other') { el.click(); return true; }
    }
    return false;
  });
  if (!clickedOutros) console.log('[Busca] Outros nao encontrado, tentando inbox normal...');
  await sleep(4000);

  const emailCount = await page.evaluate(() => {
    const sels = ['div[data-convid]','[role="option"]','[role="listitem"]','div[data-testid="message-item"]','.eeumf'];
    for (const sel of sels) { const items = document.querySelectorAll(sel); if (items.length > 0) return items.length; }
    return 0;
  });
  console.log('[Busca] Total de emails:', emailCount);
  if (emailCount === 0) return false;

  const MAX_EMAILS = Math.min(emailCount, 15);
  for (let i = 0; i < MAX_EMAILS; i++) {
    setStatus('scanning', 'Analisando email ' + (i + 1) + ' de ' + MAX_EMAILS + '...');
    const clicked = await page.evaluate((idx) => {
      const sels = ['div[data-convid]','[role="option"]','[role="listitem"]','div[data-testid="message-item"]','.eeumf'];
      for (const sel of sels) { const items = document.querySelectorAll(sel); if (items.length > idx) { items[idx].click(); return { ok: true, total: items.length }; } }
      return { ok: false, total: 0 };
    }, i);
    if (!clicked.ok) break;
    await sleep(4000);

    const subject = await getEmailSubject(page);
    if (!subject || subject.length < 3) continue;

    const body = await getEmailBody(page);
    console.log('[Busca] Subject:', subject.slice(0, 80), '| Body:', body.slice(0, 80));

    if (isEmailBlocked(subject, body)) { console.log('[Busca] BLOQUEADO, pulando...'); continue; }
    if (emailMatchesService(subject, body, svc)) { console.log('[Busca] ENCONTRADO na posicao', i); return true; }
  }
  return false;
}

async function extractLinksFromEmail(page) {
  return await page.evaluate(() => {
    const links = [];
    function getComputedStyleRed(el) {
      try {
        const style = window.getComputedStyle(el);
        const bg = style.backgroundColor;
        if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return null;
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return null;
        const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
        if (r > 150 && r > g * 1.5 && r > b * 1.5) return bg;
        return null;
      } catch(e) { return null; }
    }
    function collectLinks(doc, source) {
      for (const a of doc.querySelectorAll('a')) {
        const href = (a.href || '').trim();
        if (href && !href.startsWith('javascript:') && href !== '#' && !href.startsWith('mailto:'))
          links.push({ href, text: (a.innerText || a.textContent || '').trim().slice(0, 100), color: getComputedStyleRed(a), source });
      }
      for (const el of doc.querySelectorAll('button, [role="button"], div[onclick], td[onclick]')) {
        const onclick = el.getAttribute('onclick') || '';
        const urlMatch = onclick.match(/(?:location\.href|window\.open|window\.location)\s*=\s*['"]([^'"]+)['"]/);
        if (urlMatch) links.push({ href: urlMatch[1], text: (el.innerText || el.textContent || '').trim().slice(0, 100), color: getComputedStyleRed(el), source: source + '-onclick' });
      }
    }
    function collectRedButtons(doc, source) {
      for (const el of doc.querySelectorAll('a, td, div, span, button')) {
        const bg = getComputedStyleRed(el);
        if (bg) {
          const href = (el.href || '').trim();
          if (href && !href.startsWith('javascript:') && href !== '#' && !href.startsWith('mailto:') && !links.some(l => l.href === href))
            links.push({ href, text: (el.innerText || el.textContent || '').trim().slice(0, 100), color: bg, source: source + '-redbtn' });
        }
      }
    }
    collectLinks(document, 'main');
    collectRedButtons(document, 'main');
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (doc && doc.body) { collectLinks(doc, 'iframe'); collectRedButtons(doc, 'iframe'); }
      } catch(e) {}
    }
    return links;
  });
}

function pickNetflixLink(links) {
  if (!links || links.length === 0) return null;
  const redLinks = links.filter(l => l.color);
  if (redLinks.length > 0) {
    const redNetflix = redLinks.find(l => /netflix/i.test(l.href));
    return redNetflix ? redNetflix.href : redLinks[0].href;
  }
  const netflixLinks = links.filter(l => /netflix\.com/i.test(l.href));
  if (netflixLinks.length > 0) {
    const resetLink = netflixLinks.find(l => /reset|redefin|password|senha|update|atualizar|verify|confirm/i.test(l.href + l.text));
    return resetLink ? resetLink.href : netflixLinks[0].href;
  }
  const trackingLinks = links.filter(l => /netflix\.(email|mail|click|link)/i.test(l.href) || /email\.flix/i.test(l.href));
  if (trackingLinks.length > 0) return trackingLinks[0].href;
  const safelinks = links.filter(l => /safelinks\.protection\.outlook\.com/i.test(l.href) && /netflix/i.test(l.href));
  if (safelinks.length > 0) return safelinks[0].href;
  const textNetflix = links.find(l => /netflix/i.test(l.text));
  if (textNetflix) return textNetflix.href;
  const actionLinks = links.filter(l => /verify|confirm|reset|update|click|acessar|entrar|acesse|clique|redefinir|atualizar/i.test(l.text));
  if (actionLinks.length > 0) return actionLinks[0].href;
  return links[0].href;
}

async function clickRedButtonInEmail(page) {
  return await page.evaluate(() => {
    function isRed(el) {
      try {
        const bg = window.getComputedStyle(el).backgroundColor;
        if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return false;
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return false;
        const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
        return r > 150 && r > g * 1.5 && r > b * 1.5;
      } catch(e) { return false; }
    }
    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"], td, div, span'));
    for (const el of candidates) {
      if (isRed(el)) {
        const link = el.tagName === 'A' ? el : el.querySelector('a');
        if (link && link.href && !link.href.startsWith('javascript:')) return { clicked: true, href: link.href, where: 'main' };
        el.click();
        return { clicked: true, href: 'clicked-no-href', where: 'main-click' };
      }
    }
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (!doc || !doc.body) continue;
        for (const el of Array.from(doc.querySelectorAll('a, button, [role="button"], td, div, span'))) {
          if (isRed(el)) {
            const link = el.tagName === 'A' ? el : el.querySelector('a');
            if (link && link.href && !link.href.startsWith('javascript:')) { link.click(); return { clicked: true, href: link.href, where: 'iframe' }; }
            el.click();
            return { clicked: true, href: 'clicked-no-href', where: 'iframe-click' };
          }
        }
      } catch(e) {}
    }
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
    setStatus('clicking_button', 'Clicando no botao vermelho...');
    const urlBefore = page.url();
    const clickResult = await clickRedButtonInEmail(page);
    if (clickResult.clicked) {
      await sleep(3000);
      const pages = await page.browser().pages();
      const newPage = pages.find(p => p.url() !== urlBefore && p.url() !== 'about:blank');
      if (newPage) { const newUrl = newPage.url(); try { await newPage.close(); } catch(e) {} if (newUrl && !newUrl.includes('outlook.live.com')) { setStatus('found', 'Link extraido!'); return { type: 'link', value: newUrl, label: svc.label }; } }
      if (clickResult.href && clickResult.href !== 'clicked-no-href' && clickResult.href.startsWith('http')) { setStatus('found', 'Link do botao!'); return { type: 'link', value: clickResult.href, label: svc.label }; }
    }
    setStatus('extracting_links', 'Extraindo links...');
    const links = await extractLinksFromEmail(page);
    const bestLink = pickNetflixLink(links);
    if (bestLink) { setStatus('found', 'Link encontrado!'); return { type: 'link', value: bestLink, label: svc.label }; }
  }
  return null;
}

// ============ API ROUTES ============
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
  console.log('BKLOGINS v17 SMART | Porta:', PORT, '|', isServer() ? 'SERVIDOR' : 'LOCAL');
  console.log('Email:', config.email || '(nao configurado)');
  keepAlive();
});
