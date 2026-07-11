const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ========== CONFIG ==========
let config = { email: '', senha: '02022013L' };

const CONFIG_FILE = path.join(__dirname, 'config.json');
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
} catch(e) {}

// ========== KEEP ALIVE — ping automático ==========
const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '';
const PING_INTERVAL = 4 * 60 * 1000;

function keepAlive() {
  if (!APP_URL) return;
  setInterval(() => {
    https.get(APP_URL + '/api/ping', () => {}).on('error', () => {});
    console.log('[keepalive] ping enviado');
  }, PING_INTERVAL);
}

// ========== PADRÕES DE BUSCA ==========
const SERVICE_PATTERNS = {
  netflix_login: {
    subject: 'Netflix',
    bodyPattern: /Informe este código para entrar[^]*?(\d{4})/i,
    type: 'code',
    label: 'Código de Login',
    fallbackPattern: /(\d{4})\s*Informe o código acima/i
  },
  netflix_reset: {
    subject: 'Netflix',
    bodyPattern: /Vamos redefinir sua senha/i,
    type: 'link',
    label: 'Redefinir Senha',
    clickText: 'Redefinir senha',
    linkDomain: 'netflix.com/password'
  },
  netflix_verify: {
    subject: 'Netflix',
    bodyPattern: /Confirme com o código[^]*?(\d{6})/i,
    type: 'code',
    label: 'Código de Verificação',
    fallbackPattern: /código[^]*?(\d{6})/i
  },
  netflix_temp: {
    subject: 'Netflix',
    bodyPattern: /código de acesso temporário/i,
    type: 'link',
    label: 'Código Temporário',
    clickText: 'Receber código'
  },
  netflix_house: {
    subject: 'Netflix',
    bodyPattern: /atualizar sua residência Netflix/i,
    type: 'link',
    label: 'Atualizar Residência',
    clickText: 'Sim, fui eu'
  }
};

// ========== ROTAS ==========
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
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('[login] acessando outlook...');
    await page.goto('https://outlook.live.com/', { waitUntil: 'networkidle2', timeout: 30000 });

    try {
      await page.waitForSelector('a[data-task="signin"]', { timeout: 5000 });
      await page.click('a[data-task="signin"]');
    } catch(e) {}

    await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await page.type('input[type="email"]', config.email, { delay: 60 });
    await page.click('input[type="submit"]');
    console.log('[login] email preenchido');

    await page.waitForSelector('input[type="password"]', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 1500));
    await page.type('input[type="password"]', config.senha, { delay: 60 });
    await page.click('input[type="submit"]');
    console.log('[login] senha preenchida');

    try {
      await page.waitForSelector('input[type="submit"]', { timeout: 5000 });
      await page.click('input[type="submit"]');
    } catch(e) {}

    await page.waitForSelector('[role="main"]', { timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    console.log('[login] inbox carregada');

    let found = false;
    const items = await page.$$('[role="main"] [role="option"]');
    console.log('[search] ' + items.length + ' emails visiveis');

    for (let i = 0; i < Math.min(items.length, 15); i++) {
      const text = await items[i].evaluate(el => el.textContent);
      if (text.toLowerCase().includes('netflix')) {
        console.log('[search] email netflix encontrado na posicao ' + i);
        await items[i].click();
        await new Promise(r => setTimeout(r, 2500));
        found = true;
        break;
      }
    }

    if (!found) {
      await browser.close();
      return res.json({ error: 'Nenhum email da Netflix encontrado na caixa de entrada' });
    }

    await page.waitForSelector('[role="document"]', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1500));

    const emailBody = await page.evaluate(() => {
      const doc = document.querySelector('[role="document"]');
      return doc ? doc.innerText : document.body.innerText;
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
  console.log('🔥 Servidor rodando em http://localhost:' + PORT);
  setTimeout(keepAlive, 30000);
});
