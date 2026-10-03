// End-to-end test: loads the unpacked extension into real Chromium, serves the
// fixtures at the real claude.ai / perplexity.ai URLs (intercepted locally), runs
// the same code path as the right-click menu, and checks the downloaded file.
//
// Run with: npm run e2e   (set CHROME_PATH to a Chromium/Brave binary if needed)
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const MarkdownIt = require('markdown-it');

const EXT = process.env.EXT_DIR || path.join(__dirname, '..', 'extension');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const md = new MarkdownIt({ html: true });
const fences = (s) => md.parse(s, {}).filter((t) => t.type === 'fence').map((t) => ({ lang: t.info.trim(), code: t.content.replace(/\n$/, '') }));

// Site-like CSS: pre-wrap user text, KaTeX's hidden MathML, block-level code lines,
// a display:contents wrapper and a folded "Thought process" panel.
const SITE_CSS = `<style>
  .whitespace-pre-wrap { white-space: pre-wrap; }
  .grid { display: grid; } .inline-flex { display: inline-flex; } .hidden { display: none; }
  .sticky { position: sticky; } .opacity-0 { opacity: 0; }
  .katex-mathml { position: absolute; clip: rect(1px, 1px, 1px, 1px); height: 1px; width: 1px; overflow: hidden; }
  .katex-display { display: block; text-align: center; }
  code .line, code > span { display: block; }
  .font-claude-response > div:nth-child(2) { display: contents; }
  .font-claude-response .overflow-hidden { height: 0; overflow: hidden; }
</style>`;

const withoutThinking = (s) => s.replace(/<details>[\s\S]*?<\/details>\n\n/, '');

const buildDownloadPathCheck = (p) => p === 'AI Threads/x y/a.md';

const CASES = [
  { name: 'claude', fixture: 'claude', url: 'https://claude.ai/chat/0b1c2d3e', fences: 4, platform: 'Claude' },
  { name: 'perplexity', fixture: 'perplexity', url: 'https://www.perplexity.ai/search/what-is-rust-ownership-AbCdEf', fences: 2, platform: 'Perplexity' },
  { name: 'claude-styled', fixture: 'claude', url: 'https://claude.ai/chat/styled', fences: 4, platform: 'Claude',
    transform: (html) => html.replace('</head>', SITE_CSS + '</head>'), expect: withoutThinking },
  { name: 'perplexity-styled', fixture: 'perplexity', url: 'https://www.perplexity.ai/search/styled', fences: 2, platform: 'Perplexity',
    transform: (html) => html.replace('</head>', SITE_CSS + '</head>') }
];


