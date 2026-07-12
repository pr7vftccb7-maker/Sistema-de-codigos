const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (['/server.js', '/config.json', '/package.json', '/package-lock.json'].includes(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
});

app.use(express.static(path.join(__dirname)));

const CONFIG_FILE = path.join(__dirname, 'config.json');

let config = {
  email: '',
  senha: process.env.OUTLOOK_SENHA || ''
};

try {
  if (fs.existsSync(CONFIG_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config.email = saved.email || config.email;
    config.senha = saved.senha || config.senha;
  }
} catch (e) {
  console.log('[config] erro:', e.message);
}

let currentStatus = {
  code: 'idle',
  message: 'Aguardando busca.',
  detail: '',
  updatedAt: new Date().toISOString()
};

function setStatus(code, message, detail = '') {
  currentStatus = {
    code,
    message,
    detail: detail ? String(detail).slice(0, 900) : '',
    updatedAt: new Date().toISOString()
  };
  console.log('[status]', code, '-', message);
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(str) {
  return (str || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '';
function keepAlive() {
  if (!APP_URL) return;
  setInterval(() => {
    https.get(APP_URL + '/api/ping', () => {}).on('error', () => {});
  }, 4 * 60 * 1000);
}

const SERVICE_PATTERNS = {
  netflix_login: {
    type: 'code',
    label: 'Código de Login',
    codeLength: 4,
    bodyPattern: /Informe este código para entrar[\s\S]*?\b(\d{4})\b/i,
    fallbackPattern: /\b(\d{4})\b[\s\S]*?Informe o código acima/i,
    extraPatterns: [/entrar na Netflix/i, /c[oó]digo[\s\S]*?entrar/i]
  },
  netflix_reset: {
    type: 'link',
    label: 'Redefinir Senha',
    bodyPattern: /Vamos redefinir sua senha|redefinir sua senha/i,
    clickText: ['Redefinir senha', 'Reset password']
  },
  netflix_verify: {
    type: 'code',
    label: 'Código de Verificação',
    codeLength: 6,
    bodyPattern: /Confirme com o código[\s\S]*?\b(\d{6})\b/i,
    fallbackPattern: /c[oó]digo[\s\S]*?\b(\d{6})\b/i,
    extraPatterns: [/verifica/i, /confirme/i]
  },
  netflix_temp: {
    type: 'link',
    label: 'Código Temporário',
    bodyPattern: /c[oó]digo de acesso tempor[aá]rio|acesso tempor[aá]rio/i,
    clickText: ['Receber código', 'Obter código', 'Get code']
  },
  netflix_house: {
    type: 'link',
    label: 'Atualizar Residência',
    bodyPattern: /atualizar sua resid[êe]ncia Netflix|resid[êe]ncia Netflix/i,
    clickText: ['Sim, fui eu', 'Atualizar residência', 'Yes, it was me']
  }
};

const EMAIL_SELECTORS = ['input[type="email"]', 'input[name="loginfmt"]', '#i0116'];
const PASSWORD_SELECTORS = ['input[type="password"]', 'input[name="passwd"]', '#i0118'];

const SEARCH_SELECTORS = [
  'input[aria-label*="Pesquisar"]',
  'input[placeholder*="Pesquisar"]',
  'input[aria-label*="Search"]',
  'input[placeholder*="Search"]',
  'input[role="searchbox"]',
  '[role="searchbox"]',
  '[contenteditable="true"][aria-label*="Pesquisar"]',
  '[contenteditable="true"][aria-label*="Search"]'
];

const MESSAGE_SELECTORS = [
  '[role="main"] [role="option"]',
  '[role="main"] [role="listitem"]',
  '[role="main"] div[data-convid]',
  '[role="listbox"] [role="option"]',
  '[aria-label*="Lista de mensagens"] [role="option"]',
  '[aria-label*="Message list"] [role="option"]',
  'div[data-convid]'
];

function detectOutlookIssue(text, url = '') {
  const t = normalizeText(text);
  const u = String(url || '').toLowerCase();
  const detail = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 900);

  if (/captcha|prove que voce nao e um robo|prove you are not a robot|robot check|verification challenge|desafio de verificacao/.test(t)) {
    return { code: 'captcha', message: 'Captcha/verificação anti-robô detectada no Outlook. Resolva manualmente e tente de novo.', detail };
  }

  if (/senha incorreta|sua conta ou senha esta incorreta|password is incorrect|your account or password is incorrect|incorrect password/.test(t)) {
    return { code: 'wrong_password', message: 'Senha incorreta no Outlook. Verifique a senha cadastrada e tente novamente.', detail };
  }

  if (/nao encontramos uma conta|essa conta microsoft nao existe|we could not find an account|we couldn't find an account|that microsoft account doesn't exist/.test(t)) {
    return { code: 'email_not_found', message: 'Email Outlook não encontrado ou inválido.', detail };
  }

  if (/conta bloqueada|temporariamente bloqueada|account has been locked|account locked|temporarily locked|suspended/.test(t)) {
    return { code: 'account_blocked', message: 'Conta Outlook bloqueada. Entre manualmente no Outlook para desbloquear antes de usar o sistema.', detail };
  }

  if (/ajude-nos a proteger sua conta|vamos proteger sua conta|help us protect your account|protect your account|adicionar informacoes de seguranca|add security info/.test(t) || /\/proofs\//.test(u)) {
    return { code: 'protect_account', message: 'Outlook pediu “ajude-nos a proteger sua conta”. Acesse manualmente e conclua essa etapa.', detail };
  }

  if (/verifique sua identidade|confirmar identidade|confirme sua identidade|verify your identity|confirm your identity|insira o codigo|digite o codigo|enter code|security code|codigo de seguranca|authenticator|duas etapas|two-step|two factor|2fa/.test(t) || /\/identity\/|\/ppsecure\//.test(u)) {
    return { code: 'extra_confirmation', message: 'Outlook pediu confirmação extra/verificação de segurança. Confirme manualmente e tente novamente.', detail };
  }

  if (/muitas tentativas|too many times|try again later|tente novamente mais tarde/.test(t)) {
    return { code: 'too_many_attempts', message: 'Outlook bloqueou temporariamente por muitas tentativas. Aguarde um pouco e tente novamente.', detail };
  }

  return null;
}

async function getVisibleText(page) {
  return page.evaluate(() => {
    return (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim();
  }).catch(() => '');
}

async function throwIfOutlookIssue(page) {
  const text = await getVisibleText(page);
  const issue = detectOutlookIssue(text, page.url());
  if (!issue) return;

  setStatus(issue.code, issue.message, issue.detail);

  const err = new Error(issue.message);
  err.code = issue.code;
  err.detail = issue.detail;
  throw err;
}

async function firstExisting(page, selectors) {
  for (const selector of selectors) {
    const el = await page.$(selector).catch(() => null);
    if (el) return el;
  }
  return null;
}

async function clearAndType(page, element, value) {
  await element.click({ clickCount: 3 }).catch(() => {});
  await page.keyboard.down('Control').catch(() => {});
  await page.keyboard.press('A').catch(() => {});
  await page.keyboard.up('Control').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await element.type(value, { delay: 35 });
}

async function clickByVisibleText(page, words) {
  return page.evaluate((words) => {
    const normalize = (s) => (s || '')
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    const targets = words.map(normalize);
    const els = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));

    for (const el of els) {
      const txt = normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '');
      if (!txt) continue;

      if (targets.some(t => txt === t || txt.includes(t))) {
        el.click();
        return txt;
      }
    }

    return null;
  }, words).catch(() => null);
}

async function setupPage(page) {
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(90000);

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  );

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
  });

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const type = request.resourceType();
    if (type === 'image' || type === 'font' || type === 'media') {
      request.abort().catch(() => {});
    } else {
      request.continue().catch(() => {});
    }
  });
}

