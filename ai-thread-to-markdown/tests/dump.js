// Print the Markdown produced for a fixture: node dump.js claude|perplexity
const { loadPage, fixture } = require('./helpers');
const name = process.argv[2] || 'claude';
const url = name === 'perplexity' ? 'https://www.perplexity.ai/search/rust-ownership-abc' : 'https://claude.ai/chat/1234';
const dom = loadPage(fixture(name + '.html'), url);
dom.window.__aiThreadMd.run('save-thread', {}).then((r) => {
  if (!r.ok) { console.error(r); process.exit(1); }
  console.log(r.filename);
  console.log('================');
  process.stdout.write(r.markdown);
});