/** Minimal evaluate() for the extension's service worker, over the DevTools protocol. */
async function connectWorker(port, extId) {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'service_worker' && t.url === `chrome-extension://${extId}/background.js`);
    if (!target) await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) throw new Error('extension service worker not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    url: () => target.url,
    close: () => ws.close(),
    async evaluate(fn, arg) {
      const expression = `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})`;
      const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (reply.error) throw new Error(reply.error.message);
      const r = reply.result;
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
      return r.result.value;
    }
  };
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aimd-profile-'));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'aimd-downloads-'));
  // Start the browser ourselves (not through Playwright's launcher) so downloads
  // behave exactly as in a normal profile, including chrome.downloads filenames.
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true }
  }));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank'
  ], { stdio: 'ignore' });
  let browser;
  for (let i = 0; i < 50 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch (_) { await new Promise((r) => setTimeout(r, 200)); }
  }
  const context = browser.contexts()[0];
  // Playwright redirects downloads to its own artifacts folder; restore the browser default.
  const browserSession = await browser.newBrowserCDPSession();
  await browserSession.send('Browser.setDownloadBehavior', { behavior: 'default' });

  let worker;
  try {
    for (const c of CASES) {
      let html = fs.readFileSync(path.join(__dirname, 'fixtures', c.fixture + '.html'), 'utf8');
      if (c.transform) html = c.transform(html);
      await context.route(c.url, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
    }

    // Talk to the extension's service worker over its own DevTools socket (Playwright
    // does not always attach to an extension worker that started before it connected).
    const extId = require('crypto').createHash('sha256').update(EXT).digest('hex').slice(0, 32)
      .replace(/./g, (h) => String.fromCharCode(97 + parseInt(h, 16)));
    worker = await connectWorker(port, extId);

    let failures = 0;
    await new Promise((r) => setTimeout(r, 500));
    const menuErrors = await worker.evaluate(() => menuErrors);
    if (menuErrors.length) { failures++; console.log('  FAIL context menu: ' + menuErrors.join('; ')); }
    else console.log('  ok   context menu items registered without errors');
    for (const c of CASES) {
      const page = await context.newPage();
      await page.goto(c.url);
      await page.waitForSelector('body');

      // Same entry point as the context-menu click.
      const before = fs.readdirSync(downloads).length;
      await worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        await exportFromTab(tab, 'save-thread');
      }, c.url);

      const item = await worker.evaluate(async () => {
        for (let i = 0; i < 50; i++) {
          const [d] = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
          if (d && d.state === 'complete') return d;
          await new Promise((r) => setTimeout(r, 100));
        }
        const [d] = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
        return d;
      });

      try {
        assert.ok(item, `${c.name}: no download started`);
        assert.equal(item.state, 'complete', `${c.name}: download state ${item.state} ${item.error || ''}`);
        assert.ok(item.filename.endsWith('.md'), `${c.name}: filename ${item.filename}`);
        const file = fs.existsSync(item.filename) ? item.filename : path.join(downloads, path.basename(item.filename));
        const text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(path.join(__dirname, 'output', c.name + '.e2e.md'), text);
        let jsdomText = fs.readFileSync(path.join(__dirname, 'output', c.fixture + '.md'), 'utf8');
        if (c.expect) jsdomText = c.expect(jsdomText);
        const strip = (s) => s.replace(/^exported: .*$/m, '').replace(/^source: .*$/m, '');
        assert.equal(strip(text), strip(jsdomText), `${c.name}: Chromium output differs from jsdom output`);
        assert.equal(fences(text).length, c.fences);
        assert.ok(text.includes('platform: ' + c.platform));
        const toast = await page.evaluate(() => !!document.getElementById('ai-thread-md-toast'));
        assert.ok(toast, `${c.name}: confirmation toast not shown`);
        if (c.name === 'claude') { await page.setViewportSize({ width: 900, height: 420 }); await page.waitForTimeout(300); await page.screenshot({ path: path.join(__dirname, 'output', 'toast.png') }); }
        console.log(`  ok   ${c.name}: saved ${path.basename(item.filename)} (${text.length} bytes), identical to the expected output`);
      } catch (err) {
        failures++;
        console.log(`  FAIL ${c.name}: ${err.message}`);
      }

      // Copy mode writes to the clipboard.
      try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(c.url).origin });
        await page.bringToFront();
        await page.evaluate(() => navigator.clipboard.writeText('STALE: something copied earlier'));
        await worker.evaluate(async (url) => {
          const [tab] = await chrome.tabs.query({ url });
          await exportFromTab(tab, 'copy-thread');
        }, c.url);
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        assert.ok(clip.includes('platform: ' + c.platform) && fences(clip).length === c.fences, `${c.name}: clipboard content wrong`);
        console.log(`  ok   ${c.name}: copied ${clip.length} characters to the clipboard`);
      } catch (err) {
        failures++;
        console.log(`  FAIL ${c.name} (copy): ${err.message}`);
      }
      await page.close();
    }

    // Copy must replace whatever was on the clipboard no matter what the page does,
    // and must never claim success when nothing was written.
    const HOSTILE_URL = 'https://www.perplexity.ai/search/clipboard-blocked';
    const hostileHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'perplexity.html'), 'utf8');
    await context.route(HOSTILE_URL, (route) => route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'permissions-policy': 'clipboard-write=(), clipboard-read=()' },
      body: hostileHtml
    }));
    await context.route('https://example.org/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>clipboard helper</p>' }));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://example.org' });
    const helper = await context.newPage();
    await helper.goto('https://example.org/');
    const STALE = 'STALE: something copied earlier';
    const readClipboard = () => helper.evaluate(() => navigator.clipboard.readText());

    const hostile = await context.newPage();
    await hostile.goto(HOSTILE_URL);
    // A page that blocks clipboard access, has its own editor focused, refuses the
    // async clipboard API and rewrites anything copied from it.
    await hostile.evaluate(() => {
      document.getElementById('ask-input').focus();
      document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'HIJACKED BY PAGE'); e.preventDefault(); }, true);
    });
    await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPTS });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => { navigator.clipboard.writeText = () => Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError')); }
      });
    }, HOSTILE_URL);
    const copyOnHostile = () => worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return exportFromTab(tab, 'copy-thread');
    }, HOSTILE_URL);

    const check = async (label, fn) => {
      try { await fn(); console.log('  ok   ' + label); } catch (err) { failures++; console.log('  FAIL ' + label + ': ' + err.message); }
    };

    await check('copy replaces the clipboard on a page that blocks and hijacks copying', async () => {
      await helper.evaluate((t) => navigator.clipboard.writeText(t), STALE);
      const result = await copyOnHostile();
      const clip = await readClipboard();
      assert.ok(clip.startsWith('---\ntitle: "What is Rust\'s ownership model?"'), 'clipboard holds: ' + JSON.stringify(clip.slice(0, 40)));
      assert.deepEqual(result, { ok: true, action: 'copied' });
      assert.ok(fences(clip).length === 2);
    });

    await check('the offscreen copy works on its own (page fallback disabled)', async () => {
      await helper.evaluate((t) => navigator.clipboard.writeText(t), STALE);
      await worker.evaluate(() => { globalThis.__realCopyInPage = copyInPage; copyInPage = async () => false; });
      const result = await copyOnHostile();
      await worker.evaluate(() => { copyInPage = globalThis.__realCopyInPage; });
      assert.deepEqual(result, { ok: true, action: 'copied' });
      assert.ok((await readClipboard()).includes('platform: Perplexity'));
    });

    await check('the page fallback copies when offscreen pages are unavailable', async () => {
      await helper.evaluate((t) => navigator.clipboard.writeText(t), STALE);
      await worker.evaluate(() => { globalThis.__realCopyInOffscreen = copyInOffscreen; copyInOffscreen = async () => false; });
      const result = await copyOnHostile();
      await worker.evaluate(() => { copyInOffscreen = globalThis.__realCopyInOffscreen; });
      const clip = await readClipboard();
      assert.deepEqual(result, { ok: true, action: 'copied' });
      assert.ok(clip.includes('platform: Perplexity'), 'clipboard holds: ' + JSON.stringify(clip.slice(0, 40)));
    });

    await check('a copy that cannot be written is reported as a failure, not as "Copied"', async () => {
      await helper.evaluate((t) => navigator.clipboard.writeText(t), STALE);
      await worker.evaluate(() => {
        globalThis.__realCopyInOffscreen = copyInOffscreen;
        copyInOffscreen = async () => false;
      });
      await worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { document.execCommand = () => true; } });
      }, HOSTILE_URL);
      const result = await copyOnHostile();
      await worker.evaluate(() => { copyInOffscreen = globalThis.__realCopyInOffscreen; });
      assert.deepEqual(result, { ok: false, action: 'copy-failed' });
      assert.equal(await readClipboard(), STALE);
    });
    await hostile.close();
    await helper.close();

    // Options page saves settings.
    try {
      const opts = await context.newPage();
      await opts.setViewportSize({ width: 460, height: 560 });
      await opts.goto(`chrome-extension://${extId}/options/options.html`);
      await opts.check('#saveAs');
      await opts.fill('#subfolder', 'AI Threads');
      await opts.waitForTimeout(300);
      await opts.screenshot({ path: path.join(__dirname, 'output', 'options.png') });
      const stored = await worker.evaluate(() => chrome.storage.sync.get(null));
      assert.equal(stored.saveAs, true);
      assert.equal(stored.subfolder, 'AI Threads');
      assert.equal(buildDownloadPathCheck(await worker.evaluate(() => buildDownloadPath('AI Threads/../x:y', 'a.md'))), true);
      await worker.evaluate(() => chrome.storage.sync.clear());
      await opts.close();
      console.log('  ok   options page stores settings');
    } catch (err) {
      failures++;
      console.log('  FAIL options page: ' + err.message);
    }

    // Alt+Shift+C copies the thread on both sites, whether or not the browser gave
    // the key to the extension's command, and fires once per press.
    const copyCommand = (await worker.evaluate(() => chrome.commands.getAll())).find((c) => c.name === 'copy-thread');
    console.log(`       (browser-assigned shortcut for "copy-thread": ${JSON.stringify(copyCommand.shortcut)})`);
    await worker.evaluate(() => {
      globalThis.__exportCalls = [];
      if (!globalThis.__realExportFromTab) globalThis.__realExportFromTab = exportFromTab;
      exportFromTab = (tab, mode) => { __exportCalls.push(mode); return __realExportFromTab(tab, mode); };
    });
    for (const c of CASES.filter((x) => !x.transform)) {
      await check(`Alt+Shift+C copies the ${c.platform} thread`, async () => {
        const page = await context.newPage();
        await page.goto(c.url);
        await page.bringToFront();
        await page.evaluate(() => navigator.clipboard.writeText('STALE: something copied earlier'));
        await worker.evaluate(() => { __exportCalls.length = 0; });
        // On Perplexity, press it while the page's own question box has focus.
        const box = await page.$('#ask-input');
        if (box) await box.focus();
        await page.keyboard.press('Alt+Shift+C');
        let clip = '';
        for (let i = 0; i < 40 && !clip.includes('platform: ' + c.platform); i++) {
          await page.waitForTimeout(100);
          clip = await page.evaluate(() => navigator.clipboard.readText());
        }
        assert.ok(clip.includes('platform: ' + c.platform) && fences(clip).length === c.fences, 'clipboard holds: ' + JSON.stringify(clip.slice(0, 40)));
        assert.deepEqual(await worker.evaluate(() => __exportCalls), ['copy-thread'], 'one copy per key press');
        if (box) assert.equal(await page.evaluate(() => document.getElementById('ask-input').textContent), 'Ask a follow-up', 'nothing typed into the page');
        assert.ok(await page.evaluate(() => !!document.getElementById('ai-thread-md-toast')), 'notice shown');
        await page.close();
      });
    }
    await worker.evaluate(() => { exportFromTab = __realExportFromTab; });

    // The options dialog on the extensions page must settle at one size.
    await check('options dialog keeps a steady size', async () => {
      const page = await context.newPage();
      await page.goto(`chrome://extensions/?options=${extId}`);
      const results = [];
      for (const [w, h] of [[1200, 900], [1920, 1080], [1366, 768], [1000, 600]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(1200);
        const sizes = await page.evaluate(async () => {
          const out = [];
          for (let i = 0; i < 40; i++) {
            const mgr = document.querySelector('extensions-manager');
            const dlg = mgr && mgr.shadowRoot.querySelector('extensions-options-dialog');
            const el = dlg && dlg.shadowRoot && dlg.shadowRoot.querySelector('extensionoptions');
            out.push(el ? el.offsetWidth + 'x' + el.offsetHeight : 'none');
            await new Promise((r) => setTimeout(r, 50));
          }
          return out;
        });
        const distinct = [...new Set(sizes)];
        results.push(`${w}x${h} → ${distinct.join(', ')}`);
        assert.ok(!distinct.includes('none'), 'options dialog did not open');
        assert.equal(distinct.length, 1, `size kept changing at ${w}x${h}: ${distinct.join(' ↔ ')}`);
      }
      console.log('       (' + results.join('; ') + ')');
      await page.close();
    });

    // The toolbar button on an unsupported page must not download anything.
    const count = (await worker.evaluate(() => chrome.downloads.search({}))).length;
    await context.route('https://example.com/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>hello</p>' }));
    const other = await context.newPage();
    await other.goto('https://example.com/');
    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs[tabs.length - 1];
      await exportFromTab({ id: tab.id, url: 'https://example.com/' }, 'save-thread');
    });
    const after = (await worker.evaluate(() => chrome.downloads.search({}))).length;
    if (after === count) console.log('  ok   unsupported page: nothing saved');
    else { failures++; console.log('  FAIL unsupported page triggered a download'); }

    console.log(failures ? `\n${failures} failure(s)` : '\nall end-to-end checks passed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (worker) worker.close();
    await browser.close().catch(() => {});
    proc.kill();
  }
})().catch((err) => { console.error(err); process.exit(1); });
