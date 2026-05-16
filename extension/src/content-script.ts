/**
 * Content script — runs on every page (or whichever pages the user opts
 * into via the manifest). Looks for `<pre>` / `<code>` blocks that smell
 * like rsyslog / syslog-ng / Fluent Bit / NXLog / Logstash / Vector
 * configurations and decorates them with a small "Open in logflow-sim"
 * button.
 *
 * Detection is intentionally loose — we'd rather show the button on a
 * false-positive than miss a config in a GitHub PR diff.
 */

const SIGNATURES = [
  /^\s*ruleset\s*\(\s*name\s*=/m,         // rsyslog
  /^\s*input\s*\(\s*type\s*=/m,           // rsyslog
  /^\s*source\s+\w+\s*\{/m,               // syslog-ng
  /^\s*destination\s+\w+\s*\{/m,          // syslog-ng
  /^\s*\[SERVICE\]/m,                      // fluent-bit
  /^\s*\[INPUT\]/m,                        // fluent-bit
  /^\s*<Input\s+\w+/i,                    // nxlog
  /^\s*<Output\s+\w+/i,                   // nxlog
  /^\s*input\s*\{[\s\S]*\}\s*filter\s*\{/m, // logstash
  /^\s*\[sources\.\w+\]/m,                // vector toml
  /^\s*sources\s*:\s*$/m                  // vector yaml
];

function looksLikeConfig(text: string): boolean {
  if (text.length < 30 || text.length > 200_000) return false;
  let matches = 0;
  for (const re of SIGNATURES) if (re.test(text)) matches++;
  return matches >= 1;
}

function decorate(el: HTMLElement, text: string): void {
  if (el.dataset.logflowDecorated === '1') return;
  el.dataset.logflowDecorated = '1';

  const btn = document.createElement('button');
  btn.textContent = 'Open in logflow-sim';
  btn.style.cssText = `
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 4px 0 6px;
    padding: 2px 8px;
    font-size: 11px;
    font-family: -apple-system, system-ui, sans-serif;
    border: 1px solid rgba(14, 165, 233, 0.6);
    border-radius: 4px;
    background: rgba(14, 165, 233, 0.08);
    color: rgb(14, 100, 160);
    cursor: pointer;
    z-index: 1;
  `;
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // Stash the text into chrome.storage so the popup can pick it up,
    // then open the popup. The popup reads `pendingConfig` on mount.
    chrome.storage.local.set({ pendingConfig: text }, () => {
      chrome.runtime.sendMessage({ type: 'openPopup' });
    });
  });
  el.parentElement?.insertBefore(btn, el);
}

function scan(): void {
  const blocks = document.querySelectorAll<HTMLElement>('pre, code');
  for (const el of blocks) {
    const text = el.innerText;
    if (looksLikeConfig(text)) decorate(el, text);
  }
}

// Initial scan + observe DOM mutations for SPAs that lazy-load content.
scan();
const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });
