/*
 * AI Thread → Markdown — clipboard writer.
 *
 * Runs in the extension's own hidden (offscreen) page, so copying never depends on
 * the web page: not on whether the page has focus, not on its clipboard
 * permissions, and not on any copy handlers the site installs.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'aimd-offscreen' || msg.type !== 'copy') return;
  sendResponse({ ok: writeClipboard(String(msg.text)) });
});

function writeClipboard(text) {
  const scratch = document.getElementById('scratch');
  let delivered = false;
  const onCopy = (event) => {
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    delivered = true;
  };
  document.addEventListener('copy', onCopy, true);
  try {
    // Select the same text as well, so the default copy action carries it even if
    // the copy event were skipped.
    scratch.value = text;
    scratch.select();
    const ran = document.execCommand('copy');
    return delivered || ran;
  } catch (_) {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
    scratch.value = '';
  }
}
