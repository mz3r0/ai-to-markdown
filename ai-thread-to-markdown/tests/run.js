// Test suite for AI Thread → Markdown. Run with: npm test
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');
const { loadPage, fixture } = require('./helpers');

const md = new MarkdownIt({ html: true });
const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fences(markdown) {
  return md.parse(markdown, {}).filter((t) => t.type === 'fence').map((t) => ({ lang: t.info.trim(), code: t.content.replace(/\n$/, '') }));
}

/** Rules every exported file must satisfy. */
function lint(markdown, label) {
  const lines = markdown.split('\n');
  lines.forEach((l, i) => assert.ok(!/[ \t]+$/.test(l), `${label}: trailing whitespace on line ${i + 1}: ${JSON.stringify(l)}`));
  assert.ok(!/\n{3,}/.test(markdown.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1$/gm, 'CODE')), `${label}: more than one blank line in a row outside code`);
  assert.ok(markdown.endsWith('\n') && !markdown.endsWith('\n\n'), `${label}: file should end with exactly one newline`);
  for (const f of fences(markdown)) {
    const ls = f.code.split('\n');
    ls.forEach((l, i) => assert.ok(!/[ \t]+$/.test(l), `${label}: trailing whitespace inside code line ${i + 1}`));
  }
}

async function exportFixture(name, url, settings) {
  const dom = loadPage(fixture(name + '.html'), url);
  const result = await dom.window.__aiThreadMd.run('save-thread', settings || {});
  assert.ok(result.ok, `${name}: export failed: ${result.error}`);
  return result;
}

const CLAUDE_URL = 'https://claude.ai/chat/0b1c2d3e';
const PPLX_URL = 'https://www.perplexity.ai/search/what-is-rust-ownership-AbCdEf';

// ---------------------------------------------------------------------------
// codeText: the duplicate-newline problem in all the shapes highlighters produce
// ---------------------------------------------------------------------------

const CODE_SHAPES = [
  ['newline text nodes inside token spans (react-syntax-highlighter / Prism)',
    '<code><span>a = 1\n</span><span>\n</span><span>b = 2</span></code>', 'a = 1\n\nb = 2'],
  ['one <div> per line, no newline characters (CodeMirror-style)',
    '<code><div>a = 1</div><div></div><div>b = 2</div></code>', 'a = 1\n\nb = 2'],
  ['one <div> per line with <br> for empty lines',
    '<code><div>a = 1</div><div><br></div><div>b = 2</div></code>', 'a = 1\n\nb = 2'],
  ['display:block line spans that also contain "\\n" (classic innerText doubling)',
    '<code><span style="display:block">a = 1\n</span><span style="display:block">\n</span><span style="display:block">b = 2\n</span></code>', 'a = 1\n\nb = 2'],
  ['display:block line spans separated by "\\n" text nodes (Shiki)',
    '<code><span class="line" style="display:block">a = 1</span>\n<span class="line" style="display:block"></span>\n<span class="line" style="display:block">b = 2</span></code>', 'a = 1\n\nb = 2'],
  ['line-number gutter spans',
    '<code><span class="linenumber react-syntax-highlighter-line-number" style="user-select:none">1</span>a = 1\n<span class="linenumber react-syntax-highlighter-line-number" style="user-select:none">2</span>b = 2</code>', 'a = 1\nb = 2'],
  ['CRLF, non-breaking spaces, zero-width characters and trailing spaces',
    '<code>a\u00a0=\u00a01   \r\n\u200bb = 2\t\r\n</code>', 'a = 1\nb = 2'],
  ['indentation and blank lines at the edges',
    '<code>\n\n    indented()\n        deeper()\n\n</code>', '    indented()\n        deeper()'],
  ['two consecutive blank lines are kept (PEP 8)',
    '<code><span>x = 1\n</span><span>\n</span><span>\n</span><span>y = 2</span></code>', 'x = 1\n\n\ny = 2']
];

