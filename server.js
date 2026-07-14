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

// ============ SERVICE PATTERNS COM PALAVRAS-CHAVE POR TIPO ============
const SERVICE_PATTERNS = {
  netflix_login: {
    type: 'code',
    label: 'Codigo de Login',
    subjectKeywords: /login|entrar|sign.?in|acesso|autentic/i,
    bodyKeywords: /login|entrar|sign.?in|faça.?login|conecte.?se/i,
    blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i,
    blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i
  },
  netflix_reset: {
    type: 'link',
    label: 'Redefinir Senha',
    subjectKeywords: /redefinir|reset|senha|password|alterar.*senha|change.*password/i,
    bodyKeywords: /redefinir.*senha|reset.*password|nova.*senha|new.*password|clique.*(botão|button|aqui|link).*(redefinir|alterar|reset)/i,
    blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i,
    blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i
  },
  netflix_verify: {
    type: 'code',
    label: 'Verificacao',
    subjectKeywords: /verific|verif|código|code|confirme|confirm/i,
    bodyKeywords: /código.*verificação|verification.*code|confirme.*código|confirm.*code|segurança|security/i,
    blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i,
    blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i
  },
  netflix_temp: {
    type: 'link',
    label: 'Codigo Temporario',
    subjectKeywords: /temporári|temporary|acesso.*temp|temp.*access|código.*tempor/i,
    bodyKeywords: /temporári|temporary|código.*login|sign.?in.*code|acesse.*agora|login.*now/i,
    blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i,
    blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i
  },
  netflix_house: {
    type: 'link',
    label: 'Atualizar Residencia',
    subjectKeywords: /residência|residence|household|domicílio|atualizar.*(residência|local|casa)|update.*(home|household|address)/i,
    bodyKeywords: /residência|residence|household|domicílio|moradia|atualizar.*(local|endereço|residência)/i,
    blockedSubjects: /alteração da sua conta|change.*(email|account)|mudança.*(email|conta)|email.*alterad/i,
    blockedBody: /confirme a alteração da sua conta|change.*your.*email|update.*email.*address|altere.*email|mudar.*email/i
  }
};

// ============ BLOQUEIO ESTRITO: EMAIL DE ALTERACAO DE CONTA ============
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

// ============ LE O ASSUNTO DO EMAIL SELECIONADO ============
async function getEmailSubject(page) {
  return await page.evaluate(() => {
    const selectors = [
      '[aria-label*="Assunto" i]',
      '[role="heading"]',
      'h1', 'h2', 'h3',
      '[class*="subject" i]',
      '[data-testid="message-header-subject"]',
      '.readingPaneSubject',
      '[id*="subject" i]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 2) {
        return el.innerText.trim();
      }
    }
    return '';
  });
}

// ============ LE O CORPO DO EMAIL (texto completo) ============
async function getEmailBody(page) {
  return await page.evaluate(() => {
    let texto = '';
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
    return texto;
  });
}

// ============ VERIFICA SE O EMAIL EH BLOQUEADO (alteracao de conta) ============
function isEmailBlocked(subject, body) {
  const combined = (subject + ' ' + body).toLowerCase();
  for (const pattern of BLOCKED_EMAIL_PATTERNS) {
    if (pattern.test(combined)) {
      console.log('[Bloqueio] Email bloqueado! Padrao:', pattern);
      return true;
    }
  }
  return false;
}

// ============ VERIFICA SE O EMAIL CORRESPONDE AO SERVICO ============
function emailMatchesService(subject, body, svc) {
  if (svc.blockedSubjects && svc.blockedSubjects.test(subject)) {
    console.log('[Match] Assunto bloqueado:', subject.slice(0, 100));
    return false;
  }
  if (svc.blockedBody && svc.blockedBody.test(body)) {
    console.log('[Match] Corpo bloqueado:', body.slice(0, 100));
    return false;
  }

  const subjectMatch = svc.subjectKeywords.test(subject);
  const bodyMatch = svc.bodyKeywords.test(body);

  console.log('[Match] Subject:', subject.slice(0, 80), '| match:', subjectMatch);
  console.log('[Match] Body:', body.slice(0, 80), '| match:', bodyMatch);

  return subjectMatch || bodyMatch;
}

