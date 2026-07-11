const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

let config = { email: '', senha: '02022013L' };

const CONFIG_FILE = path.join(__dirname, 'config.json');
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
} catch(e) {}

const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '';
const PING_INTERVAL = 4 * 60 * 1000;

function keepAlive() {
  if (!APP_URL) return;
  setInterval(() => {
    https.get(APP_URL + '/api/ping', () => {}).on('error', () => {});
  }, PING_INTERVAL);
}

const SERVICE_PATTERNS = {
  netflix_login: {
    bodyPattern: /Informe este código para entrar[^]*?(\d{4})/i,
    type: 'code',
    label: 'Código de Login',
    fallbackPattern: /(\d{4})\s*Informe o código acima/i
  },
  netflix_reset: {
    bodyPattern: /Vamos redefinir sua senha/i,
    type: 'link',
    label: 'Redefinir Senha',
    clickText: 'Redefinir senha'
  },
  netflix_verify: {
    bodyPattern: /Confirme com o código[^]*?(\d{6})/i,
    type: 'code',
    label: 'Código de Verificação',
    fallbackPattern: /código[^]*?(\d{6})/i
  },
  netflix_temp: {
    bodyPattern: /código de acesso temporário/i,
    type: 'link',
    label: 'Código Temporário',
    clickText: 'Receber código'
  },
  netflix_house: {
    bodyPattern: /atualizar sua residência Netflix/i,
    type: 'link',
    label: 'Atualizar Residência',
    clickText: 'Sim, fui eu'
  }
};

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/config', (req, res) => {
  res.json({ email: config.email });
});

app.post('/api/config', (req, res) => {
  const { email, senha } = req.body;
  config.email = email || config.email;
  config.senha = senha || config.senha;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  res.json({ ok: true });
});

