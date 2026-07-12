const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Evita expor arquivos sensíveis quando o Express serve a pasta do projeto.
app.use((req, res, next) => {
  const blocked = new Set(['/server.js', '/config.json', '/package.json', '/package-lock.json']);
  if (blocked.has(req.path)) return res.status(404).send('Not found');
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
  console.log('[config] não foi possível ler config.json:', e.message);
}

const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '';
const PING_INTERVAL = 4 * 60 * 1000;

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

function keepAlive() {
  if (!APP_URL) return;
  setInterval(() => {
    https.get(APP_URL + '/api/ping', () => {}).on('error', () => {});
  }, PING_INTERVAL);
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

function detectOutlookIssue(text, url = '') {
  const t = normalizeText(text);
  const u = String(url || '').toLowerCase();
  const detail = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 900);

  if (/captcha|prove que voce nao e um robo|prove you are not a robot|robot check|verification challenge|desafio de verificacao/.test(t)) {
    return {
      code: 'captcha',
      message: 'Captcha/verificação anti-robô detectada no Outlook. Resolva manualmente na conta e tente de novo.',
      detail
    };
  }

  if (/senha incorreta|senha que voce inseriu esta incorreta|sua conta ou senha esta incorreta|password is incorrect|your account or password is incorrect|incorrect password/.test(t)) {
    return {
      code: 'wrong_password',
      message: 'Senha incorreta no Outlook. Verifique a senha cadastrada e tente novamente.',
      detail
    };
  }

  if (/nao encontramos uma conta|nao reconhecemos esse usuario|essa conta microsoft nao existe|we could not find an account|we couldn't find an account|that microsoft account doesn't exist|we don't recognize this user/.test(t)) {
    return {
      code: 'email_not_found',
      message: 'Email Outlook não encontrado ou inválido.',
      detail
    };
  }

  if (/sua conta foi bloqueada|conta bloqueada|temporariamente bloqueada|account has been locked|account locked|temporarily locked|suspended/.test(t)) {
    return {
      code: 'account_blocked',
      message: 'Conta Outlook bloqueada. Entre manualmente no Outlook para desbloquear antes de usar o sistema.',
      detail
    };
  }

  if (/ajude-nos a proteger sua conta|vamos proteger sua conta|help us protect your account|protect your account|mantenha sua conta segura|keep your account secure|adicionar informacoes de seguranca|add security info/.test(t) || /\/proofs\//.test(u)) {
    return {
      code: 'protect_account',
      message: 'Outlook pediu “ajude-nos a proteger sua conta”. Acesse manualmente e conclua essa etapa.',
      detail
    };
  }

  if (/verifique sua identidade|confirmar identidade|confirme sua identidade|verify your identity|confirm your identity|insira o codigo|digite o codigo|enter code|security code|codigo de seguranca|aprovar solicitacao|aprovar a solicitacao|approve sign.?in request|microsoft authenticator|authenticator|duas etapas|two-step|two factor|2fa|use seu aplicativo/.test(t) || /\/identity\/|\/ppsecure\//.test(u)) {
    return {
      code: 'extra_confirmation',
      message: 'Outlook pediu confirmação extra/verificação de segurança. Confirme manualmente e tente novamente.',
      detail
    };
  }

  if (/muitas tentativas|voce tentou entrar muitas vezes|too many times|try again later|tente novamente mais tarde|temporariamente indisponivel/.test(t)) {
    return {
      code: 'too_many_attempts',
      message: 'Outlook bloqueou temporariamente por muitas tentativas. Aguarde um pouco e tente novamente.',
      detail
    };
  }

  return null;
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

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="loginfmt"]',
  '#i0116'
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="passwd"]',
  '#i0118'
];

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

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function firstExisting(page, selectors) {
  for (const selector of selectors) {
    const el = await page.$(selector).catch(() => null);
    if (el) return el;
  }
  return null;
}

async function getVisibleText(page) {
  return page.evaluate(() => (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '');
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

  // Não bloqueia CSS, porque o Outlook às vezes depende do layout para carregar a lista.
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
  const executablePath = await chromium.executablePath();

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
    executablePath,
    headless: chromium.headless,
    ignoreHTTPSErrors: true
  });
}