async function launchBrowser() {
  return puppeteer.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--mute-audio'
    ],
    defaultViewport: chromium.defaultViewport || { width: 1365, height: 768 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true
  });
}

async function isMailboxReady(page) {
  const url = page.url();

  if (!/outlook\.live\.com\/mail|outlook\.office\.com\/mail/i.test(url)) {
    return false;
  }

  return page.evaluate(() => {
    const text = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ');
    const normalized = text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    const hasLoginText = /entrar|sign in|loginfmt|senha|password/.test(normalized);
    const hasMailWords = /caixa de entrada|inbox|novo email|new mail|pastas|folders|rascunhos|drafts|itens enviados|sent items|lixo eletronico|junk email|focused|other|filtro|filter/.test(normalized);

    const hasMessageList = !!document.querySelector([
      '[aria-label*="Lista de mensagens"]',
      '[aria-label*="Message list"]',
      '[role="listbox"] [role="option"]',
      '[role="main"] [role="option"]',
      '[role="main"] [role="listitem"]',
      'div[data-convid]'
    ].join(','));

    const hasSearchBox = !!document.querySelector([
      'input[aria-label*="Pesquisar"]',
      'input[placeholder*="Pesquisar"]',
      'input[aria-label*="Search"]',
      'input[placeholder*="Search"]',
      '[role="searchbox"]'
    ].join(','));

    if (hasLoginText && !hasMailWords) return false;

    return hasMessageList || (hasSearchBox && hasMailWords);
  }).catch(() => false);
}

