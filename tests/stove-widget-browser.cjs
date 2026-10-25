// Optional local browser verification. Supply PLAYWRIGHT_MODULE_PATH if Playwright is outside this repo.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'widgets/stove/public');
const languages = ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'ru', 'pl', 'ko', 'ar'];
if (process.argv.includes('--previews')) {
  throw new Error('Picker previews are schematic illustrations. Render preview-light.svg and preview-dark.svg to PNG instead of generating screenshots.');
}
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
  if (!file.startsWith(publicRoot + path.sep)) { response.writeHead(403); response.end(); return; }
  fs.readFile(file, (error, data) => {
    response.writeHead(error ? 404 : 200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    response.end(error ? 'Not found' : data);
  });
});

async function startPage(browser, address, language, theme, width) {
  const page = await browser.newPage({ viewport: { width, height: 850 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(address);
  const strings = JSON.parse(fs.readFileSync(path.join(root, `locales/${language}.json`), 'utf8')).widget;
  await page.evaluate(({ strings, theme }) => {
    if (theme === 'dark') document.body.classList.add('homey-dark-mode');
    window.testState = {
      name: 'Living room', available: true, on: true, temperature: 21.4, target: 23, cleaningHours: 12,
      targetMin: 5, targetMax: 35, targetStep: 1, canPower: true, canTarget: true, canReset: true,
      weeklyProgram: false, pellets: 18.5, pelletCapacity: 30, mode: 'heating', heating: true,
      error: false, errorCode: null, errorMessage: null,
    };
    window.testCalls = [];
    window.onHomeyReady({
      __: (key, tokens = {}) => {
        let text = strings[key.split('.').pop()] || key;
        for (const [name, value] of Object.entries(tokens)) text = text.replaceAll(`__${name}__`, value);
        return text;
      },
      getSettings: () => ({ stove: { id: 'test', name: 'Living room' }, half_full_kg: 15, full_kg: 30 }),
      ready() {}, setHeight: async height => { window.widgetHeight = height; },
      api: async (method, url, body) => {
        if (method === 'POST') {
          window.testCalls.push(body);
          if (body.action === 'target') window.testState.target = body.value;
          if (body.action === 'power') window.testState.on = body.value;
          if (body.action === 'pellets') window.testState.pellets = body.value;
          if (window.holdNextControl) {
            window.holdNextControl = false;
            await new Promise(resolve => { window.releaseControl = resolve; });
          }
        }
        return { ...window.testState };
      },
    });
  }, { strings, theme });
  await page.waitForFunction(() => document.getElementById('target-value').textContent !== '—');
  return { page, errors, strings };
}

async function checkGeometry(page, label) {
  const geometry = await page.evaluate(() => {
    const power = document.getElementById('power').getBoundingClientRect();
    const text = document.getElementById('power-label').getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      square: Math.abs(power.width - power.height),
      centerX: Math.abs(power.x + power.width / 2 - (text.x + text.width / 2)),
      centerY: Math.abs(power.y + power.height / 2 - (text.y + text.height / 2)),
      labelFits: text.width <= power.width - 4 && text.height <= power.height - 4,
    };
  });
  assert.equal(geometry.overflow, false, `${label}: horizontal overflow`);
  assert.ok(geometry.square < 1 && geometry.centerX < 1 && geometry.centerY < 1 && geometry.labelFits, `${label}: power geometry ${JSON.stringify(geometry)}`);
}

async function exerciseControls(page) {
  await page.locator('#edit-target').click();
  assert.equal(await page.locator('#target').evaluate(el => el === document.activeElement), true);
  await page.locator('#plus').click();
  assert.equal(await page.locator('#target-value').textContent(), '23');
  await page.locator('#cancel').click();
  assert.equal(await page.locator('#edit-target').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.testCalls.length), 0);
  await page.locator('#edit-target').click();
  await page.locator('#plus').click();
  await page.evaluate(() => { window.holdNextControl = true; });
  await page.locator('#save').click();
  await page.waitForFunction(() => typeof window.releaseControl === 'function');
  for (const key of ['Tab', 'Shift+Tab', 'Escape']) {
    await page.keyboard.press(key);
    assert.equal(await page.locator('#target-editor').isVisible(), true);
    assert.equal(await page.locator('#target-dialog').evaluate(el => el.contains(document.activeElement)), true, `Pending command ${key} left dialog`);
  }
  await page.evaluate(() => { window.releaseControl(); delete window.releaseControl; });
  await page.waitForFunction(() => document.getElementById('target-editor').hidden);
  assert.equal(await page.locator('#target-editor').isVisible(), false);
  assert.equal(await page.locator('#target-value').textContent(), '24');
  assert.equal(await page.locator('#edit-target').evaluate(el => el === document.activeElement), true);
  await page.locator('#half').click();
  assert.equal(await page.locator('#pellets').textContent(), '15');
  assert.equal(await page.locator('#message').isVisible(), false);
  await page.locator('#full').click();
  assert.equal(await page.locator('#pellets').textContent(), '30');
  await page.locator('#power').click();
  assert.equal(await page.locator('#power').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#widget').getAttribute('data-burning'), 'false');
  assert.deepEqual(await page.evaluate(() => window.testCalls.map(call => [call.action, call.value])), [['target', 24], ['pellets', 15], ['pellets', 30], ['power', false]]);
  await page.evaluate(() => {
    window.testState = { ...window.testState, mode: 'off', heating: false, cleaningHours: 0 };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Off, Cleaning required');
  await page.evaluate(() => { window.testState.weeklyProgram = true; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.getElementById('edit-target').disabled);
  await page.evaluate(() => {
    window.testState.error = true; window.testState.errorCode = 'F026'; window.testState.errorMessage = 'F026: Pellet hopper is empty';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => !document.getElementById('fault').hidden);
  await page.locator('summary').click();
  assert.match(await page.locator('#fault-message').textContent(), /Pellet hopper is empty/);
}

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }), headless: true });
    const address = `http://127.0.0.1:${server.address().port}/`;
    for (const theme of ['light', 'dark']) {
      for (const language of languages) {
        const { page, errors } = await startPage(browser, address, language, theme, 360);
        for (const width of [280, 360, 512]) {
          await page.setViewportSize({ width, height: 850 });
          await checkGeometry(page, `${language}/${theme}/${width}`);
        }
        await page.setViewportSize({ width: 360, height: 850 });
        assert.equal(await page.locator('html').getAttribute('dir'), language === 'ar' ? 'rtl' : 'ltr');
        await page.locator('#edit-target').click();
        await checkGeometry(page, `${language}/${theme}/editor`);
        await page.locator('#cancel').click();
        await page.evaluate(() => { window.testState.on = false; document.dispatchEvent(new Event('visibilitychange')); });
        await page.waitForFunction(() => document.getElementById('power').getAttribute('aria-pressed') === 'false');
        await checkGeometry(page, `${language}/${theme}/off`);
        await page.evaluate(() => { window.testState.on = true; document.dispatchEvent(new Event('visibilitychange')); });
        await page.waitForFunction(() => document.getElementById('widget').dataset.burning === 'true');
        if (language === 'en') {
          const height = await page.locator('#widget').evaluate(el => el.offsetHeight);
          assert.ok(height < 290, `Compact height ${height}`);
          console.log(`${theme}: compact widget height ${height}px at 360px width`);
          assert.equal(await page.locator('.flames').evaluate(el => getComputedStyle(el, '::before').animationPlayState), 'running');
          await page.emulateMedia({ reducedMotion: 'reduce' });
          assert.equal(await page.locator('.flames').evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await exerciseControls(page);
        }
        assert.deepEqual(errors, [], `${language}/${theme}: browser exceptions`);
        await page.close();
      }
    }
    console.log('PASS: 13 languages, 2 themes, 3 widths; square centered power labels; target/refill/error/cleaning/weekly controls; reduced motion. Mock API only.');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