async function isMailboxReady(page) {
  const url = page.url();
  if (!/outlook\.live\.com|outlook\.office\.com/i.test(url)) return false;
  if (!/\/mail/i.test(url)) return false;

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
    return hasMessageList || (hasMailWords && hasSearchBox);
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
  console.log('[login] abrindo Outlook...');

  await page.goto('https://outlook.live.com/mail/0/inbox', {
    waitUntil: 'domcontentloaded',
    timeout: 90000
  }).catch(e => console.log('[login] goto:', e.message));

  await sleep(2500);

  for (let attempt = 1; attempt <= 70; attempt++) {
    await throwIfOutlookIssue(page);

    if (await isMailboxReady(page)) {
      setStatus('mailbox_ready', 'Caixa de entrada carregada. Login no Outlook concluído.');
      console.log('[login] caixa de entrada carregada');
      return true;
    }

    const emailInput = await firstExisting(page, EMAIL_SELECTORS);
    if (emailInput) {
      setStatus('email_step', 'Tela de email detectada. Informando email do Outlook...');
      console.log('[login] preenchendo email');
      await clearAndType(page, emailInput, email);
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(3000);
      continue;
    }

    const passInput = await firstExisting(page, PASSWORD_SELECTORS);
    if (passInput) {
      setStatus('password_step', 'Tela de senha detectada. Informando senha do Outlook...');
      console.log('[login] preenchendo senha');
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
      console.log('[login] clique automático:', clicked);
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
      console.log('[login] clicando submit');
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
    console.log('[search] campo de pesquisa não encontrado, usando lista atual');
    setStatus('searching', 'Caixa de entrada aberta. Não achei o campo de busca; procurando na lista atual...');
    return false;
  }

  setStatus('searching', 'Caixa de entrada aberta. Pesquisando emails da Netflix...');
  console.log('[search] pesquisando:', query);
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
    const text = await item.evaluate(el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '');
    if (text && text.toLowerCase().includes('netflix')) {
      rows.push({ item, text });
    }
  }

  return rows;
}

async function openNetflixMessage(page, index) {
  const rows = await getNetflixMessageItems(page);
  console.log('[search] mensagens Netflix visíveis:', rows.length);

  if (!rows[index]) return false;

  setStatus('email_opened', 'Abrindo email da Netflix ' + (index + 1) + ' de ' + rows.length + '...');
  console.log('[search] abrindo mensagem', index + 1, '-', rows[index].text.slice(0, 120));
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
      if (href && targets.some(t => text.includes(t))) return href;
    }

    for (const el of els) {
      const href = el.href || '';
      if (href.includes('netflix.com') || href.includes('safelinks.protection.outlook.com')) return href;
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
  console.log('[search] abrindo inbox...');

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
    console.log('[email] corpo lido:', body.length, 'caracteres');

    const result = await extractResult(page, body, svc);
    if (result) {
      setStatus('found', 'Código/link encontrado com sucesso.');
      console.log('[result] encontrado');
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

    console.error('[erro]', message);
    setStatus(code, message, detail);

    return res.json({ error: message, code, status: currentStatus });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
});

// ===== DEBUG VISUAL DO OUTLOOK =====
// Abra /debug-outlook para ver prints do navegador entrando no Outlook.

const DEBUG_DIR = path.join(__dirname, 'debug-outlook');

try {
  if (!fs.existsSync(DEBUG_DIR)) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
  }
} catch (e) {
  console.log('[debug] não foi possível criar pasta:', e.message);
}

app.use('/debug-outlook-files', express.static(DEBUG_DIR));

let debugState = {
  running: false,
  step: 'Aguardando teste.',
  detail: '',
  image: '',
  updatedAt: new Date().toISOString()
};

function updateDebug(data) {
  debugState = {
    ...debugState,
    ...data,
    updatedAt: new Date().toISOString()
  };
  console.log('[debug]', debugState.step);
}

function setDebug(step, detail = '') {
  updateDebug({
    step,
    detail: detail ? String(detail).slice(0, 900) : ''
  });
}