async function waitForMailbox(page, maxLoops = 45) {
  for (let i = 1; i <= maxLoops; i++) {
    await throwIfOutlookIssue(page);

    if (await isMailboxReady(page)) {
      setStatus('mailbox_ready', 'Caixa de entrada carregada. Login no Outlook concluído.');
      return true;
    }

    if (i === 1 || i % 8 === 0) {
      setStatus('waiting_mailbox', 'Login enviado. Aguardando a caixa de entrada carregar...');
    }

    await sleep(1500);
  }

  return false;
}

async function loginOutlook(page, email, senha) {
  setStatus('opening_outlook', 'Abrindo Outlook...');

  await page.goto('https://outlook.live.com/mail/0/inbox', {
    waitUntil: 'domcontentloaded',
    timeout: 90000
  }).catch(e => console.log('[login] goto:', e.message));

  await sleep(2500);

  for (let attempt = 1; attempt <= 70; attempt++) {
    await throwIfOutlookIssue(page);

    if (await isMailboxReady(page)) {
      setStatus('mailbox_ready', 'Caixa de entrada carregada. Login no Outlook concluído.');
      return true;
    }

    const emailInput = await firstExisting(page, EMAIL_SELECTORS);
    if (emailInput) {
      setStatus('email_step', 'Tela de email detectada. Informando email do Outlook...');
      await clearAndType(page, emailInput, email);
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(3000);
      continue;
    }

    const passInput = await firstExisting(page, PASSWORD_SELECTORS);
    if (passInput) {
      setStatus('password_step', 'Tela de senha detectada. Informando senha do Outlook...');
      await clearAndType(page, passInput, senha);
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(3500);

      const loaded = await waitForMailbox(page, 8);
      if (loaded) return true;

      continue;
    }

    const clicked = await clickByVisibleText(page, [
      'Entrar',
      'Sign in',
      'Próximo',
      'Next',
      'Sim',
      'Yes',
      'Continuar',
      'Continue',
      'Ignorar por enquanto',
      'Skip for now',
      'Talvez mais tarde',
      'Maybe later',
      'Agora não',
      'Not now'
    ]);

    if (clicked) {
      setStatus('login_continue', 'Respondendo etapa do login Microsoft: ' + clicked);
      await sleep(3000);
      continue;
    }

    const submit = await firstExisting(page, [
      '#idSIButton9',
      '#idSubmit_SAOTCC_Continue',
      'input[type="submit"]',
      'button[type="submit"]'
    ]);

    if (submit) {
      setStatus('login_continue', 'Continuando login Microsoft...');
      await submit.click().catch(() => {});
      await sleep(3000);
      continue;
    }

    if (attempt === 1 || attempt % 10 === 0) {
      setStatus('checking_screen', 'Verificando tela atual do Outlook/Microsoft...');
    }

    await sleep(1000);
  }

  const text = await getVisibleText(page);
  const issue = detectOutlookIssue(text, page.url());

  if (issue) {
    setStatus(issue.code, issue.message, issue.detail);
    const err = new Error(issue.message);
    err.code = issue.code;
    err.detail = issue.detail;
    throw err;
  }

  const err = new Error('Login do Outlook não concluiu. Pode existir uma tela de confirmação não reconhecida.');
  err.code = 'login_not_completed';
  err.detail = 'URL atual: ' + page.url() + ' | Tela: ' + text.slice(0, 650);
  setStatus(err.code, err.message, err.detail);
  throw err;
}

