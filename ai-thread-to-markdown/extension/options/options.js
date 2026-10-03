const DEFAULT_SETTINGS = {
  frontMatter: true,
  nestHeadings: true,
  includeCitations: true,
  includeThinking: true,
  saveAs: false,
  subfolder: ''
};

const statusEl = document.getElementById('status');
let statusTimer = null;

function showSaved() {
  statusEl.textContent = 'Saved';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 1500);
}

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  for (const [key, value] of Object.entries(settings)) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
  }
}

for (const key of Object.keys(DEFAULT_SETTINGS)) {
  const el = document.getElementById(key);
  if (!el) continue;
  const event = el.type === 'checkbox' ? 'change' : 'input';
  el.addEventListener(event, async () => {
    const value = el.type === 'checkbox' ? el.checked : el.value.trim();
    await chrome.storage.sync.set({ [key]: value });
    showSaved();
  });
}

load();