async function takeDebugShot(page, step, detail = '') {
  let image = debugState.image;

  try {
    const filename = 'outlook-' + Date.now() + '.png';
    const fullPath = path.join(DEBUG_DIR, filename);

    await page.screenshot({
      path: fullPath,
      fullPage: false
    });

    image = '/debug-outlook-files/' + filename + '?v=' + Date.now();
  } catch (e) {
    detail = (detail || '') + ' | Falha ao tirar print: ' + e.message;
  }

  updateDebug({
    step,
    detail: detail ? String(detail).slice(0, 900) : '',
    image
  });
}

async function runOutlookVisualDebug() {
  let browser;

  try {
    updateDebug({
      running: true,
      step: 'Iniciando navegador...',
      detail: '',
      image: ''
    });

    browser = await launchBrowser();

    const page = await browser.newPage();
    await setupPage(page);

    setDebug('Abrindo Outlook...');
    await page.goto('https://outlook.live.com/mail/0/inbox', {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    }).catch(e => {
      setDebug('Erro ao abrir Outlook', e.message);
    });

    await sleep(2500);
    await takeDebugShot(page, 'Outlook abriu. Verificando tela...', 'URL: ' + page.url());

    for (let attempt = 1; attempt <= 80; attempt++) {
      const text = await getVisibleText(page);
      const issue = detectOutlookIssue(text, page.url());

      if (issue) {
        await takeDebugShot(page, issue.message, issue.detail);
        return;
      }

      if (await isMailboxReady(page)) {
        await takeDebugShot(
          page,
          'SUCESSO: caixa de entrada abriu. Login no Outlook funcionou.',
          'URL: ' + page.url()
        );
        return;
      }

      const emailInput = await firstExisting(page, EMAIL_SELECTORS);

      if (emailInput) {
        await takeDebugShot(page, 'Tela de email detectada. Vou preencher o email.');
        await clearAndType(page, emailInput, config.email);
        await page.keyboard.press('Enter').catch(() => {});
        await sleep(3000);
        await takeDebugShot(page, 'Email enviado. Aguardando próxima tela...', 'URL: ' + page.url());
        continue;
      }

      const passInput = await firstExisting(page, PASSWORD_SELECTORS);

      if (passInput) {
        await takeDebugShot(page, 'Tela de senha detectada. Vou preencher a senha.');
        await clearAndType(page, passInput, config.senha);
        await page.keyboard.press('Enter').catch(() => {});
        await sleep(3500);
        await takeDebugShot(page, 'Senha enviada. Aguardando Outlook responder...', 'URL: ' + page.url());
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
        await sleep(1500);
        await takeDebugShot(page, 'Clique automático na etapa: ' + clicked, 'URL: ' + page.url());
        await sleep(1500);
        continue;
      }

      const submit = await firstExisting(page, [
        '#idSIButton9',
        '#idSubmit_SAOTCC_Continue',
        'input[type="submit"]',
        'button[type="submit"]'
      ]);

      if (submit) {
        await takeDebugShot(page, 'Botão de continuar encontrado. Clicando...');
        await submit.click().catch(() => {});
        await sleep(3000);
        continue;
      }

      if (attempt === 1 || attempt % 5 === 0) {
        await takeDebugShot(
          page,
          'Aguardando ou verificando tela atual...',
          'Tentativa ' + attempt + ' | URL: ' + page.url()
        );
      }

      await sleep(1000);
    }

    const finalText = await getVisibleText(page);

    await takeDebugShot(
      page,
      'Login não concluiu.',
      'URL: ' + page.url() + ' | Tela: ' + finalText.slice(0, 650)
    );
  } catch (e) {
    setDebug('Erro no debug: ' + e.message);
  } finally {
    updateDebug({ running: false });

    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
}

app.get('/api/debug-outlook/latest', (req, res) => {
  res.json(debugState);
});

app.post('/api/debug-outlook/start', (req, res) => {
  const { email, senha } = req.body || {};

  if (typeof email === 'string' && email.trim()) {
    config.email = email.trim();
  }

  if (typeof senha === 'string' && senha.trim()) {
    config.senha = senha.trim();
  }

  try {
    saveConfig();
  } catch (_) {}

  if (!config.email || !config.senha) {
    return res.json({
      ok: false,
      error: 'Email/senha não configurados.'
    });
  }

  if (debugState.running) {
    return res.json({
      ok: true,
      running: true,
      message: 'Teste já está rodando.'
    });
  }

  runOutlookVisualDebug().catch(e => {
    updateDebug({
      running: false,
      step: 'Erro no debug',
      detail: e.message
    });
  });

  res.json({ ok: true });
});

app.get('/debug-outlook', (req, res) => {
  res.send(`
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Debug Outlook</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#080808;color:#fff;font-family:Arial,system-ui,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:22px}
h1{margin:0 0 8px;font-size:24px}
p{color:#aaa;margin:0 0 18px;font-size:14px}
.box{background:#111;border:1px solid #262626;border-radius:12px;padding:14px;margin-bottom:14px}
.row{display:flex;gap:8px;margin-bottom:10px}
input{flex:1;background:#050505;color:#fff;border:1px solid #333;border-radius:8px;padding:12px;font-size:14px;min-width:0}
button{background:#e50914;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-weight:800;cursor:pointer}
button:disabled{opacity:.55;cursor:not-allowed}
.status{font-size:14px;line-height:1.4}
.title{font-size:12px;text-transform:uppercase;color:#888;font-weight:900;margin-bottom:6px}
.detail{color:#888;font-size:12px;margin-top:8px;white-space:pre-wrap;max-height:120px;overflow:auto;border-top:1px solid #222;padding-top:8px}
.screen{background:#000;border:1px solid #333;border-radius:12px;overflow:hidden;min-height:240px;display:flex;align-items:center;justify-content:center}
.screen img{width:100%;display:block}
.empty{color:#555;padding:30px;text-align:center}
@media(max-width:650px){.row{flex-direction:column}button{width:100%}}
</style>
</head>
<body>
<div class="wrap">
  <h1>Debug Outlook</h1>
  <p>Essa tela mostra prints do navegador oculto tentando entrar no Outlook.</p>

  <div class="box">
    <div class="row">
      <input id="email" type="email" placeholder="email Outlook">
      <input id="senha" type="password" placeholder="senha Outlook, opcional se já estiver salva">
      <button id="btn" onclick="startDebug()">Iniciar teste</button>
    </div>
    <div class="status">
      <div class="title" id="title">Status</div>
      <div id="step">Aguardando...</div>
      <div class="detail" id="detail" style="display:none"></div>
    </div>
  </div>

  <div class="screen" id="screen">
    <div class="empty">O print do Outlook vai aparecer aqui.</div>
  </div>
</div>

<script>
const API = window.location.origin;
let timer = null;

const emailInput = document.getElementById('email');
const senhaInput = document.getElementById('senha');
const btn = document.getElementById('btn');
const title = document.getElementById('title');
const step = document.getElementById('step');
const detail = document.getElementById('detail');
const screen = document.getElementById('screen');

function setButton(running) {
  btn.disabled = running;
  btn.textContent = running ? 'Testando...' : 'Iniciar teste';
}

async function startDebug() {
  setButton(true);

  const email = emailInput.value.trim();
  const senha = senhaInput.value.trim();

  try {
    const res = await fetch(API + '/api/debug-outlook/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, senha })
    });

    const data = await res.json();

    if (!data.ok) {
      alert(data.error || 'Erro ao iniciar debug');
      setButton(false);
      return;
    }

    startPolling();
  } catch (e) {
    alert('Erro de conexão');
    setButton(false);
  }
}

async function poll() {
  try {
    const res = await fetch(API + '/api/debug-outlook/latest', { cache: 'no-store' });
    const data = await res.json();

    title.textContent = data.running ? 'Rodando' : 'Status';
    step.textContent = data.step || 'Aguardando...';

    if (data.detail) {
      detail.style.display = 'block';
      detail.textContent = data.detail;
    } else {
      detail.style.display = 'none';
      detail.textContent = '';
    }

    if (data.image) {
      screen.innerHTML = '<img src="' + data.image + '" alt="Print Outlook">';
    }

    setButton(!!data.running);
  } catch (e) {}
}

function startPolling() {
  if (timer) clearInterval(timer);
  poll();
  timer = setInterval(poll, 1500);
}

fetch(API + '/api/config')
  .then(r => r.json())
  .then(d => {
    if (d.email) emailInput.value = d.email;
  })
  .catch(() => {});

startPolling();
<\/script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor rodando em http://localhost:' + PORT);
  setTimeout(keepAlive, 30000);
});