// ============ NAVEGA PELOS EMAILS DE "OUTROS" ATE ACHAR O CERTO ============
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

  if (!clickedOutros) {
    console.log('[Busca] Outros nao encontrado, tentando inbox normal...');
  }

  await sleep(4000);

  const emailCount = await page.evaluate(() => {
    const sels = ['div[data-convid]', '[role="option"]', '[role="listitem"]', 'div[data-testid="message-item"]', '.eeumf'];
    for (const sel of sels) {
      const items = document.querySelectorAll(sel);
      if (items.length > 0) return items.length;
    }
    return 0;
  });

  console.log('[Busca] Total de emails na lista:', emailCount);

  if (emailCount === 0) {
    console.log('[Busca] Nenhum email encontrado.');
    return false;
  }

  const MAX_EMAILS = Math.min(emailCount, 15);

  for (let i = 0; i < MAX_EMAILS; i++) {
    setStatus('scanning', 'Analisando email ' + (i + 1) + ' de ' + MAX_EMAILS + '...');
    console.log('[Busca] --- Email ' + (i + 1) + '/' + MAX_EMAILS + ' ---');

    const clicked = await page.evaluate((idx) => {
      const sels = ['div[data-convid]', '[role="option"]', '[role="listitem"]', 'div[data-testid="message-item"]', '.eeumf'];
      for (const sel of sels) {
        const items = document.querySelectorAll(sel);
        if (items.length > idx) {
          items[idx].click();
          return { ok: true, total: items.length };
        }
      }
      return { ok: false, total: 0 };
    }, i);

    if (!clicked.ok) break;

    await sleep(4000);

    const subject = await getEmailSubject(page);
    console.log('[Busca] Assunto:', subject.slice(0, 100));

    if (!subject || subject.length < 3) {
      console.log('[Busca] Assunto vazio, pulando...');
      continue;
    }

    const body = await getEmailBody(page);
    console.log('[Busca] Corpo (primeiros 150):', body.slice(0, 150));

    // ⛔ BLOQUEIO: email de alteração de conta
    if (isEmailBlocked(subject, body)) {
      console.log('[Busca] ⛔ Email BLOQUEADO (alteracao de conta), pulando...');
      continue;
    }

    // ✅ Verifica se bate com o servico
    if (emailMatchesService(subject, body, svc)) {
      console.log('[Busca] ✅ Email CORRETO encontrado na posicao', i);
      return true;
    }

    console.log('[Busca] Email nao corresponde, indo pro proximo...');
  }

  console.log('[Busca] Nenhum email correspondente em', MAX_EMAILS, 'tentativas.');
  return false;
}

// ============ EXTRAI LINKS DO EMAIL ============
async function extractLinksFromEmail(page) {
  return await page.evaluate(() => {
    const links = [];

    function collectLinks(doc, source) {
      for (const a of doc.querySelectorAll('a')) {
        const href = (a.href || '').trim();
        if (href && !href.startsWith('javascript:') && href !== '#' && !href.startsWith('mailto:')) {
          links.push({
            href: href,
            text: (a.innerText || a.textContent || '').trim().slice(0, 100),
            color: getComputedStyleRed(a),
            source: source
          });
        }
      }

      for (const el of doc.querySelectorAll('button, [role="button"], div[onclick], td[onclick]')) {
        const onclick = el.getAttribute('onclick') || '';
        const urlMatch = onclick.match(/(?:location\.href|window\.open|window\.location)\s*=\s*['"]([^'"]+)['"]/);
        if (urlMatch) {
          links.push({
            href: urlMatch[1],
            text: (el.innerText || el.textContent || '').trim().slice(0, 100),
            color: getComputedStyleRed(el),
            source: source + '-onclick'
          });
        }
      }

      for (const el of doc.querySelectorAll('a, td, div, span, button')) {
        const bg = getComputedStyleRed(el);
        if (bg && !links.some(l => l.href === (el.href || ''))) {
          const href = (el.href || '').trim();
          if (href && !href.startsWith('javascript:') && href !== '#' && !href.startsWith('mailto:')) {
            links.push({ href, text: (el.innerText || el.textContent || '').trim().slice(0, 100), color: bg, source: source + '-redbtn' });
          }
        }
      }
    }

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

    collectLinks(document, 'main');

    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (doc && doc.body) collectLinks(doc, 'iframe');
      } catch(e) {}
    }

    return links;
  });
}

function pickNetflixLink(links) {
  if (!links || links.length === 0) return null;

  console.log('[LinkExtract] Total de links encontrados:', links.length);

  const redLinks = links.filter(l => l.color);
  console.log('[LinkExtract] Links vermelhos:', redLinks.length);
  if (redLinks.length > 0) {
    for (const l of redLinks) {
      console.log('[LinkExtract] Link vermelho:', l.href.slice(0, 150), '| texto:', l.text);
    }
    const redNetflix = redLinks.find(l => /netflix/i.test(l.href));
    if (redNetflix) return redNetflix.href;
    return redLinks[0].href;
  }

  const netflixLinks = links.filter(l => /netflix\.com/i.test(l.href));
  console.log('[LinkExtract] Links com netflix.com:', netflixLinks.length);
  if (netflixLinks.length > 0) {
    const resetLink = netflixLinks.find(l => /reset|redefin|password|senha|update|atualizar|verify|confirm/i.test(l.href + l.text));
    if (resetLink) return resetLink.href;
    return netflixLinks[0].href;
  }

  const trackingLinks = links.filter(l => 
    /netflix/i.test(l.href) || 
    /email\.flix/i.test(l.href) ||
    /netflix\.(email|mail|click|link)/i.test(l.href)
  );
  if (trackingLinks.length > 0) return trackingLinks[0].href;

  const safelinks = links.filter(l => /safelinks\.protection\.outlook\.com/i.test(l.href) && /netflix/i.test(l.href));
  if (safelinks.length > 0) return safelinks[0].href;

  const textNetflix = links.find(l => /netflix/i.test(l.text));
  if (textNetflix) return textNetflix.href;

  const actionLinks = links.filter(l => 
    /verify|confirm|reset|update|click|acessar|entrar|acesse|clique|redefinir|atualizar/i.test(l.text)
  );
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
        if (link && link.href && !link.href.startsWith('javascript:')) {
          return { clicked: true, href: link.href, where: 'main' };
        }
        el.click();
        return { clicked: true, href: 'clicked-no-href', where: 'main-click' };
      }
    }

    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (!doc || !doc.body) continue;
        const els = Array.from(doc.querySelectorAll('a, button, [role="button"], td, div, span'));
        for (const el of els) {
          if (isRed(el)) {
            const link = el.tagName === 'A' ? el : el.querySelector('a');
            if (link && link.href && !link.href.startsWith('javascript:')) {
              link.click();
              return { clicked: true, href: link.href, where: 'iframe' };
            }
            el.click();
            return { clicked: true, href: 'clicked-no-href', where: 'iframe-click' };
          }
        }
      } catch(e) {}
    }

    return { clicked: false };
  });
}

