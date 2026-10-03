# AI Thread to Markdown

A Brave (and any Chromium browser) extension that saves the Claude or Perplexity
conversation you have open as a clean Markdown file. Right-click anywhere on the
page and choose **Save thread as Markdown**.

## Install in Brave

1. Unzip this folder somewhere permanent (Brave loads it from that location).
2. Open `brave://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension` folder.
5. Optional: pin the extension from the puzzle-piece menu so the toolbar button is visible.

It also works in Chrome, Edge, Vivaldi and Opera the same way (`chrome://extensions`, etc.).

## Use

On `claude.ai` or `perplexity.ai`, right-click the page:

| Menu item                     | What it does                                              |
| ----------------------------- | --------------------------------------------------------- |
| Save thread as Markdown       | Downloads the whole conversation as a `.md` file          |
| Copy thread as Markdown       | Puts the same Markdown on the clipboard                   |
| Save selection as Markdown    | Shown when text is selected; saves just the selection     |
| Copy selection as Markdown    | Copies just the selection                                 |

Brave groups the items under **AI Thread to Markdown** in the right-click menu.
You can also click the toolbar button (saves the thread) or use the shortcuts
**Alt+Shift+M** (save) and **Alt+Shift+C** (copy). Shortcuts can be changed at
`brave://extensions/shortcuts`. Alt+Shift+C always copies on Claude and
Perplexity pages, even if that page shows no key for "Copy": Chromium-based
browsers often refuse to hand that combination to an extension, so the extension
also listens for it on those two sites.

A small notice in the bottom-right corner confirms what was saved or explains
what went wrong.

Copying happens in the extension's own hidden page rather than in the web page,
so it doesn't depend on which tab or field has focus or on the site's own copy
handling. If the clipboard can't be written you get an error notice — never a
"Copied" message with the old clipboard contents still in place.

Files are named `2026-10-02 Claude - <chat title>.md` and go to your Downloads
folder (or a subfolder you choose in the options).

## What the file looks like

````markdown
---
title: "Reversing lists in Python"
source: "https://claude.ai/chat/…"
platform: Claude
exported: 2026-10-02T17:54:13+02:00
messages: 4
---

# Reversing lists in Python

## User

How do I reverse a list?

## Claude

### Reversing a list

Use `reversed()` or slicing:

```python
def rev(xs):
    return xs[::-1]
```
````

Full samples produced from the test pages are in `examples/`.

## Clean output, specifically

- **Code blocks are copied character for character.** The text is read from the
  page's text nodes rather than `innerText`, and a line break is only added at a
  block boundary when one isn't already there. That removes the doubled blank
  lines you get from syntax-highlighted code, whether the site renders one `<span>`
  per token, one `<div>` per line, or block-level line spans with their own newlines.
- Copy buttons, language labels and line-number gutters stay out of the code; the
  language label becomes the fence's language (` ```python `).
- Code that itself contains ` ``` ` gets a longer fence so it can't close early.
- Trailing spaces, non-breaking spaces and zero-width characters are removed; there
  is never more than one blank line in a row outside code.
- Lists stay tight and nested lists are indented correctly; tables are aligned
  GFM tables with escaped pipes; KaTeX math becomes `$…$` / `$$…$$`; links are kept.
- Headings inside replies are shifted so they sit under the `## User` /
  `## Claude` headings (`#` in a reply becomes `###`). Turn this off in the options.
- What you typed is kept exactly as typed (line breaks and indentation included);
  only HTML-looking tags are escaped so they can't break the rest of the file.

### Claude

- Extended thinking is included in a collapsible `<details>` block only if you
  expanded it on the page; collapsed thinking is left out.
- Attachments you added are listed by file name.
- Artifacts appear as a one-line note (`> **Artifact:** Title`). Their contents
  live in the side panel, not the conversation, so open the artifact and use its
  own copy/download button to save the content.

### Search engines (AI answers)

On result pages of Google (AI Overviews / AI Mode), Bing (Copilot answers), Brave
Search (Answer with AI), DuckDuckGo (DuckAssist), You.com and Kagi (Quick Answer),
the same commands export your search query plus the AI answer. Organic results
are not included, and a page without an AI answer reports "No messages found".
Links in the answer are kept as Markdown links. Google is enabled on `google.com`
and the common country domains listed in `extension/manifest.json`; add yours there
if needed. Their markup changes often: update `SELECTORS.search` in
`extension/content/extractors.js` when an export comes back empty.

### Perplexity

- Citation chips become numbered links (`[[1]](https://…)`) and each answer ends
  with a **Sources** list. You can turn citations off in the options.
- The sources carousel, related questions, images and buttons are left out.

## Options

Right-click the toolbar button → **Options**:

- Add YAML front matter (on)
- Nest reply headings under each message (on)
- Keep Perplexity citations (on)
- Keep Claude's thought process when it is expanded (on)
- Ask where to save each file (off; Brave's own "Ask where to save" setting also applies)
- Subfolder inside Downloads (empty)

## Privacy

Everything happens in your browser. The extension makes no network requests;
it reads the page you are on only when you click one of its commands, and the
file is written straight to your Downloads folder. It can only run on
`claude.ai`, `perplexity.ai` and the search engines above (plus the page you click its toolbar button on,
where it just tells you the page isn't supported).

## When a site changes its layout

Both sites change their markup from time to time. If an export comes back empty
("No messages found"), update the selectors at the top of
`extension/content/extractors.js` (`SELECTORS.claude` and `SELECTORS.perplexity`)
and reload the extension from `brave://extensions`.

Very long Perplexity threads may load older answers lazily; scroll to the top of
the thread first so everything is on the page.

## Development

```
extension/
  manifest.json            Manifest V3
  background.js            context menu, toolbar button, shortcuts, downloads
  content/markdown.js      HTML → Markdown converter (code blocks, lists, tables, math)
  content/extractors.js    Claude and Perplexity message extraction
  content/runner.js        builds the document, copies, shows the notice
  options/                 options page
  offscreen/               hidden page that writes to the clipboard
tests/
  fixtures/                pages modelled on Claude and Perplexity markup
  run.js                   converter and extractor tests (jsdom)
  e2e.js                   loads the extension in real Chromium and saves files
```

```
cd tests
npm install
npm test          # 21 converter/extractor tests
npm run e2e       # end-to-end in Chromium; set CHROME_PATH to a Chromium or Brave binary
npm run dump -- claude   # print the Markdown for a fixture
```
