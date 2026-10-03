/*
 * AI Thread → Markdown — HTML-to-Markdown converter.
 *
 * Runs in the page (isolated content-script world) and in Node tests (jsdom).
 * Wrapped in an IIFE so it can be injected repeatedly without redeclaration errors.
 *
 * Design notes
 * - Block structure is tracked with explicit leading/trailing newline markers on
 *   each block piece; `joinBlocks` merges neighbours and never emits more than one
 *   blank line, without ever touching the inside of a code block.
 * - Code is read with `codeText`, which walks raw text nodes and only inserts a
 *   line break at a block boundary when one is not already there. This is what
 *   keeps code blocks free of the doubled newlines `innerText` produces.
 * - Copy buttons, language labels and line-number gutters are recognised as code
 *   block "chrome" and never leak into the output.
 */
(function (global) {
  'use strict';

  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;

  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details',
    'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'menu', 'nav',
    'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
    'tr', 'ul', 'legend'
  ]);

  // Inline elements whose meaning we render explicitly.
  const INLINE_TAGS = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i',
    'img', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'strike', 'strong', 'sub', 'sup',
    'time', 'tt', 'u', 'var', 'wbr', 'label', 'font'
  ]);

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'button', 'svg', 'input', 'select', 'textarea',
    'iframe', 'object', 'embed', 'canvas', 'audio', 'video', 'link', 'meta', 'head', 'title',
    'dialog', 'form', 'nav', 'progress', 'meter', 'datalist', 'output'
  ]);

  const SKIP_ROLES = new Set(['button', 'toolbar', 'menu', 'menubar', 'tooltip', 'progressbar']);

  const BLOCK_SELECTOR = 'address,article,aside,blockquote,dd,details,div,dl,dt,figure,footer,' +
    'h1,h2,h3,h4,h5,h6,header,hr,li,main,ol,p,pre,section,table,ul';

  // Elements that can sit between a <pre> and the prose around it (wrappers that hold
  // the language label and copy button).
  const PROSE_SELECTOR = 'p,ul,ol,li,table,blockquote,h1,h2,h3,h4,h5,h6,hr,dl';

  const LANGUAGE_RE = /^[a-z][\w#+.\-]{0,24}$/i;
  const KNOWN_LANGUAGES = new Set((
    'bash sh shell zsh fish powershell ps1 cmd bat batch python py javascript js jsx typescript ts tsx ' +
    'json jsonc yaml yml toml ini xml html css scss sass less sql plsql graphql gql java kotlin kt scala ' +
    'groovy c cpp c++ csharp cs c# objective-c objc swift go golang rust rs ruby rb php perl lua r julia ' +
    'dart elixir erlang haskell hs clojure ocaml fsharp f# vb vbnet matlab latex tex markdown md diff ' +
    'patch dockerfile docker makefile make cmake nginx apache terraform hcl solidity zig nim crystal ' +
    'vue svelte text plaintext txt console output log csv protobuf proto assembly asm wasm regex http ' +
    'mermaid prisma jinja handlebars twig astro elm fortran cobol pascal ada prolog lisp scheme racket'
  ).split(' '));
  const LABEL_STOPWORDS = new Set([
    'copy', 'copied', 'copy code', 'code', 'edit', 'run', 'wrap', 'unwrap', 'download',
    'preview', 'expand', 'collapse', 'show more', 'show less', 'view', 'open', 'apply', 'insert'
  ]);

  const LINE_NUMBER_RE = /(^|\s)(linenumber|line-number|line-numbers|linenumbers|react-syntax-highlighter-line-number|hljs-ln-n|hljs-ln-numbers|code-line-number|gutter)(\s|$)/i;

  const ZERO_WIDTH_RE = /[\u200b\ufeff\u2060]/g;

  // ---------------------------------------------------------------------------
  // Small string helpers
  // ---------------------------------------------------------------------------

  function leadingNewlines(s) {
    const m = /^[ \t]*(\n*)/.exec(s);
    return m ? m[1].length : 0;
  }

  function trailingNewlines(s) {
    const m = /(\n*)[ \t]*$/.exec(s);
    return m ? m[1].length : 0;
  }

  function trimNewlines(s) {
    return s.replace(/^[\s]*\n/, '').replace(/\n[\s]*$/, '').replace(/^[ \t]+|[ \t]+$/g, '');
  }

  /** Join two block-level pieces, keeping at most one blank line between them. */
  function joinBlocks(out, piece) {
    if (!piece) return out;
    if (!out) return piece;
    const t = trailingNewlines(out);
    const l = leadingNewlines(piece);
    const sep = Math.min(2, Math.max(t, l));
    const left = out.replace(/[ \t]*\n*[ \t]*$/, '');
    const right = piece.replace(/^[ \t]*\n*/, '');
    if (sep === 0) return left + right;
    return left + '\n'.repeat(sep) + right.replace(/^[ \t]+/, '');
  }

  /** Join two inline pieces without producing runs of spaces. */
  function joinInline(a, b) {
    if (!b) return a;
    if (!a) return b;
    if (/[ \n]$/.test(a) && /^ /.test(b)) return a + b.replace(/^ +/, '');
    return a + b;
  }

  function ensureWrap(s, n) {
    if (!s) return s;
    const nl = '\n'.repeat(n);
    if (leadingNewlines(s) === 0) s = nl + s.replace(/^[ \t]+/, '');
    if (trailingNewlines(s) === 0) s = s.replace(/[ \t]+$/, '') + nl;
    return s;
  }

  function isWordChar(ch) {
    return !!ch && /[\p{L}\p{N}]/u.test(ch);
  }

  /** Escape characters in plain text that Markdown would otherwise interpret. */
  function escapeText(s, ctx) {
    if (!s) return s;
    s = s.replace(/\\(?=[!-\/:-@\[-`{-~])/g, '\\\\');
    s = s.replace(/`/g, '\\`');
    s = s.replace(/\*/g, (m, i, str) => (str[i - 1] === ' ' && str[i + 1] === ' ') ? m : '\\*');
    s = s.replace(/_/g, (m, i, str) => (isWordChar(str[i - 1]) && isWordChar(str[i + 1])) ? m : '\\_');
    if (s.indexOf('~') !== s.lastIndexOf('~')) s = s.replace(/~/g, '\\~');
    if (ctx && ctx.inLink) {
      s = s.replace(/([\[\]])/g, '\\$1');
    } else {
      s = s.replace(/\[([^\]\n]*)\](?=[(\[:])/g, '\\[$1\\]');
    }
    s = s.replace(/<(?=[A-Za-z\/!?])/g, '\\<');
    s = s.replace(/&(?=#?[A-Za-z0-9]+;)/g, '&amp;');
    return s;
  }

  /** Escape block syntax that would be triggered at the start of a line. */
  function escapeLineStart(line) {
    return line
      .replace(/^(#{1,6})(?=[ \t]|$)/, '\\$1')
      .replace(/^([-+*])(?=[ \t])/, '\\$1')
      .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, '$1\\$2')
      .replace(/^>/, '\\>')
      .replace(/^(=+|-+)[ \t]*$/, '\\$1')
      .replace(/^(~{3,})/, '\\$1')
      .replace(/^\|/, '\\|');
  }

  /** Clean up an inline run once it is known to form its own block. */
  function finishInline(run, opts) {
    if (!run) return '';
    let s = run;
    s = s.replace(/[ \t]+\\\n/g, '\\\n').replace(/\\\n[ \t]+/g, '\\\n');
    s = s.replace(/[ \t]*\n[ \t]*/g, '\n');
    s = s.replace(/^(\s|\\\n)+/, '');
    s = s.replace(/(\s*\\\n)+\s*$/, '').replace(/\s+$/, '');
    if (!s) return '';
    if (!opts || !opts.noLineEscape) {
      s = s.split('\n').map(escapeLineStart).join('\n');
    }
    return s;
  }

  function inlineCode(text) {
    text = text.replace(ZERO_WIDTH_RE, '').replace(/\u00a0/g, ' ').replace(/\r?\n/g, ' ');
    if (!text) return '';
    const runs = text.match(/`+/g) || [];
    const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
    const fence = '`'.repeat(longest + 1);
    const needsPad = /^`|`$/.test(text) || (/^ /.test(text) && / $/.test(text) && text.trim() !== '');
    const pad = needsPad ? ' ' : '';
    return fence + pad + text + pad + fence;
  }

  function wrapDelimited(inner, delim) {
    if (!inner || !inner.trim()) return inner ? ' ' : '';
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    const lead = m[1] ? ' ' : '';
    const trail = m[3] ? ' ' : '';
    return lead + delim + m[2] + delim + trail;
  }

  function formatUrl(url) {
    let u = String(url).trim().replace(/ /g, '%20');
    let depth = 0;
    let balanced = true;
    for (const ch of u) {
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth < 0) balanced = false; }
    }
    if (depth !== 0) balanced = false;
    if (!balanced || /[<>\s]/.test(u)) return '<' + u.replace(/[<>]/g, encodeURIComponent) + '>';
    return u;
  }

  /** Normalise code text: line endings, invisible characters, trailing spaces, edge blank lines. */
  function normalizeCode(s) {
    s = s.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(ZERO_WIDTH_RE, '');
    s = s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
    return s.replace(/^\n+/, '').replace(/\n+$/, '');
  }

  function backtickFence(text) {
    const runs = text.match(/^ {0,3}`{3,}|`{3,}/gm) || [];
    const longest = runs.reduce((m, r) => Math.max(m, r.trim().length), 0);
    return '`'.repeat(Math.max(3, longest + 1));
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function viewOf(el) {
    return (el && el.ownerDocument && el.ownerDocument.defaultView) || null;
  }

  function computedStyle(el) {
    if (!el || !el.isConnected) return null;
    const win = viewOf(el);
    if (!win || !win.getComputedStyle) return null;
    try { return win.getComputedStyle(el); } catch (_) { return null; }
  }

  function classString(el) {
    const c = el.getAttribute && el.getAttribute('class');
    return c || '';
  }

  /** Number of non-whitespace characters in an element's text. */
  function visibleLength(el) {
    return (el.textContent || '').replace(/\s+/g, '').length;
  }

  /**
   * Make text a person typed safe to embed in Markdown without changing how it
   * reads: HTML-looking tags outside code are escaped (an unclosed "<div" or
   * "<!--" would otherwise swallow the rest of the file) and an unclosed code
   * fence is closed.
   */
  function protectVerbatim(text) {
    const lines = text.split('\n');
    const out = [];
    let fence = null;
    for (const line of lines) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        out.push(line);
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
        continue;
      }
      if (m && !(m[1][0] === '`' && line.slice(line.indexOf(m[1]) + m[1].length).includes('`'))) {
        fence = m[1];
        out.push(line);
        continue;
      }
      // Escape "<tag" outside inline code spans.
      const parts = line.split(/(`+)/);
      let open = null;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (/^`+$/.test(p)) {
          if (open === null) {
            const closes = parts.slice(i + 1).some((q) => q === p);
            if (closes) open = p;
          } else if (p === open) {
            open = null;
          }
          continue;
        }
        if (open === null) parts[i] = p.replace(/<(?=[A-Za-z\/!?])/g, '\\<');
      }
      out.push(parts.join(''));
    }
    if (fence) out.push(fence);
    return out.join('\n');
  }

  function isHidden(el) {
    if (el.hidden) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const cls = classString(el);
    if (/(^|\s)(sr-only|visually-hidden|screen-reader-only)(\s|$)/.test(cls)) return true;
    const inline = el.style;
    if (inline && (inline.display === 'none' || inline.visibility === 'hidden')) return true;
    const cs = computedStyle(el);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true;
    return false;
  }

  function isBlockDisplay(display) {
    return /^(block|flex|grid|list-item|table|flow-root|table-row|table-row-group)$/.test(display || '');
  }

  function whiteSpaceOf(el) {
    const cs = computedStyle(el);
    if (cs && cs.whiteSpace) return cs.whiteSpace;
    const inline = el.style && el.style.whiteSpace;
    if (inline) return inline;
    const cls = classString(el);
    const m = /(^|\s)whitespace-(pre-wrap|pre-line|pre|break-spaces)(\s|$)/.exec(cls);
    return m ? m[2] : '';
  }

  function isPreservingWhiteSpace(ws) {
    return /^(pre|pre-wrap|pre-line|break-spaces)$/.test(ws || '');
  }

  function documentOrder(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    // DOCUMENT_POSITION_FOLLOWING = 4, DOCUMENT_POSITION_PRECEDING = 2
    if (pos & 4) return -1;
    if (pos & 2) return 1;
    return 0;
  }

  /** Keep only elements that are not nested inside another element of the list. */
  function outermost(elements) {
    const list = Array.from(new Set(elements)).sort(documentOrder);
    const result = [];
    for (const el of list) {
      const last = result[result.length - 1];
      if (last && last.contains(el)) continue;
      result.push(el);
    }
    return result;
  }

  function isCodeChrome(el) {
    const tag = el.localName;
    if (tag === 'button' || tag === 'svg' || tag === 'style' || tag === 'script' || tag === 'input') return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('data-line-number') && !el.textContent.includes('\n') && /^\s*\d+\s*$/.test(el.textContent)) return true;
    if (LINE_NUMBER_RE.test(classString(el))) return true;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return true;
    const st = el.style;
    if (st && (st.userSelect === 'none' || st.webkitUserSelect === 'none') && /^\s*\d*\s*$/.test(el.textContent)) return true;
    if (st && st.display === 'none') return true;
    const cs = computedStyle(el);
    if (cs && cs.display === 'none') return true;
    if (el.matches && el.matches('[data-testid="code-language-indicator"],[data-testid*="copy"]')) return true;
    return false;
  }

  function isLineBlock(el) {
    const tag = el.localName;
    if (tag === 'div' || tag === 'p' || tag === 'li' || tag === 'tr' || tag === 'pre' || tag === 'section') return true;
    const inlineDisplay = el.style && el.style.display;
    if (inlineDisplay) return isBlockDisplay(inlineDisplay);
    const cs = computedStyle(el);
    return !!(cs && isBlockDisplay(cs.display));
  }

  /**
   * Read the text of a code element exactly as it would be copied.
   *
   * Text nodes are taken verbatim. A newline is inserted at a block boundary only
   * when the text does not already end with one, and a newline we inserted ourselves
   * is merged with a literal "\n" text node that follows it. Both rules prevent the
   * doubled blank lines that innerText produces for highlighted code.
   */
  function codeText(root, skip) {
    let out = '';
    let synthetic = false;

    const append = (text) => {
      if (!text) return;
      if (synthetic && text[0] === '\n') text = text.slice(1);
      synthetic = false;
      out += text;
    };
    const boundary = () => {
      if (out && !out.endsWith('\n')) { out += '\n'; synthetic = true; }
    };

    const walk = (node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === TEXT_NODE) { append(child.data); continue; }
        if (child.nodeType !== ELEMENT_NODE) continue;
        if (child.localName === 'br') { out += '\n'; synthetic = false; continue; }
        if (isCodeChrome(child) || (skip && skip(child))) continue;
        const block = isLineBlock(child);
        if (block) boundary();
        const before = out.length;
        walk(child);
        if (block) {
          if (out.length === before && child.childNodes.length === 0) { out += '\n'; synthetic = true; }
          else boundary();
        }
      }
    };

    if (root.nodeType === TEXT_NODE) return normalizeCode(root.data);
    walk(root);
    return normalizeCode(out);
  }

  function languageFromClass(el) {
    const cls = classString(el);
    const m = /(?:^|\s)(?:language|lang)-([\w#+.\-]+)/i.exec(cls);
    if (m) return m[1];
    const data = el.getAttribute && (el.getAttribute('data-language') || el.getAttribute('data-lang'));
    return data || '';
  }

  const EXTENSION_LANGUAGE = {
    py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
    rb: 'ruby', rs: 'rust', sh: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown', kt: 'kotlin',
    cs: 'csharp', h: 'c', hpp: 'cpp', cc: 'cpp', ps1: 'powershell', txt: 'text', htm: 'html'
  };

  function cleanLanguage(lang) {
    if (!lang) return '';
    lang = String(lang).trim();
    if (!LANGUAGE_RE.test(lang)) return '';
    if (LABEL_STOPWORDS.has(lang.toLowerCase())) return '';
    if (/^[\w\-]+\.[a-z0-9]{1,5}$/i.test(lang)) {
      // A file name such as "main.py" — use its extension.
      const ext = lang.split('.').pop().toLowerCase();
      return EXTENSION_LANGUAGE[ext] || ext;
    }
    return lang.toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Converter
  // ---------------------------------------------------------------------------

  class Converter {
    /**
     * @param {object} [options]
     * @param {Array<Function>} [options.handlers] (el, ctx, converter) => string | undefined.
     *        Return a string to replace the element, '' to drop it, undefined to fall through.
     * @param {number} [options.headingShift] Levels to add to every heading (capped at h6).
     */
    constructor(options) {
      options = options || {};
      this.handlers = options.handlers || [];
      this.headingShift = options.headingShift || 0;
      this.codeRoots = new Map();
    }

    convert(root) {
      if (!root) return '';
      this.indexCodeBlocks(root);
      const ctx = { inLink: false, inTable: false, inListItem: false, bold: false, italic: false, strike: false, preLine: false };
      let md;
      if (root.nodeType === ELEMENT_NODE && this.codeRoots.has(root)) {
        md = this.codeBlock(root, this.codeRoots.get(root));
      } else if (root.nodeType === ELEMENT_NODE && root.localName !== 'body' && root.localName !== 'html' && root.parentNode && root.parentNode.nodeType === ELEMENT_NODE) {
        md = this.blockElement(root, ctx);
      } else {
        md = this.blockChildren(root, ctx);
      }
      return trimNewlines(md || '');
    }

    /** Find every <pre> and the outermost wrapper that only adds chrome around it. */
    indexCodeBlocks(root) {
      if (root.nodeType !== ELEMENT_NODE && root.nodeType !== 11) return;
      if (root.nodeType === ELEMENT_NODE && root.localName === 'pre') {
        this.codeRoots.set(root, root);
        return;
      }
      const pres = root.querySelectorAll('pre');
      for (const pre of pres) {
        if (pre.parentElement && pre.parentElement.closest('pre')) continue;
        let top = pre;
        for (let cur = pre.parentElement; cur && cur !== root; cur = cur.parentElement) {
          const tag = cur.localName;
          if (!(tag === 'div' || tag === 'span' || tag === 'figure' || tag.indexOf('-') !== -1)) break;
          if (cur.querySelectorAll('pre').length !== 1) break;
          if (cur.querySelector(PROSE_SELECTOR)) break;
          const residual = visibleLength(cur) - visibleLength(pre);
          if (residual > 60) break;
          top = cur;
        }
        this.codeRoots.set(top, pre);
      }
    }

    runHandlers(el, ctx) {
      for (const h of this.handlers) {
        const r = h(el, ctx, this);
        if (r !== undefined && r !== null) return r;
      }
      return undefined;
    }

    /** 'skip' | 'block' | 'inline' */
    classify(el) {
      if (this.codeRoots.has(el)) return 'block';
      const tag = el.localName;
      if (SKIP_TAGS.has(tag)) return 'skip';
      const role = el.getAttribute('role');
      if (role && SKIP_ROLES.has(role)) return 'skip';
      const cls = classString(el);
      if (/(^|\s)katex-display(\s|$)/.test(cls)) return isHidden(el) ? 'skip' : 'block';
      if (/(^|\s)katex(\s|$)/.test(cls)) return 'inline';
      if (isHidden(el)) return 'skip';
      if (BLOCK_TAGS.has(tag)) return 'block';
      if (INLINE_TAGS.has(tag)) return 'inline';
      const cs = computedStyle(el);
      if (cs && isBlockDisplay(cs.display)) return 'block';
      if (el.firstElementChild && el.querySelector(BLOCK_SELECTOR)) return 'block';
      return 'inline';
    }

    // ---- block context -------------------------------------------------------

    blockChildren(el, ctx) {
      let out = '';
      let run = '';
      const flush = () => {
        const text = finishInline(run);
        if (text) out = joinBlocks(out, text);
        run = '';
      };
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === TEXT_NODE) { run = joinInline(run, this.text(child, ctx)); continue; }
        if (child.nodeType !== ELEMENT_NODE) continue;
        const handled = this.runHandlers(child, ctx);
        if (handled !== undefined) {
          if (/\n/.test(handled.trim()) || this.classify(child) === 'block') { flush(); out = joinBlocks(out, ensureWrap(handled, 2)); }
          else run = joinInline(run, handled);
          continue;
        }
        const kind = this.classify(child);
        if (kind === 'skip') continue;
        if (kind === 'inline') { run = joinInline(run, this.inlineElement(child, ctx)); continue; }
        flush();
        const piece = this.blockElement(child, ctx);
        if (piece && piece.trim()) out = joinBlocks(out, piece);
      }
      flush();
      return out;
    }

    blockElement(el, ctx) {
      if (this.codeRoots.has(el)) return this.codeBlock(el, this.codeRoots.get(el));
      const handled = this.runHandlers(el, ctx);
      if (handled !== undefined) return ensureWrap(handled, 2);

      const cls = classString(el);
      if (/(^|\s)katex-display(\s|$)/.test(cls)) {
        const tex = this.tex(el);
        if (tex !== null) return '\n\n$$\n' + tex + '\n$$\n\n';
      }

      const tag = el.localName;
      switch (tag) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          return this.heading(el, ctx);
        case 'ul': case 'ol':
          return this.list(el, ctx);
        case 'li':
          return '\n\n' + this.listItem(el, '- ', ctx) + '\n\n';
        case 'pre':
          return this.codeBlock(el, el);
        case 'blockquote':
          return this.blockquote(el, ctx);
        case 'table':
          return this.table(el, ctx);
        case 'hr':
          return '\n\n---\n\n';
        case 'summary': {
          const text = finishInline(this.inlineChildren(el, ctx).replace(/\s*\n\s*/g, ' '));
          return text ? '\n\n**' + text + '**\n\n' : '';
        }
        default:
          return this.container(el, ctx);
      }
    }

    container(el, ctx) {
      const ws = whiteSpaceOf(el);
      const childCtx = isPreservingWhiteSpace(ws) ? Object.assign({}, ctx, { preLine: true }) : (ws ? Object.assign({}, ctx, { preLine: false }) : ctx);
      if (childCtx.preLine && this.isPlainTextBlock(el)) {
        const text = codeText(el);
        return text ? '\n\n' + protectVerbatim(text) + '\n\n' : '';
      }
      const inner = this.blockChildren(el, childCtx);
      return ensureWrap(inner, 2);
    }

    /** True if el only contains text, <br> and unstyled spans (e.g. a typed user message). */
    isPlainTextBlock(el) {
      if (!/\n/.test(el.textContent || '')) return false;
      const all = el.getElementsByTagName('*');
      for (const d of all) {
        const t = d.localName;
        if (t !== 'br' && t !== 'span' && t !== 'wbr') return false;
      }
      return true;
    }

    heading(el, ctx) {
      const level = Math.min(6, Math.max(1, Number(el.localName[1]) + this.headingShift));
      let text = this.inlineChildren(el, ctx).replace(/\\\n/g, ' ').replace(/\s*\n\s*/g, ' ');
      text = finishInline(text, { noLineEscape: true });
      if (!text) return '';
      text = text.replace(/ (#+)$/, ' \\$1');
      return '\n\n' + '#'.repeat(level) + ' ' + text + '\n\n';
    }

    list(el, ctx) {
      const ordered = el.localName === 'ol';
      let n = 1;
      if (ordered) {
        const start = parseInt(el.getAttribute('start'), 10);
        if (!isNaN(start)) n = start;
      }
      const items = [];
      let loose = false;
      for (const child of Array.from(el.children)) {
        if (this.classify(child) === 'skip') continue;
        if (child.localName !== 'li') {
          // Invalid but common: a nested list placed directly inside <ul>/<ol>.
          const piece = trimNewlines(this.blockElement(child, Object.assign({}, ctx, { inListItem: true })));
          if (!piece) continue;
          if (items.length) {
            const indent = ' '.repeat(items[items.length - 1].markerWidth);
            items[items.length - 1].text += '\n' + piece.split('\n').map((l) => (l ? indent + l : '')).join('\n');
          } else {
            items.push({ text: piece, markerWidth: 0 });
          }
          continue;
        }
        // Keep lists tight unless an item really holds several blocks (e.g. two
        // paragraphs, or a paragraph and a code block).
        const blockKids = Array.from(child.children).filter((k) => k.localName === 'p' || k.localName === 'pre' || this.codeRoots.has(k) || k.localName === 'blockquote' || k.localName === 'table');
        const multiBlock = blockKids.length > 1;
        if (multiBlock) loose = true;
        const marker = ordered ? (n++) + '. ' : '- ';
        const tight = !multiBlock && !child.querySelector('pre');
        items.push({ text: this.listItem(child, marker, ctx, tight), markerWidth: marker.length });
      }
      if (!items.length) return '';
      const body = items.map((i) => i.text).join(loose ? '\n\n' : '\n');
      const sep = ctx.inListItem ? 1 : 2;
      return '\n'.repeat(sep) + body + '\n'.repeat(sep);
    }

    listItem(li, marker, ctx, tight) {
      const itemCtx = Object.assign({}, ctx, { inListItem: true });
      let body = trimNewlines(this.blockChildren(li, itemCtx));
      // A single paragraph followed by a nested list stays tight ("text\n  - sub").
      if (tight) body = body.replace(/\n{2,}/g, '\n');
      let prefix = '';
      const box = li.querySelector('input[type="checkbox"]');
      if (box && box.closest('li') === li) prefix = box.checked || box.hasAttribute('checked') ? '[x] ' : '[ ] ';
      if (!body && !prefix) return marker.trimEnd();
      const indent = ' '.repeat(marker.length);
      const lines = (prefix + body).split('\n');
      return marker + lines[0] + lines.slice(1).map((l) => '\n' + (l ? indent + l : '')).join('');
    }

    blockquote(el, ctx) {
      const body = trimNewlines(this.blockChildren(el, Object.assign({}, ctx, { inListItem: false })));
      if (!body) return '';
      return '\n\n' + body.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n') + '\n\n';
    }

    table(el, ctx) {
      const rows = Array.from(el.querySelectorAll('tr')).filter((tr) => tr.closest('table') === el && this.classify(tr) !== 'skip');
      if (!rows.length) return this.container(el, ctx);
      const cellCtx = Object.assign({}, ctx, { inTable: true, inListItem: false });
      const matrix = rows.map((tr) => Array.from(tr.children)
        .filter((c) => c.localName === 'td' || c.localName === 'th')
        .map((c) => this.cell(c, cellCtx)));
      const cols = Math.max(...matrix.map((r) => r.length));
      if (!cols) return '';
      const headerCells = Array.from(rows[0].children).filter((c) => c.localName === 'td' || c.localName === 'th');
      const align = [];
      for (let i = 0; i < cols; i++) {
        const c = headerCells[i];
        let a = '';
        if (c) a = (c.getAttribute('align') || (c.style && c.style.textAlign) || '').toLowerCase();
        align.push(a);
      }
      for (const r of matrix) while (r.length < cols) r.push('');
      const widths = [];
      for (let i = 0; i < cols; i++) widths.push(Math.max(3, ...matrix.map((r) => r[i].length)));
      const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
      const line = (r) => '| ' + r.map((c, i) => pad(c, widths[i])).join(' | ') + ' |';
      const sepCell = (w, a) => {
        if (a === 'center') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
        if (a === 'right') return '-'.repeat(Math.max(2, w - 1)) + ':';
        if (a === 'left') return ':' + '-'.repeat(Math.max(2, w - 1));
        return '-'.repeat(w);
      };
      const out = [line(matrix[0]), '| ' + widths.map((w, i) => sepCell(w, align[i])).join(' | ') + ' |'];
      for (let r = 1; r < matrix.length; r++) out.push(line(matrix[r]));
      return '\n\n' + out.join('\n') + '\n\n';
    }

    cell(td, ctx) {
      let s = this.inlineChildren(td, ctx);
      s = finishInline(s, { noLineEscape: true });
      s = s.replace(/\\\n/g, '<br>').replace(/\n+/g, ' ');
      return s.replace(/\|/g, '\\|');
    }

    codeBlock(root, pre) {
      let codeEl = null;
      if (pre.localName === 'code') codeEl = pre;
      else {
        let best = -1;
        for (const c of pre.querySelectorAll('code')) {
          if (c.parentElement && c.parentElement.closest('code')) continue;
          const len = (c.textContent || '').length;
          if (len > best) { best = len; codeEl = c; }
        }
      }
      const target = codeEl || pre;
      const found = this.codeLanguage(root, pre, codeEl);
      const label = found.labelEl;
      const labelLen = label ? (label.textContent || '').length : 0;
      // Skip the label and any small header wrapper around it (label + copy button).
      const skip = label ? (el) => el === label ||
        (el.contains(label) && (el.textContent || '').length - labelLen <= 30) : null;
      const text = codeText(target, skip);
      const lang = found.lang;
      const fence = backtickFence(text);
      return '\n\n' + fence + lang + '\n' + (text ? text + '\n' : '') + fence + '\n\n';
    }

    /** @returns {{lang: string, labelEl: Element|null}} */
    codeLanguage(root, pre, codeEl) {
      // 1. class="language-xxx" on the code element, the pre, or wrappers in between.
      for (let n = codeEl || pre; n && n !== root.parentElement; n = n.parentElement) {
        const lang = cleanLanguage(languageFromClass(n));
        if (lang) return { lang, labelEl: null };
      }
      // 2. An explicit language indicator.
      const indicator = root.querySelector('[data-testid="code-language-indicator"],[data-language],[class*="language-label"],[class*="code-lang"]');
      if (indicator) {
        const lang = cleanLanguage(indicator.getAttribute('data-language') || indicator.textContent);
        if (lang) return { lang, labelEl: indicator };
      }
      // 3. A short label beside the code (e.g. "python" above the block).
      for (const el of root.querySelectorAll('*')) {
        if (el.children.length) continue;
        if (el.closest('button,svg,[role="button"]')) continue;
        if (codeEl) {
          if (codeEl.contains(el)) continue;
        } else if (pre.contains(el)) {
          // Without a <code> element, only accept a well-known language name in a
          // block-level label that opens the <pre>.
          const rest = (pre.textContent || '').trim();
          const own = (el.textContent || '').trim();
          if (el.localName !== 'div' || !KNOWN_LANGUAGES.has(own.toLowerCase()) ||
              !rest.startsWith(own) || rest.length - own.length < 2) continue;
        }
        const lang = cleanLanguage(el.textContent);
        if (lang) return { lang, labelEl: el };
      }
      return { lang: '', labelEl: null };
    }

    tex(el) {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (!ann) return null;
      return ann.textContent.trim();
    }

    // ---- inline context ------------------------------------------------------

    inlineChildren(el, ctx) {
      let s = '';
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === TEXT_NODE) { s = joinInline(s, this.text(child, ctx)); continue; }
        if (child.nodeType !== ELEMENT_NODE) continue;
        const handled = this.runHandlers(child, ctx);
        if (handled !== undefined) { s = joinInline(s, this.flatten(handled, ctx)); continue; }
        const kind = this.classify(child);
        if (kind === 'skip') continue;
        if (kind === 'block') s = joinInline(s, this.flatten(this.blockElement(child, ctx), ctx, true));
        else s = joinInline(s, this.inlineElement(child, ctx));
      }
      return s;
    }

    flatten(md, ctx, padded) {
      if (!md) return '';
      const sep = ctx.inTable ? '<br>' : ' ';
      const flat = md.trim().replace(/\s*\n+\s*/g, sep);
      return padded && flat ? ' ' + flat + ' ' : flat;
    }

    text(node, ctx) {
      let s = node.data.replace(ZERO_WIDTH_RE, '').replace(/\u00a0/g, ' ');
      if (ctx.preLine && !ctx.inTable) {
        s = s.replace(/\r\n?/g, '\n').replace(/[ \t\f]+/g, ' ');
      } else {
        s = s.replace(/[ \t\r\n\f]+/g, ' ');
      }
      return escapeText(s, ctx);
    }

    inlineElement(el, ctx) {
      const handled = this.runHandlers(el, ctx);
      if (handled !== undefined) return handled;

      const cls = classString(el);
      if (/(^|\s)katex(\s|$)/.test(cls) || el.localName === 'math') {
        const tex = this.tex(el);
        if (tex !== null) return '$' + tex + '$';
        if (el.localName === 'math') return escapeText(el.textContent.trim(), ctx);
      }

      const tag = el.localName;
      switch (tag) {
        case 'br':
          return ctx.inTable ? '<br>' : '\\\n';
        case 'wbr':
          return '';
        case 'strong': case 'b':
          if (ctx.bold) return this.inlineChildren(el, ctx);
          return wrapDelimited(this.inlineChildren(el, Object.assign({}, ctx, { bold: true })), '**');
        case 'em': case 'i': case 'cite': case 'dfn': case 'var':
          if (ctx.italic) return this.inlineChildren(el, ctx);
          return wrapDelimited(this.inlineChildren(el, Object.assign({}, ctx, { italic: true })), '*');
        case 'del': case 's': case 'strike':
          if (ctx.strike) return this.inlineChildren(el, ctx);
          return wrapDelimited(this.inlineChildren(el, Object.assign({}, ctx, { strike: true })), '~~');
        case 'code': case 'kbd': case 'samp': case 'tt': {
          const text = el.textContent || '';
          if (!text.trim()) return text ? ' ' : '';
          return inlineCode(text);
        }
        case 'a':
          return this.link(el, ctx);
        case 'img':
          return this.image(el);
        case 'sup': case 'sub': {
          const inner = this.inlineChildren(el, ctx).trim();
          if (!inner) return '';
          if (el.querySelector('a')) return inner;
          return '<' + tag + '>' + inner + '</' + tag + '>';
        }
        case 'q':
          return '"' + this.inlineChildren(el, ctx) + '"';
        default:
          return this.inlineChildren(el, ctx);
      }
    }

    link(el, ctx) {
      const raw = el.getAttribute('href');
      const inner = this.inlineChildren(el, Object.assign({}, ctx, { inLink: true }));
      if (!raw || raw[0] === '#' || /^\s*javascript:/i.test(raw)) return inner;
      let url = raw;
      try { url = el.href || new URL(raw, el.ownerDocument.baseURI).href; } catch (_) { url = raw; }
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
      let text = m[2];
      const lead = m[1] ? ' ' : '';
      const trail = m[3] ? ' ' : '';
      if (!text) {
        text = escapeText((el.getAttribute('aria-label') || el.getAttribute('title') || '').trim(), { inLink: true });
        if (!text) return '';
      }
      const plain = text.replace(/\\(.)/g, '$1');
      if ((plain === url || plain === url.replace(/^https?:\/\//, '') || plain === url.replace(/\/$/, '')) && !/[\s<>]/.test(url)) {
        return lead + '<' + url + '>' + trail;
      }
      return lead + '[' + text + '](' + formatUrl(url) + ')' + trail;
    }

    image(el) {
      const src = el.getAttribute('src') || '';
      if (!src || /^(data|blob):/i.test(src)) return '';
      let url = src;
      try { url = el.src || src; } catch (_) { /* keep src */ }
      const alt = (el.getAttribute('alt') || '').replace(/[\[\]]/g, '\\$&').replace(/\s+/g, ' ').trim();
      return '![' + alt + '](' + formatUrl(url) + ')';
    }
  }

  /** Lowest heading level (1-6) found inside the given roots, or 0 if there are none. */
  function minHeadingLevel(roots) {
    let min = 0;
    for (const root of roots) {
      if (!root || !root.querySelectorAll) continue;
      for (const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
        if (h.closest('pre')) continue;
        const lvl = Number(h.localName[1]);
        if (!min || lvl < min) min = lvl;
      }
    }
    return min;
  }

  function htmlToMarkdown(root, options) {
    return new Converter(options).convert(root);
  }

  global.__AIMD = {
    Converter,
    htmlToMarkdown,
    codeText,
    minHeadingLevel,
    outermost,
    documentOrder,
    escapeText,
    formatUrl,
    protectVerbatim,
    normalizeCode,
    joinBlocks,
    isHidden,
    isCodeChrome,
    computedStyle,
    isBlockDisplay,
    BLOCK_TAGS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
