/*
 * AI Thread → Markdown — background service worker (Manifest V3).
 *
 * Adds the right-click menu, injects the extractor into the tab on demand,
 * saves the result with chrome.downloads, and copies it from an offscreen page.
 */

const SUPPORTED_PATTERNS = [
  'https://claude.ai/*',
  'https://*.perplexity.ai/*',
  'https://www.google.com/*',
  'https://www.google.co.uk/*',
  'https://www.google.de/*',
  'https://www.google.fr/*',
  'https://www.google.ca/*',
  'https://www.google.com.au/*',
  'https://www.google.es/*',
  'https://www.google.it/*',
  'https://www.google.nl/*',
  'https://www.google.co.in/*',
  'https://www.google.co.jp/*',
  'https://www.google.com.br/*',
  'https://www.bing.com/*',
  'https://search.brave.com/*',
  'https://duckduckgo.com/*',
  'https://*.you.com/*',
  'https://you.com/*',
  'https://kagi.com/*'
];
const SUPPORTED_HOST_RE = /^https:\/\/(claude\.ai|([\w-]+\.)?perplexity\.ai|www\.google\.(com|co\.uk|de|fr|ca|com\.au|es|it|nl|co\.in|co\.jp|com\.br)|www\.bing\.com|search\.brave\.com|duckduckgo\.com|([\w-]+\.)?you\.com|kagi\.com)\//i;
const CONTENT_SCRIPTS = ['content/markdown.js', 'content/extractors.js', 'content/runner.js'];

const DEFAULT_SETTINGS = {
  frontMatter: true,
  nestHeadings: true,
  includeCitations: true,
  includeThinking: true,
  saveAs: false,
  subfolder: ''
};

const MENU = {
  saveThread: 'save-thread',
  copyThread: 'copy-thread',
  saveSelection: 'save-selection',
  copySelection: 'copy-selection'
};

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

// Errors from creating menu items (kept for debugging from the service worker console).
const menuErrors = [];
const recordMenuError = () => {
  if (chrome.runtime.lastError) menuErrors.push(chrome.runtime.lastError.message);
};

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const threadContexts = ['page', 'frame', 'link', 'image', 'editable', 'selection'];
    chrome.contextMenus.create({
      id: MENU.saveThread,
      title: 'Save thread as Markdown',
      contexts: threadContexts,
      documentUrlPatterns: SUPPORTED_PATTERNS
    }, recordMenuError);
    chrome.contextMenus.create({
      id: MENU.copyThread,
      title: 'Copy thread as Markdown',
      contexts: threadContexts,
      documentUrlPatterns: SUPPORTED_PATTERNS
    }, recordMenuError);
    chrome.contextMenus.create({
      id: MENU.saveSelection,
      title: 'Save selection as Markdown',
      contexts: ['selection'],
      documentUrlPatterns: SUPPORTED_PATTERNS
    }, recordMenuError);
    chrome.contextMenus.create({
      id: MENU.copySelection,
      title: 'Copy selection as Markdown',
      contexts: ['selection'],
      documentUrlPatterns: SUPPORTED_PATTERNS
    }, recordMenuError);
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (Object.values(MENU).includes(info.menuItemId)) exportFromTab(tab, info.menuItemId);
});

// Toolbar button and keyboard shortcut save the whole thread.
chrome.action.onClicked.addListener((tab) => exportFromTab(tab, MENU.saveThread));

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== MENU.saveThread && command !== MENU.copyThread) return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && !isRepeatedShortcut(tab.id, command)) exportFromTab(tab, command);
});

// Alt+Shift+C pressed on a Claude or Perplexity page (content/shortcut.js). This works
// even when the browser didn't give Alt+Shift+C to the "copy-thread" command above.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'aimd-shortcut' || msg.command !== MENU.copyThread) return;
  const tab = sender.tab;
  if (tab && tab.id != null && !isRepeatedShortcut(tab.id, MENU.copyThread)) exportFromTab(tab, MENU.copyThread);
});

// If both the browser command and the page listener ever report the same key press,
// run it once.
const lastShortcut = new Map();
function isRepeatedShortcut(tabId, command) {
  const key = tabId + ':' + command;
  const now = Date.now();
  const last = lastShortcut.get(key) || 0;
  lastShortcut.set(key, now);
  return now - last < 1000;
}

// Make Alt+Shift+C work in Claude/Perplexity tabs that were already open when the
// extension was installed or updated, without reloading them.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: SUPPORTED_PATTERNS });
    for (const tab of tabs) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/shortcut.js'] }).catch(() => {});
    }
  } catch (_) { /* nothing open */ }
});

