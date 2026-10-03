// Loads the extension's content scripts into a jsdom window, the same way the
// background worker injects them into a real page.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const CONTENT_DIR = path.join(__dirname, '..', 'extension', 'content');
const SCRIPTS = ['markdown.js', 'extractors.js', 'runner.js'];

function loadPage(html, url) {
  const dom = new JSDOM(html, { url: url || 'https://claude.ai/chat/test', runScripts: 'outside-only', pretendToBeVisual: true });
  for (const file of SCRIPTS) {
    const p = path.join(CONTENT_DIR, file);
    if (fs.existsSync(p)) dom.window.eval(fs.readFileSync(p, 'utf8'));
  }
  return dom;
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

module.exports = { loadPage, fixture };
