// Node smoke test for UnboundOverview.js using stubbed framework globals.
// Usage: node tests/run-harness.mjs   (run from anywhere; no build step)
//
// Stubs BaseWidget, Chart and a minimal jQuery so the widget module can be
// exercised outside of OPNsense. Verifies markup registration, initial load,
// tick refresh, disabled-state hint, re-enable recovery and teardown.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const widgetSrc = readFileSync(join(here, '../src/opnsense/www/js/widgets/UnboundOverview.js'), 'utf8');

// ---- fake element store -----------------------------------------------------
const store = new Map(); // id -> { content: string, classes: Set }

function ensureId(id) {
  if (!store.has(id)) store.set(id, { content: '', classes: new Set() });
  return store.get(id);
}

function idsFrom(html) {
  const found = [];
  const re = /id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) found.push(m[1]);
  return found;
}

class ElWrapper {
  constructor(id, html) {
    this.el = ensureId(id);
    if (html !== undefined) {
      this.el.content += html;
      idsFrom(html).forEach(ensureId);
    }
  }
  html(v) { if (v === undefined) return this.el.content; this.el.content = v; return this; }
  append(html) { this.el.content += html; idsFrom(html).forEach(ensureId); return this; }
  empty() { this.el.content = ''; return this; }
  toggleClass(cls, force) {
    if (force === undefined) this.el.classes.has(cls) ? this.el.classes.delete(cls) : this.el.classes.add(cls);
    else if (force) this.el.classes.add(cls);
    else this.el.classes.delete(cls);
    return this;
  }
}

let fragCounter = 0;
function $(arg) {
  if (typeof arg === 'object' && arg !== null) return arg;
  if (arg.includes('<')) {
    // HTML fragment: register all ids found in it, like jQuery's detached elements
    const el = new ElWrapper('$$frag-' + (fragCounter++));
    el.el.content += arg;
    idsFrom(arg).forEach(ensureId);
    return el;
  }
  const id = arg.startsWith('#') ? arg.slice(1) : arg;
  return new ElWrapper(id);
}

// ---- global stubs -----------------------------------------------------------
const apiResponder = (url) => {
  if (url.includes('/is_enabled')) return { enabled: globalThis.__enabled };
  if (url.includes('/totals/')) return {
    total: 1234,
    resolved: { total: 1000, pcnt: 81.0 },
    blocked: { total: 234, pcnt: 19.0 },
    blocklist_size: 42,
    start_time: Math.floor(Date.now() / 1000) - 3600,
    top: { 'a.example': { total: 500, pcnt: 40.5 } },
    top_blocked: { 'ads.example': { total: 200, pcnt: 85.5, latest_policy_uuid: 'p1', blocklist: 'b' } }
  };
  if (url.includes('/rolling/')) {
    const now = Math.floor(Date.now() / 60000) * 60;
    return {
      [String(now - 300)]: { total: 10, blocked: 2 },
      [String(now - 240)]: { total: 12, blocked: 3 }
    };
  }
  if (url.includes('/get_policies')) return { p1: { description: 'Ads', enabled: '1' } };
  throw new Error('unmapped url ' + url);
};

class FakeBaseWidget {
  constructor(config) { this.config = config; this.id = null; this.translations = {}; this.tickTimeout = 10; }
  setId(id) { this.id = id; }
  setTranslations(t) { this.translations = t; }
  ajaxCall(url) { return Promise.resolve(apiResponder(url)); }
}

class FakeChart {
  constructor(ctx, cfg) { this.data = cfg.data; this.options = cfg.options; this.updates = 0; }
  update() { this.updates++; }
  destroy() { this.destroyed = true; }
}

globalThis.BaseWidget = FakeBaseWidget;
globalThis.Chart = FakeChart;
globalThis.$ = $;
globalThis.document = {
  on: () => {}, off: () => {},
  getElementById: (id) => (store.has(id) ? { getContext: () => ({}) } : null)
};
globalThis.__enabled = 1;

// ---- run the widget ---------------------------------------------------------
const mod = await import('data:text/javascript;base64,' + Buffer.from(widgetSrc).toString('base64'));
const UnboundOverview = mod.default;

const w = new UnboundOverview({});
w.setId('test');
w.setTranslations({ title: 'Unbound Overview' });
w.getMarkup();
assert.ok(store.has('unboundov-test-chart'), 'canvas registered in markup');
assert.ok(store.has('unboundov-test-stats'), 'stats container registered');

await w.onMarkupRendered();
assert.strictEqual(w.enabled, true);
assert.ok(w.chart, 'chart instance exists after render (enabled)');
assert.match(store.get('unboundov-test-stats').content, /Total/);
assert.match(store.get('unboundov-test-stats').content, /Blocklist size/);
// both top lists render side by side from the start (like the overview page)
assert.ok(store.has('unboundov-test-top'), 'top passed list registered in markup');
assert.ok(store.has('unboundov-test-top-blocked'), 'top blocked list registered in markup');
assert.match(store.get('unboundov-test-top').content, /a\.example/);
assert.match(store.get('unboundov-test-top-blocked').content, /ads\.example \(Ads\)/);
assert.strictEqual(w.chart.data.datasets[0].data.length, 3, 'rolling points + trailing zero');

// tick while enabled refreshes both lists again
w.lastTotals.top = {};
await w.onWidgetTick();
assert.match(store.get('unboundov-test-top').content, /a\.example/, 'tick re-renders passed list');
assert.match(store.get('unboundov-test-top-blocked').content, /ads\.example \(Ads\)/, 'tick re-renders blocked list');

// tick while enabled refreshes
const before = w.chart.updates;
await w.onWidgetTick();
assert.ok(w.chart.updates > before, 'tick updates chart');

// disabled state: alert shown, content hidden
globalThis.__enabled = 0;
await w.onWidgetTick();
assert.strictEqual(w.enabled, false);
assert.ok(!store.get('unboundov-test-disabled').classes.has('hide'), 'disabled hint visible');
assert.ok(store.get('unboundov-test-content').classes.has('hide'), 'content hidden when disabled');

// re-enabled: content returns and a fresh chart is created if none exists
w.chart.destroy(); w.chart = null;
globalThis.__enabled = 1;
await w.onWidgetTick();
assert.strictEqual(w.enabled, true);
assert.ok(!store.get('unboundov-test-content').classes.has('hide'), 'content restored when re-enabled');
assert.ok(w.chart && !w.chart.destroyed, 'chart recreated after re-enable');

// period select path (as triggered by the change handler)
w.period = '1';
await w._update();
assert.strictEqual(w.chart.options.scales.x.time.stepSize, 5, '1h period uses minute step');
w.period = '24';
await w._update();
assert.strictEqual(w.chart.options.scales.x.time.stepSize, 60, '24h period uses 60s step');

// close tears down
w.onWidgetClose();
assert.ok(w.chart === null, 'chart destroyed on close');

console.log('HARNESS-OK');