async function useOutlookSearch(page, query) {
  const search = await firstExisting(page, SEARCH_SELECTORS);

  if (!search) {
    setStatus('searching', 'Caixa de entrada aberta. Não achei o campo de busca; procurando na lista atual...');
    return false;
  }

  setStatus('searching', 'Caixa de entrada aberta. Pesquisando emails da Netflix...');
  await clearAndType(page, search, query);
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(6500);

  return true;
}

async function getNetflixMessageItems(page) {
  const selector = MESSAGE_SELECTORS.join(', ');
  const items = await page.$$(selector).catch(() => []);
  const rows = [];

  for (const item of items) {
    const text = await item.evaluate(el => {
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }).catch(() => '');

    if (text && text.toLowerCase().includes('netflix')) {
      rows.push({ item, text });
    }
  }

  return rows;
}

async function openNetflixMessage(page, index) {
  const rows = await getNetflixMessageItems(page);

  if (!rows[index]) return false;

  setStatus('email_opened', 'Abrindo email da Netflix ' + (index + 1) + ' de ' + rows.length + '...');
  await rows[index].item.click().catch(() => {});
  await sleep(3000);

  return true;
}

async function readEmailBody(page) {
  await sleep(1000);

  return page.evaluate(() => {
    const selectors = [
      '[role="document"]',
      '[aria-label*="Corpo"]',
      '[aria-label*="Message body"]',
      '[data-app-section="ReadingPane"]',
      '[role="main"]'
    ];

    let best = '';

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el ? (el.innerText || el.textContent || '') : '';
      if (text.length > best.length) best = text;
    }

    return (best || document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim();
  }).catch(() => '');
}

function bodyLooksLikeService(body, svc) {
  if (!body) return false;
  if (svc.bodyPattern && svc.bodyPattern.test(body)) return true;
  if (svc.fallbackPattern && svc.fallbackPattern.test(body)) return true;
  if (svc.extraPatterns && svc.extraPatterns.some(rx => rx.test(body))) return true;
  return false;
}

function cleanLink(url) {
  if (!url) return url;

  try {
    const parsed = new URL(url);
    const inner = parsed.searchParams.get('url') || parsed.searchParams.get('u');
    if (inner && /netflix\.com/i.test(inner)) return decodeURIComponent(inner);
  } catch (_) {}

  return url.replace(/[)\].,;]+$/g, '');
}

function extractCode(body, svc) {
  const patterns = [svc.bodyPattern, svc.fallbackPattern].filter(Boolean);

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match && match[1]) return match[1];
  }

  if (bodyLooksLikeService(body, svc) && svc.codeLength) {
    const rx = new RegExp('\\b(\\d{' + svc.codeLength + '})\\b', 'g');
    const all = [...body.matchAll(rx)].map(m => m[1]);
    if (all.length) return all[0];
  }

  return null;
}

