/*
 * AI Thread → Markdown — page-side entry point.
 *
 * The background worker injects markdown.js, extractors.js and this file, then
 * calls __aiThreadMd.run(mode, settings), which returns the Markdown. The background
 * worker saves it (chrome.downloads) or copies it (offscreen page); on-page notices
 * are shown from here.
 */
(function (global) {
  'use strict';

  const AIMD = global.__AIMD;
  const X = global.__AIMD_EXTRACTORS;

  const DEFAULTS = {
    frontMatter: true,
    nestHeadings: true,
    includeCitations: true,
    includeThinking: true,
    saveAs: false,
    subfolder: ''
  };

  const ROLE_USER = 'User';

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  function pad(n) { return String(n).padStart(2, '0'); }

  function localDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function localIso(d) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return localDate(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
      sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
  }

  function yamlString(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
  }

  function sanitizeFilename(name) {
    let s = String(name || '')
      .replace(/[\u0000-\u001f\u007f<>:"\/\\|?*]+/g, ' ')
      .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, '');
    if (s.length > 120) s = s.slice(0, 120).replace(/[\s.]+$/, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
    return s || 'thread';
  }

  function headingText(title) {
    return AIMD.escapeText(String(title).replace(/\s+/g, ' ').trim()).replace(/ (#+)$/, ' \\$1');
  }

  function buildDocument(data, site, settings, now, url) {
    const title = data.title || site.name + ' thread';
    const parts = [];
    if (settings.frontMatter) {
      parts.push([
        '---',
        'title: ' + yamlString(title),
        'source: ' + yamlString(url),
        'platform: ' + site.name,
        'exported: ' + localIso(now),
        'messages: ' + data.messages.length,
        '---'
      ].join('\n'));
    }
    parts.push('# ' + headingText(title));
    for (const m of data.messages) {
      parts.push('## ' + (m.role === 'user' ? ROLE_USER : site.name));
      parts.push(m.markdown && m.markdown.trim() ? m.markdown.trim() : '*(empty message)*');
    }
    return parts.join('\n\n') + '\n';
  }

  function buildFilename(title, site, now, suffix) {
    return sanitizeFilename(localDate(now) + ' ' + site.name + ' - ' + (title || 'thread') + (suffix || '')) + '.md';
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  function closestElement(node, selector) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el ? el.closest(selector) : null;
  }

  function selectionToMarkdown(site, settings) {
    const sel = global.getSelection && global.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'false');
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:900px;pointer-events:none;opacity:0;';
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const frag = range.cloneContents();
      const pre = closestElement(range.commonAncestorContainer, 'pre');
      if (pre) {
        // A selection inside one code block: keep it a code block with its language.
        const newPre = document.createElement('pre');
        const code = document.createElement('code');
        const source = pre.querySelector('code[class*="language-"]') || pre;
        const m = /(?:^|\s)language-([\w#+.\-]+)/.exec(source.getAttribute('class') || '');
        if (m) code.className = 'language-' + m[1];
        code.appendChild(frag);
        newPre.appendChild(code);
        holder.appendChild(newPre);
      } else {
        holder.appendChild(frag);
      }
    }
    document.body.appendChild(holder);
    try {
      const sources = [];
      const handlers = site ? site.handlers(settings, sources) : [];
      let md = new AIMD.Converter({ handlers }).convert(holder);
      if (sources.length && settings.includeCitations) {
        md += '\n\n**Sources**\n\n' + sources.map((s, i) => (i + 1) + '. [' + AIMD.escapeText(s.label, { inLink: true }) + '](' + AIMD.formatUrl(s.url) + ')').join('\n');
      }
      return md;
    } finally {
      holder.remove();
    }
  }

  // ---------------------------------------------------------------------------
  // Clipboard and notices
  // ---------------------------------------------------------------------------

  /**
   * Fallback copy from inside the page (the background worker normally copies from
   * the extension's own hidden page). Only reports success when the text was
   * actually handed to the clipboard.
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall back below */ }

    // The copy event lets us put the text on the clipboard ourselves and confirms
    // that the browser actually ran the copy; the page's own copy handlers are
    // kept out of it.
    let delivered = false;
    const onCopy = (event) => {
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      event.stopImmediatePropagation();
      delivered = true;
    };
    const previous = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-100000px;top:0;opacity:0;';
    document.body.appendChild(ta);
    global.addEventListener('copy', onCopy, true);
    try {
      ta.focus();
      ta.select();
      document.execCommand('copy');
    } catch (_) {
      delivered = false;
    } finally {
      global.removeEventListener('copy', onCopy, true);
      ta.remove();
      if (previous && previous.focus) {
        try { previous.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
      }
    }
    return delivered;
  }

  const TOAST_ID = 'ai-thread-md-toast';

  function toast(message, kind) {
    try {
      const old = document.getElementById(TOAST_ID);
      if (old) old.remove();
      const host = document.createElement('div');
      host.id = TOAST_ID;
      host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const color = kind === 'error' ? '#f87171' : kind === 'warn' ? '#fbbf24' : '#4ade80';
      shadow.innerHTML =
        '<style>' +
        '.t{font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f4f4f5;background:#18181b;' +
        'border:1px solid #3f3f46;border-radius:10px;padding:10px 14px 10px 12px;max-width:380px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:flex-start;' +
        'opacity:0;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease}' +
        '.t.on{opacity:1;transform:none}' +
        '.d{flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px;background:' + color + '}' +
        '.m{white-space:pre-line;word-break:break-word}' +
        '</style><div class="t" role="status"><span class="d"></span><span class="m"></span></div>';
      shadow.querySelector('.m').textContent = message;
      document.documentElement.appendChild(host);
      const card = shadow.querySelector('.t');
      requestAnimationFrame(() => card.classList.add('on'));
      setTimeout(() => {
        card.classList.remove('on');
        setTimeout(() => host.remove(), 250);
      }, kind === 'error' ? 6500 : 3500);
    } catch (_) { /* never break the page */ }
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  function fail(message) {
    toast(message, 'error');
    return { ok: false, error: message };
  }

  /**
   * @param {'save-thread'|'copy-thread'|'save-selection'|'copy-selection'} mode
   * @param {object} userSettings
   */
  async function run(mode, userSettings) {
    const settings = Object.assign({}, DEFAULTS, userSettings || {});
    const site = X.detectSite(global.location);
    const now = new Date();
    const url = global.location.href;
    try {
      let markdown;
      let filename;
      let summary;
      let warnings = [];

      if (mode === 'save-selection' || mode === 'copy-selection') {
        markdown = selectionToMarkdown(site, settings);
        if (!markdown) return fail('Select some text on the page first.');
        markdown += '\n';
        const cleanTitle = String(document.title || '').replace(/\s*[-–—|·]\s*(Claude|Perplexity|Google|Bing|Brave Search|Brave|DuckDuckGo|You\.com|Kagi)(\s+AI)?\s*$/i, '').trim();
        filename = buildFilename(cleanTitle || 'selection', site || { name: 'Page' }, now, ' (selection)');
        summary = 'selection';
      } else {
        if (!site) return fail('This page is not a supported AI thread or search result.');
        const data = site.extract(document, settings);
        if (!data.messages.length) {
          return fail('No messages found on this page.\nOpen a ' + site.name + ' conversation or AI answer, or the site layout may have changed.');
        }
        warnings = data.warnings || [];
        markdown = buildDocument(data, site, settings, now, url);
        filename = buildFilename(data.title, site, now);
        summary = data.messages.length + ' message' + (data.messages.length === 1 ? '' : 's');
      }

      // The background worker does the saving and the copying.
      const action = mode === 'copy-thread' || mode === 'copy-selection' ? 'copy' : 'save';
      return { ok: true, action, markdown, filename, summary, warnings };
    } catch (err) {
      return fail('Export failed: ' + (err && err.message ? err.message : String(err)));
    }
  }

  global.__aiThreadMd = { run, toast, copyText, buildDocument, buildFilename, sanitizeFilename, DEFAULTS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