app.post('/api/search', async (req, res) => {
  const { service } = req.body;

  if (!config.email || !config.senha) {
    return res.json({ error: 'Email/senha não configurados' });
  }

  const svc = SERVICE_PATTERNS[service];
  if (!svc) {
    return res.json({ error: 'Serviço não encontrado: ' + service });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--single-process',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--max-old-space-size=256'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();

    // Bloqueia imagens, CSS e fontes pra economizar memória
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'stylesheet' || type === 'font' || type === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

    console.log('[login] acessando outlook...');
    await page.goto('https://login.live.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const emailSelectors = [
      'input[type="email"]',
      'input[name="loginfmt"]',
      '#i0116',
      '#usernameInput'
    ];

    let emailInput = null;
    for (const sel of emailSelectors) {
      try {
        emailInput = await page.waitForSelector(sel, { timeout: 5000 });
        if (emailInput) {
          console.log('[login] seletor email: ' + sel);
          break;
        }
      } catch(e) {}
    }

    if (!emailInput) {
      emailInput = await page.waitForSelector('input[placeholder*="email"], input[placeholder*="Email"], input[placeholder*="conta"]', { timeout: 5000 }).catch(() => null);
    }

    if (!emailInput) {
      await browser.close();
      return res.json({ error: 'Não foi possível encontrar o campo de email no Outlook. Tente novamente.' });
    }

    await emailInput.click({ clickCount: 3 });
    await emailInput.type(config.email, { delay: 60 });
    console.log('[login] email preenchido');

    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 2000));

    const submitSelectors = [
      'input[type="submit"]',
      'button[type="submit"]',
      '#idSIButton9'
    ];

    for (const sel of submitSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await new Promise(r => setTimeout(r, 2000));
          break;
        }
      } catch(e) {}
    }

    const passSelectors = [
      'input[type="password"]',
      'input[name="passwd"]',
      '#i0118',
      '#passwordInput'
    ];

    let passInput = null;
    for (const sel of passSelectors) {
      try {
        passInput = await page.waitForSelector(sel, { timeout: 15000 });
        if (passInput) {
          console.log('[login] seletor senha: ' + sel);
          break;
        }
      } catch(e) {}
    }

    if (passInput) {
      await passInput.click({ clickCount: 3 });
      await passInput.type(config.senha, { delay: 60 });
      console.log('[login] senha preenchida');
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 2000));

      for (const sel of submitSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click();
            await new Promise(r => setTimeout(r, 2000));
            break;
          }
        } catch(e) {}
      }
    }

    try {
      const staySelectors = [
        'input[type="submit"]',
        '#idSIButton9',
        'button[type="submit"]'
      ];
      for (const sel of staySelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click();
            await new Promise(r => setTimeout(r, 2000));
            break;
          }
        } catch(e) {}
      }
    } catch(e) {}

    console.log('[login] aguardando inbox...');
    await page.goto('https://outlook.live.com/mail/0/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    let found = false;
    const itemSelectors = [
      '[role="main"] [role="option"]',
      '[role="main"] [role="listitem"]',
      '[role="main"] div[data-convid]',
      '.lvHighlightAllClass'
    ];

    let items = [];
    for (const sel of itemSelectors) {
      items = await page.$$(sel);
      if (items.length > 0) {
        console.log('[search] seletor itens: ' + sel + ' (' + items.length + ' emails)');
        break;
      }
    }

    if (items.length === 0) {
      await browser.close();
      return res.json({ error: 'Não foi possível carregar a caixa de entrada. Tente novamente.' });
    }

    for (let i = 0; i < Math.min(items.length, 20); i++) {
      const text = await items[i].evaluate(el => el.textContent);
      if (text.toLowerCase().includes('netflix')) {
        console.log('[search] netflix encontrado na posicao ' + i);
        await items[i].click();
        await new Promise(r => setTimeout(r, 3000));
        found = true;
        break;
      }
    }

    if (!found) {
      await browser.close();
      return res.json({ error: 'Nenhum email da Netflix encontrado na caixa de entrada' });
    }

    await new Promise(r => setTimeout(r, 2000));
    const emailBody = await page.evaluate(() => {
      const doc = document.querySelector('[role="document"]');
      if (doc) return doc.innerText;
      const main = document.querySelector('[role="main"]');
      return main ? main.innerText : document.body.innerText;
    });

    console.log('[email] corpo lido, ' + emailBody.length + ' caracteres');

    let result = null;

    if (svc.type === 'code') {
      let match = emailBody.match(svc.bodyPattern);
      if (match && match[1]) {
        result = match[1];
      } else if (svc.fallbackPattern) {
        match = emailBody.match(svc.fallbackPattern);
        if (match && match[1]) {
          result = match[1];
        }
      }
      if (!result) {
        const digitsOnly = emailBody.match(/\b(\d{4,6})\b/g);
        if (digitsOnly && digitsOnly.length > 0) {
          result = digitsOnly[digitsOnly.length - 1];
        }
      }
    } else if (svc.type === 'link') {
      try {
        const links = await page.$$eval('a', (els, clickText) => {
          for (const el of els) {
            if (el.textContent.trim().includes(clickText) && el.href) {
              return el.href;
            }
          }
          for (const el of els) {
            if (el.href && el.href.includes('netflix.com')) {
              return el.href;
            }
          }
          return null;
        }, svc.clickText);

        if (links) {
          result = links;
        }
      } catch(e) {}

      if (!result) {
        const urlMatch = emailBody.match(/https?:\/\/[^\s]*netflix\.com[^\s]*/i);
        if (urlMatch) result = urlMatch[0];
      }
    }

    await browser.close();
    console.log('[result] ' + (result || 'nada encontrado'));

    if (result) {
      res.json({ found: true, result, service: svc.label });
    } else {
      res.json({ error: 'Não foi possível extrair o código/link. O email pode estar em formato diferente do esperado.' });
    }

  } catch(e) {
    console.error('[erro]', e.message);
    if (browser) {
      try { await browser.close(); } catch(_) {}
    }
    res.json({ error: 'Erro no processo: ' + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor rodando em http://localhost:' + PORT);
  setTimeout(keepAlive, 30000);
});