async function extractLink(page, body, svc) {
  if (!bodyLooksLikeService(body, svc)) return null;

  const clickTexts = Array.isArray(svc.clickText) ? svc.clickText : [svc.clickText].filter(Boolean);

  const href = await page.$$eval('a', (els, clickTexts) => {
    const normalize = (s) => (s || '')
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    const targets = clickTexts.map(normalize);

    for (const el of els) {
      const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
      const href = el.href || '';

      if (href && targets.some(t => text.includes(t))) {
        return href;
      }
    }

    for (const el of els) {
      const href = el.href || '';
      if (href.includes('netflix.com') || href.includes('safelinks.protection.outlook.com')) {
        return href;
      }
    }

    return null;
  }, clickTexts).catch(() => null);

  if (href) return cleanLink(href);

  const urlMatch = body.match(/https?:\/\/[^\s"'<>]+/i);
  if (urlMatch && /netflix\.com|safelinks\.protection\.outlook\.com/i.test(urlMatch[0])) {
    return cleanLink(urlMatch[0]);
  }

  return null;
}

async function extractResult(page, body, svc) {
  setStatus('extracting', 'Email aberto. Extraindo código/link...');

  if (svc.type === 'code') return extractCode(body, svc);
  if (svc.type === 'link') return extractLink(page, body, svc);

  return null;
}

async function findNetflixResult(page, svc) {
  setStatus('opening_inbox', 'Login confirmado. Abrindo caixa de entrada...');

  await page.goto('https://outlook.live.com/mail/0/inbox', {
    waitUntil: 'domcontentloaded',
    timeout: 90000
  }).catch(e => console.log('[search] goto inbox:', e.message));

  await sleep(3500);

  if (!(await isMailboxReady(page))) {
    const ok = await waitForMailbox(page, 20);

    if (!ok) {
      const text = await getVisibleText(page);
      const err = new Error('Não consegui confirmar que a caixa de entrada abriu.');
      err.code = 'mailbox_not_ready';
      err.detail = 'URL atual: ' + page.url() + ' | Tela: ' + text.slice(0, 650);
      setStatus(err.code, err.message, err.detail);
      throw err;
    }
  }

  await useOutlookSearch(page, 'Netflix');

  for (let i = 0; i < 25; i++) {
    const opened = await openNetflixMessage(page, i);
    if (!opened) break;

    const body = await readEmailBody(page);
    const result = await extractResult(page, body, svc);

    if (result) {
      setStatus('found', 'Código/link encontrado com sucesso.');
      return result;
    }
  }

  setStatus('not_found', 'Entrou no Outlook, mas não encontrou email compatível com esse serviço da Netflix.');
  return null;
}

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/status', (req, res) => {
  res.json(currentStatus);
});

app.post('/api/status/reset', (req, res) => {
  setStatus('idle', 'Aguardando busca.');
  res.json(currentStatus);
});

app.get('/api/config', (req, res) => {
  res.json({ email: config.email || '' });
});

app.post('/api/config', (req, res) => {
  const { email, senha } = req.body || {};

  if (typeof email === 'string' && email.trim()) {
    config.email = email.trim();
  }

  if (typeof senha === 'string' && senha.trim()) {
    config.senha = senha.trim();
  }

  try {
    saveConfig();
  } catch (e) {
    return res.json({ error: 'Não foi possível salvar config.json: ' + e.message });
  }

  res.json({ ok: true });
});

app.post('/api/search', async (req, res) => {
  const { service } = req.body || {};
  const svc = SERVICE_PATTERNS[service];

  if (!svc) {
    setStatus('service_error', 'Serviço não encontrado: ' + service);
    return res.json({ error: 'Serviço não encontrado: ' + service, code: 'service_error', status: currentStatus });
  }

  if (!config.email || !config.senha) {
    setStatus('config_error', 'Email/senha não configurados.');
    return res.json({ error: 'Email/senha não configurados', code: 'config_error', status: currentStatus });
  }

  let browser;

  try {
    setStatus('starting', 'Iniciando navegador...');

    browser = await launchBrowser();

    const page = await browser.newPage();
    await setupPage(page);

    await loginOutlook(page, config.email, config.senha);

    const result = await findNetflixResult(page, svc);

    if (result) {
      setStatus('found', 'Entrou no Outlook e encontrou o resultado.');
      return res.json({ found: true, result, service: svc.label, code: 'found', status: currentStatus });
    }

    return res.json({
      error: 'Nenhum email da Netflix compatível com "' + svc.label + '" foi encontrado.',
      code: 'not_found',
      status: currentStatus
    });
  } catch (e) {
    const code = e.code || currentStatus.code || 'process_error';
    const message = e.message || 'Erro no processo.';
    const detail = e.detail || currentStatus.detail || '';

    setStatus(code, message, detail);

    return res.json({ error: message, code, status: currentStatus });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('Servidor rodando em http://localhost:' + PORT);
  setTimeout(keepAlive, 30000);
});