for (const [label, html, expected] of CODE_SHAPES) {
  test('codeText: ' + label, () => {
    const dom = loadPage('<!doctype html><body><pre>' + html + '</pre></body>');
    const pre = dom.window.document.querySelector('pre');
    const out = dom.window.__AIMD.htmlToMarkdown(pre);
    assert.equal(fences(out + '\n')[0].code, expected);
  });
}

test('code containing ``` gets a longer fence', () => {
  const dom = loadPage('<!doctype html><body><pre><code class="language-md">```js\nx\n```</code></pre></body>');
  const out = dom.window.__AIMD.htmlToMarkdown(dom.window.document.querySelector('pre'));
  assert.ok(out.startsWith('````md\n'), out);
  assert.deepEqual(fences(out), [{ lang: 'md', code: '```js\nx\n```' }]);
});

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

test('Claude: full thread export', async () => {
  const r = await exportFixture('claude', CLAUDE_URL);
  fs.writeFileSync(path.join(OUT_DIR, 'claude.md'), r.markdown);
  const out = r.markdown;
  lint(out, 'claude');

  assert.equal(r.filename, '2026-10-02 Claude - Reversing lists in Python.md'.replace('2026-10-02', r.filename.slice(0, 10)));
  assert.match(out, /^---\ntitle: "Reversing lists in Python"\nsource: "https:\/\/claude\.ai\/chat\/0b1c2d3e"\nplatform: Claude\nexported: \d{4}-\d\d-\d\dT[\d:]+[+-]\d\d:\d\d\nmessages: 4\n---\n\n# Reversing lists in Python\n\n## User\n/);
  assert.equal((out.match(/^## User$/gm) || []).length, 2);
  assert.equal((out.match(/^## Claude$/gm) || []).length, 2);

  // Code blocks: exact content, right language, nothing leaked in or out.
  assert.deepEqual(fences(out), [
    { lang: 'python', code: 'def rev(xs):\n    return xs[::-1]\n\n\nprint(rev([1, 2]))  # [2, 1]' },
    { lang: 'bash', code: 'pip install pytest\npytest -q' },
    { lang: 'javascript', code: 'const rev = (xs) => [...xs].reverse();\n\nconsole.log(rev([1, 2, 3]));' },
    { lang: 'markdown', code: '```js\nconsole.log(1)\n```' }
  ]);
  assert.ok(!/^Copy$|CopyRetry|Copy to clipboard/m.test(out), 'copy button text leaked');
  for (const leak of ['Retry', 'Claude can make mistakes', 'Reply to Claude', 'Recents', 'New chat', 'MT']) {
    assert.ok(!out.includes(leak), 'UI text leaked: ' + leak);
  }
  assert.ok(!/^(python|javascript|bash|markdown)$/m.test(out.replace(/```[\s\S]*?```/g, '')), 'language label leaked as text');

  // User message kept verbatim (line breaks, indentation, blank lines) plus attachment name.
  assert.ok(out.includes('**Attachments:** notes.txt\n\nHow do I reverse a list?\nHere is what I tried:\n\ndef rev(xs):\n    for i in range(len(xs)):\n\n        pass\n\nIt doesn\'t work'), 'user message not verbatim');

  // Thinking kept in a collapsible block, before the answer.
  assert.ok(out.includes('<details>\n<summary>Thought process</summary>\n\nThe user wants to reverse a list.'), 'thinking block');
  assert.ok(out.indexOf('</details>') < out.indexOf('### Reversing a list'));

  // Headings nested under "## Claude".
  assert.ok(out.includes('\n### Reversing a list\n'), 'h1 -> ###');
  assert.ok(out.includes('\n#### Options\n'), 'h2 -> ####');

  // Lists, nested lists, ordered lists.
  assert.ok(out.includes('- `xs[::-1]` — returns a copy\n- `xs.reverse()` — in place\n  - returns `None`\n  - mutates *the original*\n- `reversed(xs)` — lazy iterator'), 'nested list');
  assert.ok(out.includes('1. Pick one\n2. Run `pytest -q`'), 'ordered list');

  // Table with alignment and an escaped pipe.
  assert.ok(out.includes('| Method     | Copy? | Cost |\n| ---------- | ----- | ---: |\n| `xs[::-1]` | yes   | O(n) |\n| `a \\| b`   | n/a   | O(1) |'), 'table');
  const tableTokens = md.parse(out, {}).filter((t) => t.type === 'td_open');
  assert.equal(tableTokens.length, 6, 'table parses into 6 body cells');

  // Math, blockquote, link, hard break, artifact.
  assert.ok(out.includes('Inline math $O(n)$ and a display formula:\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$'), 'math');
  assert.ok(out.includes('> Readability counts.'), 'blockquote');
  assert.ok(out.includes('See the [Python docs](https://docs.python.org/3/library/functions.html#reversed).\\\nThanks!'), 'link + line break');
  assert.ok(out.includes('> **Artifact:** List helpers (Code · PYTHON)'), 'artifact note');
});

test('Claude: options (no front matter, no heading nesting, no thinking)', async () => {
  const r = await exportFixture('claude', CLAUDE_URL, { frontMatter: false, nestHeadings: false, includeThinking: false });
  assert.ok(r.markdown.startsWith('# Reversing lists in Python\n\n## User\n'));
  assert.ok(r.markdown.includes('\n# Reversing a list\n'));
  assert.ok(!r.markdown.includes('Thought process'));
  lint(r.markdown, 'claude-options');
});

// ---------------------------------------------------------------------------
// Perplexity
// ---------------------------------------------------------------------------

test('Perplexity: full thread export', async () => {
  const r = await exportFixture('perplexity', PPLX_URL);
  fs.writeFileSync(path.join(OUT_DIR, 'perplexity.md'), r.markdown);
  const out = r.markdown;
  lint(out, 'perplexity');

  assert.match(r.filename, /^\d{4}-\d\d-\d\d Perplexity - What is Rust's ownership model\.md$/);
  assert.equal((out.match(/^## User$/gm) || []).length, 2);
  assert.equal((out.match(/^## Perplexity$/gm) || []).length, 2);

  assert.deepEqual(fences(out), [
    { lang: 'rust', code: 'fn main() {\n    let s1 = String::from("hello");\n    let s2 = s1; // s1 is moved\n\n    println!("{s2}");\n}' },
    { lang: 'rust', code: 'fn len(s: &String) -> usize {\n    s.len()\n}' }
  ]);

  // Citations: numbered per answer, deduplicated, chip text ("rust-lang +2") dropped.
  assert.ok(out.includes('goes out of scope. [[1]](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html) Borrowing'), 'citation 1');
  assert.ok(out.includes('without taking ownership. [[2]](https://en.wikipedia.org/wiki/Rust_(programming_language))'), 'numeric citation');
  assert.ok(out.includes('1. Each value has one owner. [[1]](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)\n2. There can be one owner at a time.'), 'tight list with citation');
  assert.ok(out.includes('**Sources**\n\n1. [doc.rust-lang.org](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)\n2. [en.wikipedia.org](https://en.wikipedia.org/wiki/Rust_(programming_language))'), 'sources list');
  for (const leak of ['rust-lang+2', '+2', 'Copy code', 'Copy table', 'Related', 'Ask a follow-up', 'Share', 'Rewrite', 'borrow checker']) {
    assert.ok(!out.includes(leak), 'UI text leaked: ' + leak);
  }
  // Multi-line query kept as typed.
  assert.ok(out.includes('## User\n\nShow borrowing with a function.\nKeep it short.\n'), 'multi-line query');
  // Headings nested (h2 -> ###, h3 -> ####).
  assert.ok(out.includes('\n### Key rules\n') && out.includes('\n#### Example\n'));
  // Rendered links resolve.
  const links = md.parse(out, {}).flatMap((t) => (t.children || [])).filter((t) => t.type === 'link_open').map((t) => t.attrGet('href'));
  assert.ok(links.includes('https://en.wikipedia.org/wiki/Rust_(programming_language)'));
});

test('Perplexity: citations can be turned off', async () => {
  const r = await exportFixture('perplexity', PPLX_URL, { includeCitations: false });
  assert.ok(!r.markdown.includes('[[1]]') && !r.markdown.includes('**Sources**'));
  assert.ok(r.markdown.includes('goes out of scope. Borrowing lets code'), 'text joins cleanly without citation');
  lint(r.markdown, 'perplexity-no-citations');
});

// ---------------------------------------------------------------------------
// Selection, errors, helpers
// ---------------------------------------------------------------------------

test('Selection inside a code block becomes a fenced block with its language', async () => {
  const dom = loadPage(fixture('claude.html'), CLAUDE_URL);
  const { document } = dom.window;
  const code = document.querySelector('code.language-python');
  const range = document.createRange();
  range.selectNodeContents(code);
  const sel = dom.window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const r = await dom.window.__aiThreadMd.run('save-selection', {});
  assert.ok(r.ok, r.error);
  assert.deepEqual(fences(r.markdown), [{ lang: 'python', code: 'def rev(xs):\n    return xs[::-1]\n\n\nprint(rev([1, 2]))  # [2, 1]' }]);
  assert.match(r.filename, /Claude - Reversing lists in Python \(selection\)\.md$/);
});

test('Selection across paragraphs and a list', async () => {
  const dom = loadPage(fixture('perplexity.html'), PPLX_URL);
  const { document } = dom.window;
  const prose = document.querySelector('#markdown-content-0 .prose');
  const range = document.createRange();
  range.setStartBefore(prose.querySelector('h2'));
  range.setEndAfter(prose.querySelector('ol'));
  const sel = dom.window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const r = await dom.window.__aiThreadMd.run('save-selection', {});
  assert.ok(r.ok, r.error);
  assert.equal(r.markdown, '## Key rules\n\n1. Each value has one owner. [[1]](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)\n2. There can be one owner at a time.\n\n**Sources**\n\n1. [doc.rust-lang.org](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)\n');
});

test('A page with no messages reports an error instead of saving', async () => {
  const dom = loadPage('<!doctype html><title>Claude</title><body><main><p>Welcome back</p></main></body>', 'https://claude.ai/new');
  const r = await dom.window.__aiThreadMd.run('save-thread', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /No messages found/);
});

test('Unsupported sites are refused', async () => {
  const dom = loadPage('<!doctype html><body><p>hi</p></body>', 'https://example.com/');
  const r = await dom.window.__aiThreadMd.run('save-thread', {});
  assert.equal(r.ok, false);
});

test('Filenames are safe on Windows, macOS and Linux', () => {
  const dom = loadPage('<!doctype html><body></body>');
  const s = dom.window.__aiThreadMd.sanitizeFilename;
  assert.equal(s('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(s('...hidden. '), 'hidden');
  assert.equal(s('CON'), '_CON');
  assert.equal(s(''), 'thread');
  assert.ok(s('x'.repeat(300)).length <= 120);
});

test('Typed text: HTML-like tags are escaped outside code, unclosed fences are closed', () => {
  const dom = loadPage('<!doctype html><body></body>');
  const p = dom.window.__AIMD.protectVerbatim;
  assert.equal(p('Why does <div> break?'), 'Why does \\<div> break?');
  assert.equal(p('Use `<div>` here'), 'Use `<div>` here');
  assert.equal(p('```html\n<div>\n```\nafter <b>'), '```html\n<div>\n```\nafter \\<b>');
  assert.equal(p('```\nno closing fence'), '```\nno closing fence\n```');
  assert.equal(p('a < b and 2<3'), 'a < b and 2<3');
});

test('Escaping keeps plain text plain', () => {
  const dom = loadPage('<!doctype html><body><div id="x"><p>snake_case, __init__, 2 * 3, *star*, [a](b), 1. not a list</p><p># not a heading</p><p>- not a bullet</p></div></body>');
  const out = dom.window.__AIMD.htmlToMarkdown(dom.window.document.getElementById('x'));
  assert.equal(out, 'snake_case, \\_\\_init\\_\\_, 2 * 3, \\*star\\*, \\[a\\](b), 1. not a list\n\n\\# not a heading\n\n\\- not a bullet');
  const html = md.render(out);
  assert.ok(!/<(em|strong|h1|li|a )/.test(html), 'rendered as plain text: ' + html);
});

// ---------------------------------------------------------------------------
// Search engines
// ---------------------------------------------------------------------------

const SEARCH_CASES = [
  ['Google', 'https://www.google.com/search?q=rust+ownership', '<div data-attrid="AIOverview"><p>Ownership means <strong>one owner</strong>.</p><ul><li>Move</li><li>Borrow</li></ul><button>Show more</button><a href="https://doc.rust-lang.org/book/">Rust book</a></div>'],
  ['Google', 'https://www.google.co.uk/search?q=rust+ownership', '<div><h2>AI Overview</h2><div><p>Ownership means <strong>one owner</strong>.</p><ul><li>Move</li><li>Borrow</li></ul><a href="https://doc.rust-lang.org/book/">Rust book</a></div></div>'],
  ['Bing', 'https://www.bing.com/search?q=rust+ownership', '<div id="b_copilot_answer"><p>Ownership means <strong>one owner</strong>.</p><ul><li>Move</li><li>Borrow</li></ul><a href="https://doc.rust-lang.org/book/">Rust book</a></div>'],
  ['Brave Search', 'https://search.brave.com/search?q=rust+ownership', '<div id="chatllm-container"><p>Ownership means <strong>one owner</strong>.</p><ul><li>Move</li><li>Borrow</li></ul><a href="https://doc.rust-lang.org/book/">Rust book</a></div>'],
  ['DuckDuckGo', 'https://duckduckgo.com/?q=rust+ownership&ia=web', '<div data-testid="duckassist"><p>Ownership means <strong>one owner</strong>.</p><ul><li>Move</li><li>Borrow</li></ul><a href="https://doc.rust-lang.org/book/">Rust book</a></div>'],
  ['You.com', 'https://you.com/search?q=rust+ownership', '<div data-testid="youchat-answer"><p>Ownership means <strong>one owner</strong>.</p><ul><li>Move</li><li>Borrow</li></ul><a href="https://doc.rust-lang.org/book/">Rust book</a></div>'],
  ['Kagi', 'https://kagi.com/search?q=rust+ownership', '<div id="quick-answer"><p>Ownership means <strong>one owner</strong>.</p><ul><li>Move</li><li>Borrow</li></ul><a href="https://doc.rust-lang.org/book/">Rust book</a></div>']
];

for (const [name, url, answer] of SEARCH_CASES) {
  test('Search: ' + name + ' AI answer (' + new URL(url).hostname + ')', async () => {
    const dom = loadPage('<!doctype html><title>rust ownership</title><body><div class="result"><a href="https://example.com">A result</a></div>' + answer + '</body>', url);
    const r = await dom.window.__aiThreadMd.run('save-thread', {});
    assert.ok(r.ok, r.error);
    lint(r.markdown, name);
    assert.match(r.markdown, new RegExp('platform: ' + name.replace('.', '\\.')));
    assert.ok(r.markdown.includes('## User\n\nrust ownership'), r.markdown);
    assert.ok(r.markdown.includes('Ownership means **one owner**.'), r.markdown);
    assert.ok(r.markdown.includes('- Move\n- Borrow'), r.markdown);
    assert.ok(!r.markdown.includes('Show more') && !r.markdown.includes('A result'), 'chrome or organic results leaked');
  });
}

test('Search: a results page without an AI answer is not exported', async () => {
  const dom = loadPage('<!doctype html><body><a href="https://example.com">A result</a></body>', 'https://www.bing.com/search?q=x');
  const r = await dom.window.__aiThreadMd.run('save-thread', {});
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  ok   ' + t.name);
    } catch (err) {
      failed++;
      console.log('  FAIL ' + t.name + '\n       ' + String(err.message).split('\n').join('\n       '));
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
