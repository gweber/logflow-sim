/**
 * Background service worker for the logflow-sim browser extension.
 *
 * Minimal today: just handles the `openPopup` message dispatched from the
 * content script when the user clicks "Open in logflow-sim" on a detected
 * configuration block. Chrome's MV3 doesn't let extensions open their own
 * popup programmatically (it requires a user action on the toolbar icon),
 * so this is currently a no-op stub — the user clicks our toolbar icon
 * after the content script has stashed `pendingConfig` in storage.
 *
 * Kept as a separate file so future capabilities (alarms, omnibox,
 * notifications) have a place to live.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'openPopup') {
    // Best we can do — set badge to draw attention to the toolbar icon.
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#0ea5e9' });
    sendResponse({ ok: true });
  }
  return true;
});
