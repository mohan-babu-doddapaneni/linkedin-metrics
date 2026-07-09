// popup.js

const widgetToggle = document.getElementById('widgetEnabled');
const debugToggle = document.getElementById('debugMode');
const statusEl = document.getElementById('status');
const versionEl = document.getElementById('version');

versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

chrome.storage.sync.get(['widgetEnabled'], (result) => {
  widgetToggle.checked = result.widgetEnabled !== false; // default true
});
chrome.storage.local.get(['debugMode'], (result) => {
  debugToggle.checked = Boolean(result.debugMode);
});

function flashStatus(message) {
  statusEl.textContent = message;
  setTimeout(() => {
    statusEl.textContent = '';
  }, 1500);
}

widgetToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ widgetEnabled: widgetToggle.checked }, () => {
    flashStatus('Saved');
  });
});

debugToggle.addEventListener('change', () => {
  chrome.storage.local.set({ debugMode: debugToggle.checked }, () => {
    flashStatus('Saved');
  });
});
