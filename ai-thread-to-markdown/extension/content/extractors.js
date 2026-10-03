/*
 * AI Thread → Markdown — site extractors for Claude, Perplexity and the AI answers
 * of search engines (Google, Bing, Brave, DuckDuckGo, You.com, Kagi).
 *
 * Each extractor finds the messages of the open thread in document order and
 * converts them with the shared converter (content/markdown.js).
 *
 * Selectors live in the SELECTORS object at the top so they are easy to update
 * when a site changes its markup.
 */
(function (global) {
  'use strict';

  const AIMD = global.__AIMD;
  const { Converter, outermost, documentOrder, minHeadingLevel } = AIMD;

  const SELECTORS = {
    claude: {
      user: '[data-testid="user-message"]',
      assistant: '.font-claude-response, .font-claude-message',
      assistantFallback: '[data-is-streaming]',
      streaming: '[data-is-streaming="true"]',
      markdown: '.standard-markdown, .progressive-markdown',
      artifact: '.artifact-block-cell, [data-testid*="artifact" i]',
      attachment: '[data-testid="file-thumbnail"]',
      turn: '[data-test-render-count]',
      title: '[data-testid="chat-title-button"]'
    },
    perplexity: {
      query: '.group\\/query',
      answer: 'div[id^="markdown-content-"]',
      prose: '.prose'
    },
    // AI answers on search result pages. `answer` lists selectors tried in order (first one
    // that matches wins); `heading` is a fallback that finds the answer by its title text.
    // Search engines change their markup often, so these are the first thing to update.
    search: {
      google: {
        answer: ['[data-subtree="aimc"]', '[data-container-id="main-col"][data-attrid*="AIOverview" i]',
          '[data-attrid*="AIOverview" i]', '[jsname="N760b"]'],
        heading: /^AI (Overview|Mode)$/i
      },
      bing: {
        answer: ['#b_copilot_answer', '.b_copilot', '#b_genserp', '#copilot-answer', '.b_genserp', '#b_context .b_ans.b_top'],
        heading: /^(Copilot( Search)?|Generative search|AI (Overview|answer))$/i
      },
      brave: {
        answer: ['#chatllm-container', '.chatllm', '[data-testid="chatllm-answer"]', '.llm-answer', '#llm-container'],
        heading: /^(AI Answer|Answer with AI|Leo)$/i
      },
      duckduckgo: {
        answer: ['[data-testid="duckassist"]', '[data-testid="duckassist-answer"]', '[data-testid="assist-answer"]',
          '.duckassist', '#duckassist', '[data-testid="ai-answer"]'],
        heading: /^(DuckAssist|AI Answer|Search Assist)$/i
      },
      you: {
        answer: ['[data-testid="youchat-answer"]', '[data-testid="youchat-text"]', '[data-testid="ai-answer"]', '#chatHistory [data-testid*="answer" i]'],
        heading: /^(Smart|Genius|Research) Answer$/i
      },
      kagi: {
        answer: ['#quick-answer', '.quick-answer', '#quickAnswer', '[data-testid="quick-answer"]', '.assistant-message'],
        heading: /^Quick Answer$/i
      }
    }
  };

  const THINKING_RE = /^(thought process|thinking|thought for|thoughts|reasoning)\b/i;
  const RENDERED_MARKDOWN = 'pre, ul, ol, table, blockquote';

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  function qsa(root, selector) {
    try { return Array.from(root.querySelectorAll(selector)); } catch (_) { return []; }
  }

  function cleanTitle(raw, siteName) {
    let t = String(raw || '').replace(/\s+/g, ' ').trim();
    t = t.replace(new RegExp('\\s*[-–—|·:]\\s*' + siteName + '(\\s+AI)?\\s*$', 'i'), '').trim();
    if (new RegExp('^' + siteName + '(\\s+AI)?$', 'i').test(t)) t = '';
    if (/^(new chat|untitled)$/i.test(t)) t = '';
    return t;
  }

  function titleFromMessages(messages) {
    const first = messages.find((m) => m.role === 'user' && m.markdown);
    if (!first) return '';
    const line = first.markdown.split('\n').find((l) => l.trim()) || '';
    const clean = line.replace(/[#>*_`\[\]]/g, '').replace(/\s+/g, ' ').trim();
    return clean.length > 80 ? clean.slice(0, 77).trimEnd() + '…' : clean;
  }

  function headingShift(roots, settings) {
    if (!settings.nestHeadings) return 0;
    const min = minHeadingLevel(roots);
    return min && min < 3 ? 3 - min : 0;
  }

  function isBlockElement(el) {
    if (AIMD.BLOCK_TAGS.has(el.localName)) return true;
    const cs = AIMD.computedStyle(el);
    return !!(cs && AIMD.isBlockDisplay(cs.display));
  }

  function skipInPlainText(el) {
    if (AIMD.isCodeChrome(el)) return true;
    if (AIMD.isHidden(el)) return true;
    return el.matches(SELECTORS.claude.attachment);
  }

  /**
   * Text a person typed, exactly as typed: raw text nodes, paragraphs separated by
   * a blank line, line breaks kept, UI chrome (buttons, icons, hidden nodes) dropped.
   */
  function plainText(root) {
    const parts = [];
    let buf = '';
    const flush = () => {
      const t = AIMD.normalizeCode(buf);
      if (t.trim()) parts.push(t);
      buf = '';
    };
    const walk = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { buf += c.data; continue; }
        if (c.nodeType !== 1) continue;
        if (c.localName === 'br') { buf += '\n'; continue; }
        if (skipInPlainText(c)) continue;
        if (isBlockElement(c)) { flush(); walk(c); flush(); } else walk(c);
      }
    };
    walk(root);
    flush();
    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n');
  }

  /** A user's message: verbatim text, unless the site rendered it as Markdown. */
  function userMessage(el) {
    if (el.querySelector(RENDERED_MARKDOWN)) return new Converter().convert(el);
    return AIMD.protectVerbatim(plainText(el));
  }

  function hostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url; }
  }

  /** True if el is not rendered (display:none somewhere, or inside a collapsed region). */
  function isCollapsed(el, stop) {
    const rootRect = stop.getBoundingClientRect ? stop.getBoundingClientRect() : null;
    const hasLayout = !!(rootRect && rootRect.height > 0);
    for (let a = el; a && a !== stop; a = a.parentElement) {
      if (AIMD.isHidden(a)) return true;
      if (!hasLayout) continue;
      const cs = AIMD.computedStyle(a);
      if (!cs || cs.display === 'contents' || cs.display === 'inline') continue;
      // A region folded to zero height that clips its content (an accordion).
      if (a.getBoundingClientRect().height === 0 && /hidden|clip|auto|scroll/.test(cs.overflowY || cs.overflow || '')) return true;
    }
    return false;
  }

  function mergeConsecutive(messages) {
    const out = [];
    for (const m of messages) {
      const prev = out[out.length - 1];
      if (prev && prev.role === m.role) {
        prev.markdown = [prev.markdown, m.markdown].filter(Boolean).join('\n\n');
      } else {
        out.push(Object.assign({}, m));
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Claude
  // ---------------------------------------------------------------------------

  function claudeAttachments(userEl) {
    const S = SELECTORS.claude;
    const turn = userEl.closest(S.turn);
    if (!turn || turn.querySelector(S.assistant)) return [];
    const names = [];
    for (const thumb of qsa(turn, S.attachment)) {
      let name = thumb.getAttribute('title') || thumb.getAttribute('aria-label') || '';
      if (!name) {
        const img = thumb.querySelector('img[alt]');
        if (img && img.alt.trim()) name = img.alt;
      }
      if (!name) {
        const leaves = qsa(thumb, '*').filter((n) => !n.children.length)
          .map((n) => (n.textContent || '').trim()).filter(Boolean);
        if (!leaves.length && thumb.textContent.trim()) leaves.push(thumb.textContent.trim());
        name = leaves.find((l) => /\.[a-z0-9]{1,6}$/i.test(l)) || leaves[0] || '';
      }
      name = name.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  function isArtifactCard(el) {
    const text = (el.textContent || '').trim();
    return text.length > 0 && text.length < 300 && !el.querySelector('p, pre, ul, ol, table');
  }

  function artifactNote(el) {
    const leaves = qsa(el, '*').filter((n) => !n.children.length && (n.textContent || '').trim());
    const title = leaves.length ? leaves[0].textContent.trim() : (el.textContent || '').trim();
    const kind = leaves.length > 1 ? leaves[1].textContent.trim() : '';
    const label = kind && kind.length < 40 ? title + ' (' + kind + ')' : title;
    return '> **Artifact:** ' + AIMD.escapeText(label.replace(/\s+/g, ' '));
  }

  /** Markdown blocks that sit inside a "Thought process" section. */
  function thinkingBlocks(blocks, root) {
    const result = new Set();
    const buttons = qsa(root, 'button, [role="button"]').filter((b) => THINKING_RE.test((b.textContent || '').trim()));
    for (const block of blocks) {
      for (let a = block.parentElement; a && a !== root; a = a.parentElement) {
        if (/(^|[\s_-])thinking([\s_-]|$)/i.test(a.getAttribute('class') || '')) { result.add(block); break; }
      }
      if (result.has(block)) continue;
      for (const b of buttons) {
        // The thinking section is the nearest ancestor of the toggle that holds more than the toggle.
        let section = b.parentElement;
        while (section && section !== root && section.children.length < 2) section = section.parentElement;
        if (section && section !== root && section.contains(block) && !b.contains(block) &&
            (b.compareDocumentPosition(block) & 4)) {
          result.add(block);
          break;
        }
      }
    }
    // Never classify every block as thinking: the answer has to be somewhere.
    if (result.size === blocks.length) result.clear();
    return result;
  }

  function claudeAssistant(el, settings, warnings) {
    const S = SELECTORS.claude;
    if (el.closest(S.streaming) || el.querySelector(S.streaming)) {
      warnings.push('Claude was still writing a reply; the export includes what was on screen.');
    }
    const blocks = outermost(qsa(el, S.markdown)).filter((b) => !isCollapsed(b, el));
    const artifactHandler = (node) => {
      if (node.matches && node.matches(S.artifact) && isArtifactCard(node)) return '\n\n' + artifactNote(node) + '\n\n';
      return undefined;
    };

    if (!blocks.length) {
      const shift = headingShift([el], settings);
      return new Converter({ handlers: [artifactHandler], headingShift: shift }).convert(el);
    }

    const cards = outermost(qsa(el, S.artifact))
      .filter((c) => isArtifactCard(c) && !blocks.some((b) => b.contains(c) || c.contains(b)) && !isCollapsed(c, el));
    const thinking = thinkingBlocks(blocks, el);
    const shift = headingShift(blocks.filter((b) => !thinking.has(b)), settings);

    const parts = [];
    let thought = [];
    const flushThought = () => {
      if (!thought.length) return;
      if (settings.includeThinking) {
        parts.push('<details>\n<summary>Thought process</summary>\n\n' + thought.join('\n\n') + '\n\n</details>');
      }
      thought = [];
    };
    for (const item of blocks.concat(cards).sort(documentOrder)) {
      if (cards.includes(item)) { flushThought(); parts.push(artifactNote(item)); continue; }
      const isThought = thinking.has(item);
      const md = new Converter({ handlers: [artifactHandler], headingShift: isThought ? 0 : shift }).convert(item);
      if (!md) continue;
      if (isThought) { thought.push(md); continue; }
      flushThought();
      parts.push(md);
    }
    flushThought();
    return parts.join('\n\n');
  }

  function extractClaude(doc, settings) {
    const S = SELECTORS.claude;
    const warnings = [];
    let nodes = qsa(doc, S.user + ', ' + S.assistant);
    if (!nodes.some((n) => n.matches(S.assistant))) nodes = qsa(doc, S.user + ', ' + S.assistantFallback);
    nodes = outermost(nodes);

    const messages = [];
    for (const node of nodes) {
      if (node.matches(S.user)) {
        let md = userMessage(node);
        const files = claudeAttachments(node);
        if (files.length) md = '**Attachments:** ' + files.map((f) => AIMD.escapeText(f)).join(', ') + (md ? '\n\n' + md : '');
        messages.push({ role: 'user', markdown: md });
      } else {
        messages.push({ role: 'assistant', markdown: claudeAssistant(node, settings, warnings) });
      }
    }

    const titleEl = doc.querySelector(S.title);
    const title = cleanTitle(doc.title, 'Claude') || cleanTitle(titleEl && titleEl.textContent, 'Claude') || titleFromMessages(messages);
    return { title, messages: mergeConsecutive(messages), warnings: Array.from(new Set(warnings)) };
  }

  // ---------------------------------------------------------------------------
  // Perplexity
  // ---------------------------------------------------------------------------

  function isCitationAnchor(a) {
    const href = a.getAttribute('href') || '';
    if (!/^https?:/i.test(a.href || href)) return false;
    if (/citation/i.test(a.getAttribute('class') || '')) return true;
    if (a.closest('[class*="citation"]')) return true;
    return /^\s*\[?\d{1,3}\]?\s*$/.test(a.textContent || '');
  }

  /** Turns citation chips into numbered links and collects them for a Sources list. */
  function citationHandler(sources, settings) {
    return (el) => {
      let anchor = null;
      if (el.localName === 'a') {
        if (!isCitationAnchor(el)) return undefined;
        anchor = el;
      } else if (/(^|[\s:_-])citation/i.test(el.getAttribute('class') || '') && (el.textContent || '').length <= 80 &&
                 !el.querySelector('p, pre, ul, ol, table')) {
        anchor = el.querySelector('a[href]');
        if (!anchor) return '';
      } else {
        return undefined;
      }
      if (!settings.includeCitations) return '';
      const url = anchor.href;
      if (!/^https?:/i.test(url)) return '';
      let idx = sources.findIndex((s) => s.url === url);
      if (idx === -1) { sources.push({ url, label: hostname(url) }); idx = sources.length - 1; }
      return ' [[' + (idx + 1) + ']](' + AIMD.formatUrl(url) + ')';
    };
  }

  function perplexityAnswer(el, settings) {
    const P = SELECTORS.perplexity;
    let roots = outermost(qsa(el, P.prose));
    if (!roots.length) roots = [el];
    const sources = [];
    const shift = headingShift(roots, settings);
    const handlers = [citationHandler(sources, settings)];
    let md = roots.map((r) => new Converter({ handlers, headingShift: shift }).convert(r)).filter(Boolean).join('\n\n');
    // Tidy spacing around citation links: "word [[1]](…) ." -> "word [[1]](…)."
    md = md.replace(/(\]\([^)\s]*\)) +(?=[.,;:!?])/g, '$1');
    if (settings.includeCitations && sources.length) {
      md += '\n\n**Sources**\n\n' + sources.map((s, i) => (i + 1) + '. [' + AIMD.escapeText(s.label, { inLink: true }) + '](' + AIMD.formatUrl(s.url) + ')').join('\n');
    }
    return md;
  }

  function extractPerplexity(doc, settings) {
    const P = SELECTORS.perplexity;
    let nodes = outermost(qsa(doc, P.query + ', ' + P.answer));
    if (!nodes.some((n) => n.matches(P.answer))) {
      // Fallback for layouts without the markdown-content ids: treat .prose blocks as answers.
      nodes = outermost(qsa(doc, P.query + ', ' + P.prose));
    }
    const messages = [];
    for (const node of nodes) {
      if (node.matches(P.query)) messages.push({ role: 'user', markdown: userMessage(node) });
      else messages.push({ role: 'assistant', markdown: perplexityAnswer(node, settings) });
    }
    const merged = mergeConsecutive(messages.filter((m) => m.markdown));
    const title = cleanTitle(doc.title, 'Perplexity') || titleFromMessages(merged);
    return { title, messages: merged, warnings: [] };
  }

  // ---------------------------------------------------------------------------
  // Search engines: Google, Bing, Brave, DuckDuckGo, You.com, Kagi
  // ---------------------------------------------------------------------------

  function searchQuery(doc) {
    const loc = doc.defaultView && doc.defaultView.location;
    if (loc) {
      try {
        const params = new URL(loc.href).searchParams;
        for (const key of ['q', 'query', 'p']) {
          const v = (params.get(key) || '').trim();
          if (v) return v;
        }
      } catch (_) { /* fall through to the search box */ }
    }
    const box = doc.querySelector('input[name="q"], textarea[name="q"], input[type="search"], textarea[name="q"]');
    return ((box && box.value) || '').trim();
  }

  /** The smallest ancestor of a heading that also holds the answer text, found by heading title. */
  function answerByHeading(doc, re) {
    const heads = qsa(doc, 'h1, h2, h3, h4, [role="heading"]').filter((h) => re.test((h.textContent || '').replace(/\s+/g, ' ').trim()));
    for (const h of heads) {
      for (let a = h.parentElement, depth = 0; a && a !== doc.body && depth < 8; a = a.parentElement, depth++) {
        if ((a.textContent || '').trim().length > (h.textContent || '').trim().length + 20) return a;
      }
    }
    return null;
  }

  function searchAnswer(el, settings, cfg) {
    const sources = [];
    const handlers = [citationHandler(sources, settings)];
    const shift = headingShift([el], settings);
    let md = new Converter({ handlers, headingShift: shift }).convert(el);
    md = md.replace(/(\]\([^)\s]*\)) +(?=[.,;:!?])/g, '$1');
    if (settings.includeCitations && sources.length) {
      md += '\n\n**Sources**\n\n' + sources.map((s, i) => (i + 1) + '. [' + AIMD.escapeText(s.label, { inLink: true }) + '](' + AIMD.formatUrl(s.url) + ')').join('\n');
    }
    return md;
  }

  function makeSearchExtractor(id, siteName) {
    return function (doc, settings) {
      const cfg = SELECTORS.search[id];
      let roots = [];
      for (const sel of cfg.answer) {
        roots = outermost(qsa(doc, sel)).filter((r) => !isCollapsed(r, doc.body || r) && (r.textContent || '').trim());
        if (roots.length) break;
      }
      if (!roots.length) {
        const found = answerByHeading(doc, cfg.heading);
        if (found) roots = [found];
      }
      const messages = [];
      const query = searchQuery(doc);
      if (query) messages.push({ role: 'user', markdown: AIMD.protectVerbatim(query) });
      for (const root of roots) messages.push({ role: 'assistant', markdown: searchAnswer(root, settings, cfg) });
      const merged = mergeConsecutive(messages.filter((m) => m.markdown));
      // A lone question with no answer on the page is not an export.
      if (!merged.some((m) => m.role === 'assistant')) merged.length = 0;
      const title = query ? titleFromMessages(merged) : (cleanTitle(doc.title, siteName) || '');
      return { title, messages: merged, warnings: [] };
    };
  }

  const extractGoogle = makeSearchExtractor('google', 'Google');
  const extractBing = makeSearchExtractor('bing', 'Bing');
  const extractBrave = makeSearchExtractor('brave', 'Brave');
  const extractDuckDuckGo = makeSearchExtractor('duckduckgo', 'DuckDuckGo');
  const extractYou = makeSearchExtractor('you', 'You.com');
  const extractKagi = makeSearchExtractor('kagi', 'Kagi');

  // ---------------------------------------------------------------------------

  function searchSite(id, name, hosts, extract) {
    return { id, name, hosts, extract, handlers: (settings, sources) => [citationHandler(sources, settings)] };
  }

  const SITES = [
    { id: 'claude', name: 'Claude', hosts: /(^|\.)claude\.ai$/i, extract: extractClaude, handlers: () => [] },
    {
      id: 'perplexity', name: 'Perplexity', hosts: /(^|\.)perplexity\.ai$/i, extract: extractPerplexity,
      handlers: (settings, sources) => [citationHandler(sources, settings)]
    },
    searchSite('google', 'Google', /(^|\.)google\.[a-z.]+$/i, extractGoogle),
    searchSite('bing', 'Bing', /(^|\.)bing\.com$/i, extractBing),
    searchSite('brave', 'Brave Search', /^search\.brave\.com$/i, extractBrave),
    searchSite('duckduckgo', 'DuckDuckGo', /(^|\.)duckduckgo\.com$/i, extractDuckDuckGo),
    searchSite('you', 'You.com', /(^|\.)you\.com$/i, extractYou),
    searchSite('kagi', 'Kagi', /(^|\.)kagi\.com$/i, extractKagi)
  ];

  function detectSite(loc) {
    const host = (loc && loc.hostname) || '';
    return SITES.find((s) => s.hosts.test(host)) || null;
  }

  global.__AIMD_EXTRACTORS = {
    SELECTORS,
    SITES,
    detectSite,
    extractClaude,
    extractPerplexity,
    extractGoogle,
    extractBing,
    extractBrave,
    extractDuckDuckGo,
    extractYou,
    extractKagi,
    plainText,
    citationHandler,
    hostname
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
