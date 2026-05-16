/**
 * Browser-extension popup entry.
 *
 * Hosts the same logflow-sim kernel as the SPA, but in a compact "paste a
 * config, paste a message, see the trace" form factor. No network calls —
 * the entire kernel runs in this popup's JS context, and we use a built-in
 * MemoryVFS so we don't need a host or backend.
 *
 * Future content-script integration:
 *   - Detect rsyslog/syslog-ng configs in <pre>/<code> blocks on any page
 *   - Add a "Open in logflow-sim" button next to detected blocks
 *   - On click, fill the popup with that text and parse + analyze
 */

import { load, simulate, listDialects, analyze, validate, convert } from '../../src/core/kernel.js';
import { MemoryVFS } from '../../src/core/vfs/memory.js';
import { detectDialect } from '../../src/core/dialects/registry.js';
import type { LoadResult } from '../../src/core/kernel.js';

interface State {
  config: string;
  rawmsg: string;
  loaded: LoadResult | null;
  result: unknown | null;
  errors: string[];
}

const root = document.getElementById('popup-root');
if (!root) throw new Error('popup-root missing');

const state: State = {
  config: '',
  rawmsg: '',
  loaded: null,
  result: null,
  errors: []
};

function h(tag: string, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

function render(): void {
  if (!root) return;
  root.innerHTML = '';
  const wrap = h('div', { class: 'p-3 space-y-3 w-[420px] text-sm' });

  wrap.append(
    h('div', { class: 'flex items-center justify-between' }, [
      h('div', { class: 'font-semibold' }, ['logflow-sim']),
      h(
        'div',
        { class: 'text-xs text-slate-500' },
        [listDialects().length + ' dialects loaded']
      )
    ])
  );

  const cfgArea = h('textarea', {
    class: 'w-full border rounded p-2 font-mono text-xs h-32',
    placeholder: 'Paste your rsyslog / syslog-ng / Fluent Bit config here…'
  }) as HTMLTextAreaElement;
  cfgArea.value = state.config;
  cfgArea.addEventListener('input', () => {
    state.config = cfgArea.value;
  });
  wrap.append(h('label', { class: 'block text-xs font-medium' }, ['Config']));
  wrap.append(cfgArea);

  const rawArea = h('textarea', {
    class: 'w-full border rounded p-2 font-mono text-xs h-16',
    placeholder: '<134>Oct 11 22:14:15 host sshd[1234]: Accepted publickey'
  }) as HTMLTextAreaElement;
  rawArea.value = state.rawmsg;
  rawArea.addEventListener('input', () => {
    state.rawmsg = rawArea.value;
  });
  wrap.append(h('label', { class: 'block text-xs font-medium mt-2' }, ['Raw syslog message']));
  wrap.append(rawArea);

  const btnRow = h('div', { class: 'flex gap-2' });
  const parseBtn = h('button', { class: 'px-3 py-1.5 rounded bg-blue-600 text-white text-xs' }, ['Parse + simulate']);
  parseBtn.addEventListener('click', run);
  btnRow.append(parseBtn);
  wrap.append(btnRow);

  if (state.errors.length > 0) {
    const errBox = h('div', { class: 'p-2 rounded bg-red-50 border border-red-200 text-xs text-red-700' });
    for (const e of state.errors) errBox.append(h('div', {}, [e]));
    wrap.append(errBox);
  }

  if (state.loaded) {
    const summary = `${state.loaded.dialect} · ${state.loaded.model.inputs.length} inputs · ${state.loaded.model.rulesets.length} rulesets · ${state.loaded.model.outputs.length} outputs`;
    wrap.append(h('div', { class: 'text-xs text-slate-600' }, [summary]));
  }

  if (state.result) {
    const pre = h('pre', {
      class: 'p-2 rounded bg-slate-100 dark:bg-slate-800 text-[10px] overflow-auto max-h-64'
    });
    pre.textContent = JSON.stringify(state.result, null, 2);
    wrap.append(pre);
  }

  wrap.append(
    h('div', { class: 'text-[10px] text-slate-500 pt-2 border-t border-slate-200' }, [
      'No data leaves your browser — parsing and simulation run entirely in this popup.'
    ])
  );

  root.append(wrap);
}

async function run(): Promise<void> {
  state.errors = [];
  state.result = null;
  if (!state.config.trim()) {
    state.errors.push('Config is empty.');
    render();
    return;
  }
  try {
    const probe = [{ path: 'config', content: state.config }];
    const detected = detectDialect(probe);
    const vfs = new MemoryVFS({ '/config': state.config });
    const loaded = await load(vfs, {
      entrypoint: '/config',
      dialect: detected?.dialect.id
    });
    state.loaded = loaded;

    if (state.rawmsg.trim()) {
      // Use the rawmsg to drive a single simulation.
      const result = simulate({
        model: loaded.model,
        lookupTables: loaded.lookupTables,
        message: {
          transport: 'udp',
          port: 514,
          rawmsg: state.rawmsg,
          myhostname: 'browser'
        }
      });
      state.result = result;
    } else {
      // No message — show analysis instead.
      state.result = {
        analysis: analyze(loaded.model).summary,
        validation: validate(loaded.model).summary
      };
    }
  } catch (e) {
    state.errors.push((e as Error).message);
  }
  render();
}

// Expose convert for ad-hoc curiosity (advanced flow once we add a UI).
void convert;

render();