// ============ FUNCAO PRINCIPAL - EXTRACAO (v17 SMART) ============
async function findNetflixResult(page, svc) {
  // Passo 1: Navegar entre os emails de Outros ate achar o certo
  const found = await findCorrectEmail(page, svc);

  if (!found) {
    return null;
  }

  // ===== EXTRAI CODIGO =====
  if (svc.type === 'code') {
    console.log('[Busca] Procurando codigo no email...');
    setStatus('extracting_code', 'Extraindo codigo...');

    const codigo = await page.evaluate(() => {
      let texto = '';
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
      if (!texto) return null;
      console.log('[Browser] Texto:', texto.slice(0, 300));

      let m = texto.match(/(?:codigo|code|informe|digite|entrar|enter|acima|c.digo).{0,80}?(\d{4})(?!\d)/i);
      if (!m) m = texto.match(/(?:codigo|code|informe|digite|entrar|enter|acima|c.digo).{0,80}?(\d{6})(?!\d)/i);
      if (!m) m = texto.match(/(?:netflix).{0,100}?(\d{4})(?!\d)/i);
      if (!m) m = texto.match(/(?:netflix).{0,100}?(\d{6})(?!\d)/i);
      if (!m) {
        const regex = /\b(\d{4})\b/g;
        let match;
        while ((match = regex.exec(texto)) !== null) {
          if (!match[1].startsWith('20') && !match[1].startsWith('19')) { m = match; break; }
        }
      }
      if (!m) m = texto.match(/\b(\d{6})\b/);
      return m ? m[1] : null;
    });

    if (codigo) {
      console.log('[Busca] CODIGO:', codigo);
      setStatus('found', 'Codigo: ' + codigo);
      return { type: 'code', value: codigo, label: svc.label };
    }
    console.log('[Busca] Nenhum codigo encontrado.');
  }

  // ===== EXTRAI LINK =====
  if (svc.type === 'link') {
    console.log('[Busca] Procurando link...');

    setStatus('clicking_button', 'Clicando no botao vermelho...');
    const urlBefore = page.url();
    const clickResult = await clickRedButtonInEmail(page);
    console.log('[Busca] Clique:', JSON.stringify(clickResult));

    if (clickResult.clicked) {
      await sleep(3000);
      const pages = await page.browser().pages();
      const newPage = pages.find(p => p.url() !== urlBefore && p.url() !== 'about:blank');
      if (newPage) {
        const newUrl = newPage.url();
        console.log('[Busca] Nova pagina:', newUrl);
        try { await newPage.close(); } catch(e) {}
        if (newUrl && !newUrl.includes('outlook.live.com')) {
          setStatus('found', 'Link extraido do botao!');
          return { type: 'link', value: newUrl, label: svc.label };
        }
      }
      if (clickResult.href && clickResult.href !== 'clicked-no-href' && clickResult.href.startsWith('http')) {
        console.log('[Busca] Link do botao:', clickResult.href);
        setStatus('found', 'Link do botao vermelho!');
        return { type: 'link', value: clickResult.href, label: svc.label };
      }
    }

    setStatus('extracting_links', 'Extraindo links...');
    const links = await extractLinksFromEmail(page);
    const bestLink = pickNetflixLink(links);
    if (bestLink) {
      console.log('[Busca] Melhor link:', bestLink);
      setStatus('found', 'Link encontrado!');
      return { type: 'link', value: bestLink, label: svc.label };
    }

    try { await page.screenshot({ path: path.join(__dirname, 'debug-email.png'), fullPage: false }); } catch(e) {}
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
  console.log('BKLOGINS v17 SMART | Porta:', PORT, '|', isServer() ? 'SERVIDOR' : 'LOCAL');
  console.log('Email:', config.email || '(nao configurado)');
  keepAlive();
});
