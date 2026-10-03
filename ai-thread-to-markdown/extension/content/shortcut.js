/*
 * AI Thread → Markdown — Alt+Shift+C on Claude and Perplexity pages.
 *
 * Browsers don't reliably give Alt+Shift+C to an extension's keyboard command
 * (Chromium refuses it as a suggested shortcut), so the page listens for it too and
 * asks the background worker to copy the thread. When the browser does have the key
 * bound to the command, it handles the key itself and this listener never sees it.
 */
(() => {
  if (window.__aimdCopyShortcut) return;
  window.__aimdCopyShortcut = true;

  window.addEventListener('keydown', (event) => {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (event.code !== 'KeyC' && String(event.key).toLowerCase() !== 'c') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    try {
      const sent = chrome.runtime.sendMessage({ type: 'aimd-shortcut', command: 'copy-thread' });
      if (sent && sent.catch) sent.catch(() => {});
    } catch (_) {
      // The extension was reloaded; this old copy of the listener is no longer connected.
    }
  }, true);
})();