// ---------------------------------------------------------------------------
// Export flow
// ---------------------------------------------------------------------------

async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    return Object.assign({}, DEFAULT_SETTINGS, stored);
  } catch (_) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

async function exportFromTab(tab, mode) {
  const tabId = tab.id;
  if (!SUPPORTED_HOST_RE.test(tab.url || '')) {
    await notify(tabId, 'Open a Claude or Perplexity thread, or an AI answer on a supported search engine, then try again.', 'error');
    return;
  }

  const settings = await getSettings();
  let result;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (m, s) => globalThis.__aiThreadMd.run(m, s),
      args: [mode, settings]
    });
    result = injection && injection.result;
  } catch (err) {
    await flashBadge(tabId, '!', '#b91c1c');
    console.error('[AI Thread → Markdown] injection failed', err);
    return;
  }

  if (!result || !result.ok) return result;

  if (result.action === 'copy') {
    const warn = result.warnings && result.warnings.length ? '\n' + result.warnings.join('\n') : '';
    let copied = await copyInOffscreen(result.markdown);
    if (!copied) copied = await copyInPage(tabId, result.markdown);
    if (copied) {
      const chars = result.markdown.length.toLocaleString('en-US');
      await notify(tabId, 'Copied ' + result.summary + ' as Markdown (' + chars + ' characters).' + warn, warn ? 'warn' : 'ok');
    } else {
      await notify(tabId, 'Could not copy to the clipboard, so it still holds what was there before.\nTry again, or use “Save thread as Markdown”.', 'error');
    }
    return { ok: copied, action: copied ? 'copied' : 'copy-failed' };
  }

  if (result.action !== 'save') return result;

  try {
    const filename = buildDownloadPath(settings.subfolder, result.filename);
    await chrome.downloads.download({
      url: 'data:text/markdown;charset=utf-8;base64,' + utf8ToBase64(result.markdown),
      filename,
      saveAs: !!settings.saveAs,
      conflictAction: 'uniquify'
    });
    const warn = result.warnings && result.warnings.length ? '\n' + result.warnings.join('\n') : '';
    await notify(tabId, 'Saved ' + result.summary + ' to ' + result.filename + warn, warn ? 'warn' : 'ok');
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (/cancel/i.test(message)) return;
    await notify(tabId, 'Could not save the file: ' + message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

const OFFSCREEN_PAGE = 'offscreen/clipboard.html';
let offscreenOpening = null;

async function openOffscreen() {
  if (!chrome.offscreen) return false;
  if (chrome.runtime.getContexts) {
    const open = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PAGE)]
    });
    if (open.length) return true;
  }
  if (!offscreenOpening) {
    offscreenOpening = chrome.offscreen.createDocument({
      url: OFFSCREEN_PAGE,
      reasons: ['CLIPBOARD'],
      justification: 'Copy the exported Markdown to the clipboard.'
    }).catch((err) => {
      if (!/single offscreen document/i.test(String(err && err.message))) throw err;
    }).finally(() => { offscreenOpening = null; });
  }
  await offscreenOpening;
  return true;
}

/** Copy from the extension's own hidden page. Returns true once the text is on the clipboard. */
async function copyInOffscreen(text) {
  try {
    if (!(await openOffscreen())) return false;
    const reply = await chrome.runtime.sendMessage({ target: 'aimd-offscreen', type: 'copy', text });
    return !!(reply && reply.ok);
  } catch (err) {
    console.warn('[AI Thread → Markdown] offscreen copy failed', err);
    return false;
  } finally {
    chrome.offscreen && chrome.offscreen.closeDocument().catch(() => {});
  }
}

/** Fallback for browsers without offscreen documents: copy from the page itself. */
async function copyInPage(tabId, text) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (t) => globalThis.__aiThreadMd.copyText(t),
      args: [text]
    });
    return !!(injection && injection.result);
  } catch (_) {
    return false;
  }
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function buildDownloadPath(subfolder, filename) {
  const parts = String(subfolder || '')
    .split(/[\\/]+/)
    .map((p) => p.replace(/[\u0000-\u001f<>:"|?*]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, ''))
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.concat(filename).join('/');
}

async function notify(tabId, message, kind) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg, k) => globalThis.__aiThreadMd.toast(msg, k),
      args: [message, kind]
    });
    if (kind === 'error') await flashBadge(tabId, '!', '#b91c1c');
  } catch (_) {
    // Pages such as brave:// or the Web Store cannot be scripted; use the badge instead.
    await flashBadge(tabId, kind === 'error' ? '!' : '✓', kind === 'error' ? '#b91c1c' : '#15803d');
  }
}

async function flashBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 4000);
  } catch (_) { /* tab may be gone */ }
}
