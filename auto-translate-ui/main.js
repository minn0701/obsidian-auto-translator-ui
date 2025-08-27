const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const crypto = require('crypto');

/** Simple LRU cache */
class LRU {
  constructor(limit = 5000) { this.limit = limit; this.map = new Map(); }
  get(k) { if (this.map.has(k)) { const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v; } }
  set(k, v) { if (this.map.has(k)) this.map.delete(k); this.map.set(k, v); if (this.map.size > this.limit) { const f = this.map.keys().next().value; this.map.delete(f); } }
  has(k) { return this.map.has(k); }
}

const DEFAULT_SETTINGS = {
  enabled: true,
  provider: 'azure', // 'azure' | 'google' | 'deepl'
  sourceLang: 'auto',
  targetLang: 'ko',
  mode: 'replace', // 'replace' | 'inline' | 'tooltip' (UI prepared; replace by default)
  offlineOnly: false,
  apiKeys: {
    azure: { key: '', region: '', endpoint: 'https://api.cognitive.microsofttranslator.com' },
    google: { key: '' },
    deepl: { key: '', endpoint: 'https://api-free.deepl.com' }
  },
  includeSelectors: [
    '.setting-item-name',
    '.setting-item-description',
    'h2', 'h3',
    '.item-container .info-container',
    'select > option',
    '[aria-label]', '[title]',
    '.setting-item-heading'
  ],
  excludeSelectors: [
    '.cm-content', '.markdown-preview-view',
    'input', 'textarea', '.setting-hotkey', '.hotkeys-container',
    '.checkbox-container', '.svg-icon',
    '[data-autotrans-ignore] *'
  ],
  pluginSelectors: { /* pluginId: ['.my-selector', 'select>option'] */ },
  rateLimit: { rps: 4, batchSize: 20 },
  cacheLimit: 5000,
};

/** Utility */
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isElementVisible(el) {
  if (!el) return false; const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Provider base */
class Provider { constructor(plugin) { this.plugin = plugin; } async translateMany(texts, source, target) { throw new Error('Not implemented'); } }

/** Azure Translator */
class AzureProvider extends Provider {
  async translateMany(texts, source, target) {
    const { key, region, endpoint } = this.plugin.settings.apiKeys.azure;
    if (!key) throw new Error('Azure key missing');
    const url = new URL('/translate', endpoint);
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('to', target);
    if (source && source !== 'auto') url.searchParams.set('from', source);

    const body = texts.map(t => ({ Text: t }));
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Ocp-Apim-Subscription-Key': key,
        ...(region ? { 'Ocp-Apim-Subscription-Region': region } : {})
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Azure ${res.status}`);
    const data = await res.json();
    return data.map(item => (item.translations && item.translations[0] ? item.translations[0].text : ''));
  }
}

/** Google Cloud Translation v2 */
class GoogleProvider extends Provider {
  async translateMany(texts, source, target) {
    const key = this.plugin.settings.apiKeys.google.key; if (!key) throw new Error('Google key missing');
    const url = new URL('https://translation.googleapis.com/language/translate/v2');
    url.searchParams.set('key', key);
    url.searchParams.set('target', target);
    if (source && source !== 'auto') url.searchParams.set('source', source);

    const form = new URLSearchParams();
    texts.forEach(t => form.append('q', t));
    const res = await fetch(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (!res.ok) throw new Error(`Google ${res.status}`);
    const data = await res.json();
    return (data.data?.translations || []).map(tr => tr.translatedText || '');
  }
}

/** DeepL API Free */
class DeepLProvider extends Provider {
  async translateMany(texts, source, target) {
    const { key, endpoint } = this.plugin.settings.apiKeys.deepl; if (!key) throw new Error('DeepL key missing');
    const tgt = (target || 'ko').toUpperCase();
    const url = new URL('/v2/translate', endpoint || 'https://api-free.deepl.com');
    const form = new URLSearchParams();
    texts.forEach(t => form.append('text', t));
    form.append('target_lang', tgt);
    if (source && source !== 'auto') form.append('source_lang', source.toUpperCase());
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `DeepL-Auth-Key ${key}` },
      body: form.toString(),
    });
    if (!res.ok) throw new Error(`DeepL ${res.status}`);
    const data = await res.json();
    return (data.translations || []).map(tr => tr.text || '');
  }
}

/** Queue + rate limit */
class TranslateQueue {
  constructor(plugin) { this.plugin = plugin; this.queue = []; this.running = false; }
  enqueue(task) { this.queue.push(task); this.run(); }
  async run() {
    if (this.running) return; this.running = true;
    const { rps, batchSize } = this.plugin.settings.rateLimit;
    const interval = Math.max(250, Math.floor(1000 / Math.max(1, rps)));
    while (this.queue.length > 0) {
      const tasks = this.queue.splice(0, batchSize);
      const texts = tasks.map(t => t.text);
      try {
        const translated = await this.plugin.translateMany(texts);
        translated.forEach((dst, i) => tasks[i].resolve(dst));
      } catch (e) {
        console.error('[auto-translate-ui] batch error', e);
        tasks.forEach(t => t.reject(e));
      }
      await sleep(interval);
    }
    this.running = false;
  }
}

/** Disk cache (JSON map) */
class DiskCache {
  constructor(plugin) { this.plugin = plugin; this.map = {}; this.dirty = false; this.path = ''; }
  async load() {
    const cfg = this.plugin.app.vault.configDir; // .obsidian
    const base = `${cfg}/plugins/${this.plugin.manifest.id}/cache`;
    this.path = `${base}/translations-${this.plugin.settings.targetLang}.json`;
    try { await this.plugin.app.vault.adapter.mkdir(base); } catch {}
    if (await this.plugin.app.vault.adapter.exists(this.path)) {
      try { const raw = await this.plugin.app.vault.adapter.read(this.path); this.map = JSON.parse(raw || '{}'); } catch (e) { console.warn('cache read fail', e); this.map = {}; }
    }
  }
  get(k) { return this.map[k]; }
  set(k, v) { this.map[k] = v; this.dirty = true; this.scheduleSave(); }
  scheduleSave() { clearTimeout(this._t); this._t = setTimeout(() => this.flush(), 1000); }
  async flush() { if (!this.dirty) return; this.dirty = false; try { await this.plugin.app.vault.adapter.write(this.path, JSON.stringify(this.map)); } catch (e) { console.error('cache write fail', e); } }
}

/** Main plugin */
module.exports = class AutoTranslateUIPlugin extends Plugin {
  constructor(...args){ super(...args); this.generation = 0; }
  bumpGeneration(){ this.generation = (this.generation|0) + 1; }
  async onload() {
    console.log('Loading Auto Translate UI plugin');
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.lru = new LRU(this.settings.cacheLimit || 5000);
    this.diskCache = new DiskCache(this); await this.diskCache.load();
    this.queue = new TranslateQueue(this);
    this.originalText = new WeakMap(); // element -> {text, attr:{title,ariaLabel}}
    this.modalStates = new WeakMap(); // modalContainer -> on/off

    this.registerInterval(window.setInterval(() => this.diskCache.flush(), 5000));

    this.setProvider(this.settings.provider);
    this.addSettingTab(new AutoTranslateSettingsTab(this.app, this));

    // Commands
    this.addCommand({ id: 'toggle-translation', name: 'Toggle translation (global)', callback: async () => { this.settings.enabled = !this.settings.enabled; this.bumpGeneration(); await this.saveSettings(); if (!this.settings.enabled) this.restoreScope(document.body); this.refreshAll(); new Notice(`Auto-Translate: ${this.settings.enabled ? 'ON' : 'OFF'}`); } });
    this.addCommand({ id: 'build-cache-now', name: 'Build/Update translation cache', callback: () => this.prebuildCacheAllSettings() });

    // Observe DOM for settings panels & modals
    this.setupObservers();

    // Inject CSS (in case styles.css is missing)
    this.injectFallbackCss();

    // Initial scan
    this.refreshAll();
  }

  onunload() {
    console.log('Unloading Auto Translate UI plugin');
  }

  async saveSettings() { await this.saveData(this.settings); }

  setProvider(name) { this.providerName = name; if (name === 'azure') this.provider = new AzureProvider(this); else if (name === 'google') this.provider = new GoogleProvider(this); else if (name === 'deepl') this.provider = new DeepLProvider(this); }

  async translateMany(texts) {
    const src = this.settings.sourceLang || 'auto';
    const tgt = this.settings.targetLang || 'ko';

    // hashlines with provider + langs to avoid collisions
    const keys = texts.map(t => sha1([this.providerName, src, tgt, t].join('|')));
    const out = new Array(texts.length);
    const missIdx = [];

    for (let i = 0; i < texts.length; i++) {
      const k = keys[i];
      const cached = this.lru.get(k) || this.diskCache.get(k);
      if (cached) {
        out[i] = cached; this.lru.set(k, cached);
      } else missIdx.push(i);
    }

    if (missIdx.length === 0) return out;

    const missTexts = missIdx.map(i => texts[i]);
    if (this.settings.offlineOnly) {
      missIdx.forEach((idx, j) => out[idx] = missTexts[j]);
      return out;
    }
    let translated = [];
    try {
      translated = await this.provider.translateMany(missTexts, src, tgt);
    } catch (e) {
      console.warn('translateMany failed, leaving originals', e);
      // Fallback: return originals for misses
      missIdx.forEach((idx, j) => out[idx] = missTexts[j]);
      return out;
    }

    missIdx.forEach((idx, j) => { const dst = translated[j] ?? missTexts[j]; out[idx] = dst; const k = keys[idx]; this.lru.set(k, dst); this.diskCache.set(k, dst); });
    return out;
  }

  injectFallbackCss() {
    const id = 'autotrans-inline-style'; if (document.getElementById(id)) return;
    const style = document.createElement('style'); style.id = id; style.textContent = `
      .autotrans-toggle{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);font-size:12px;cursor:pointer;user-select:none;margin-right:8px}
      .autotrans-toggle[data-state="off"]{opacity:.6}
      .autotrans-toggle .dot{width:8px;height:8px;border-radius:50%;background:var(--interactive-accent)}
      .autotrans-toggle[data-state="off"] .dot{background:var(--text-muted)}
      .modal .autotrans-toggle,.mod-settings .autotrans-toggle{position:absolute;top:8px;right:40px;z-index:5}
    `; document.head.appendChild(style);
  }

  setupObservers() {
    // Settings panels in main area
    const debouncedScan = this.debounce(() => this.scanAndTranslate(document.body), 200);
    const mo = new MutationObserver(() => debouncedScan());
    mo.observe(document.body, { subtree: true, childList: true, attributes: false });
    this.register(() => mo.disconnect());

    // Observe modals to inject toggle
    const modalMo = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains('modal-container')) {
            this.injectModalToggle(node);
          }
        }
      }
    });
    modalMo.observe(document.body, { childList: true, subtree: true });
    // ensure existing modals also get toggle
    document.querySelectorAll('.modal-container').forEach(n => this.injectModalToggle(n));
    this.register(() => modalMo.disconnect());
  }

  debounce(fn, wait) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }

  refreshAll() {
    this.scanAndTranslate(document.body);
  }

  collectTargets(root) {
    const sels = new Set(this.settings.includeSelectors);
    // Merge plugin-specific selectors if available
    try {
      const active = this.getActivePluginId();
      if (active && this.settings.pluginSelectors && this.settings.pluginSelectors[active]) {
        this.settings.pluginSelectors[active].forEach(s => sels.add(s));
      }
    } catch {}

    const exclude = this.settings.excludeSelectors || [];
    const elements = new Set();

    for (const sel of sels) {
      root.querySelectorAll(sel).forEach(el => {
        if (!(el instanceof HTMLElement)) return;
        if (exclude.some(ex => el.closest(ex))) return;
        if (el.closest('[data-autotrans-ignore]')) return;
        elements.add(el);
      });
    }
    return Array.from(elements);
  }

  getActivePluginId() {
    // Best-effort: find current settings view heading that contains plugin id
    // Fallback: undefined (user can still configure selectors globally)
    try {
      const title = document.querySelector('.mod-settings .setting-item-title, .mod-settings .modal-title');
      if (!title) return undefined;
      const txt = title.textContent || '';
      const m = txt.match(/[A-Za-z0-9_-]+/g);
      if (m && m[0]) return m[0].toLowerCase();
    } catch {}
    return undefined;
  }

  async scanAndTranslate(root) {
    if (!this.settings.enabled) return;
    const els = this.collectTargets(root);
    if (!els.length) return;

    const mode = this.settings.mode || 'replace';

    const attrEls = []; const textEls = []; const optionEls = [];
    for (const el of els) {
      if (el.tagName === 'OPTION') optionEls.push(el);
      else if (el.hasAttribute('aria-label') || el.hasAttribute('title')) attrEls.push(el);
      else textEls.push(el);
    }

    await this.translateAttributes(attrEls, mode);
    await this.translateOptions(optionEls, mode);
    await this.translateElements(textEls, mode);
  }

  snapshotElement(el) {
    if (this.originalText.has(el)) return;
    const snap = { text: el.innerText, attr: {} };
    if (el.hasAttribute('title')) snap.attr.title = el.getAttribute('title');
    if (el.hasAttribute('aria-label')) snap.attr.ariaLabel = el.getAttribute('aria-label');
    this.originalText.set(el, snap);
  }

  restoreElement(el) {
    const snap = this.originalText.get(el);
    if (!snap) return;
    if (typeof snap.text === 'string') el.innerText = snap.text;
    if (snap.attr) {
      if ('title' in snap.attr) el.setAttribute('title', snap.attr.title ?? '');
      if ('ariaLabel' in snap.attr) el.setAttribute('aria-label', snap.attr.ariaLabel ?? '');
    }
    el.removeAttribute('data-autotranslated');
  }

  async translateElements(els, mode) {
    const gen = this.generation;
    const texts = [];
    const targets = [];
    for (const el of els) {
      if (!isElementVisible(el)) continue;
      if (el.closest('[data-autotrans-ignore]')) continue;
      const t = (el.innerText || '').trim();
      if (!t) continue;
      this.snapshotElement(el);
      texts.push(t);
      targets.push(el);
    }
    if (!texts.length) return;
    const out = await this.batch(texts);
    for (let i = 0; i < targets.length; i++) {
      if (gen !== this.generation) return;
      const el = targets[i];
      if (el.closest('[data-autotrans-ignore]')) continue;
      const src = texts[i]; const dst = out[i] || src;
      this.render(el, src, dst, mode);
    }
  }

  async translateAttributes(els, mode) {
    const gen = this.generation;
    const attrPairs = []; const texts = [];
    for (const el of els) {
      if (el.closest('[data-autotrans-ignore]')) continue;
      if (el.hasAttribute('title')) { const v = el.getAttribute('title'); if (v && v.trim()) { this.snapshotElement(el); texts.push(v.trim()); attrPairs.push([el, 'title']); } }
      if (el.hasAttribute('aria-label')) { const v = el.getAttribute('aria-label'); if (v && v.trim()) { this.snapshotElement(el); texts.push(v.trim()); attrPairs.push([el, 'aria-label']); } }
    }
    if (!texts.length) return;
    const out = await this.batch(texts);
    for (let i = 0; i < attrPairs.length; i++) {
      if (gen !== this.generation) return;
      const [el, attr] = attrPairs[i];
      if (el.closest('[data-autotrans-ignore]')) continue;
      const src = texts[i]; const dst = out[i] || src;
      if (mode === 'tooltip') { if (attr === 'title') el.setAttribute('title', dst); if (attr === 'aria-label') el.setAttribute('aria-label', dst); }
      else { el.setAttribute(attr, dst); }
      el.setAttribute('data-autotranslated', 'true');
    }
  }

  async translateOptions(options, mode) {
    const gen = this.generation;
    const texts = []; const targets = [];
    for (const op of options) {
      if (op.closest('[data-autotrans-ignore]')) continue;
      const t = (op.textContent || '').trim(); if (!t) continue; this.snapshotElement(op); texts.push(t); targets.push(op);
    }
    if (!texts.length) return;
    const out = await this.batch(texts);
    for (let i = 0; i < targets.length; i++) {
      if (gen !== this.generation) return;
      const el = targets[i]; if (el.closest('[data-autotrans-ignore]')) continue; const src = texts[i]; const dst = out[i] || src;
      if (mode === 'inline') el.textContent = `${src} (${dst})`;
      else el.textContent = dst;
      el.setAttribute('data-autotranslated', 'true');
    }
  }

  render(el, src, dst, mode) { if (mode === 'inline') el.innerText = `${src} (${dst})`; else if (mode === 'tooltip') { el.setAttribute('title', dst); } else el.innerText = dst; el.setAttribute('data-autotranslated', 'true'); }

  async batch(texts) { const promises = texts.map(t => new Promise((resolve, reject) => this.queue.enqueue({ text: t, resolve, reject }))); return Promise.all(promises); }

  async translateAndCache(texts) {
    const src = this.settings.sourceLang || 'auto';
    const tgt = this.settings.targetLang || 'ko';
    const keys = texts.map(t => sha1([this.providerName, src, tgt, t].join('|')));
    const translated = await this.provider.translateMany(texts, src, tgt);
    for (let i = 0; i < texts.length; i++) { const k = keys[i]; const dst = translated[i] ?? texts[i]; this.lru.set(k, dst); this.diskCache.set(k, dst); }
    await this.diskCache.flush();
    return translated;
  }

  gatherTexts(root) {
    const els = this.collectTargets(root); const set = new Set();
    for (const el of els) {
      if (el.tagName === 'OPTION') { const t = (el.textContent || '').trim(); if (t) set.add(t); continue; }
      if (el.hasAttribute('title')) { const v = (el.getAttribute('title')||'').trim(); if (v) set.add(v); }
      if (el.hasAttribute('aria-label')) { const v = (el.getAttribute('aria-label')||'').trim(); if (v) set.add(v); }
      const t = (el.innerText || '').trim(); if (t) set.add(t);
    }
    return Array.from(set);
  }

  async waitFor(fn, timeout=5000, interval=100) { const start = Date.now(); while (Date.now()-start < timeout) { const el = fn(); if (el) return el; await sleep(interval); } return null; }

  async prebuildCacheAllSettings() {
    try {
      if (!this.provider) { new Notice('Set provider and key first'); return; }
      try { this.app.setting?.open?.(); } catch {}
      try { this.app.commands?.executeCommandById?.('app:open-settings'); } catch {}
      const modal = await this.waitFor(() => document.querySelector('.modal-container .modal.mod-settings, .modal-container.mod-settings, .mod-settings'), 5000, 100);
      const navItems = Array.from(document.querySelectorAll('.vertical-tabs-container .vertical-tab-nav-item'));
      const all = new Set();
      if (!navItems.length) { const content = document.querySelector('.vertical-tab-content') || document.body; this.gatherTexts(content).forEach(t => all.add(t)); }
      else {
        for (const item of navItems) { item.click(); await sleep(250); const content = document.querySelector('.vertical-tab-content') || modal || document.body; this.gatherTexts(content).forEach(t => all.add(t)); }
      }
      const arr = Array.from(all);
      const chunkSize = Math.max(1, this.settings.rateLimit?.batchSize || 20);
      for (let i=0; i<arr.length; i+=chunkSize) { const chunk = arr.slice(i, i+chunkSize); await this.translateAndCache(chunk); await sleep(Math.max(250, Math.floor(1000/Math.max(1, this.settings.rateLimit?.rps || 4)))); }
      await this.diskCache.flush(); this.settings.offlineOnly = true; await this.saveSettings(); new Notice(`Pre-translation done: ${arr.length} entries. Cache-only mode ON`);
    } catch (e) { console.error(e); new Notice('Pre-translation failed: ' + (e.message||e)); }
  }

  // Modal toggle injection
  injectModalToggle(container) {
    try {
      if (!(container instanceof HTMLElement)) return;
      const modalEl = container.querySelector('.modal') || container;
      // prioritize exact selector you provided
      let closeBtn = modalEl.querySelector('.modal-close-button')
        || modalEl.querySelector('.mod-close, .modal-close, .clickable-icon.mod-close, .modal-close-x, [aria-label="Close"], [aria-label="닫기"]');
      // header candidates
      let header = modalEl.querySelector('.modal-title, .modal-header') || (closeBtn ? closeBtn.parentElement : null) || modalEl.firstElementChild;
      if (!header) {
        console.warn('[auto-translate-ui] No modal header found');
        return;
      }
      if (header.querySelector('.autotrans-toggle')) return; // already injected

      const toggle = document.createElement('div');
      toggle.className = 'autotrans-toggle';
      const initOn = !!this.settings.enabled;
      toggle.dataset.state = initOn ? 'on' : 'off';
      toggle.innerHTML = `<span class="dot"></span><span class="label">${initOn ? '번역 ON' : '번역 OFF'}</span>`;

      // place near close button when possible; otherwise append to header
      if (closeBtn && closeBtn.parentElement === header) {
        header.insertBefore(toggle, closeBtn);
      } else if (closeBtn) {
        // absolute placement inside modal root
        modalEl.appendChild(toggle);
      } else {
        console.warn('[auto-translate-ui] modal close button not found (.modal-close-button). Appending toggle to header.');
        header.appendChild(toggle);
      }

      // ensure modal has positioning for absolute toggle
      if (getComputedStyle(modalEl).position === 'static') {
        modalEl.style.position = 'relative';
      }

      this.modalStates.set(container, initOn);
      const applyIsolation = (on) => {
        this.bumpGeneration();
        if (on) { modalEl.removeAttribute('data-autotrans-ignore'); this.scanAndTranslate(modalEl); }
        else { modalEl.setAttribute('data-autotrans-ignore','true'); this.restoreScope(modalEl); }
      };
      applyIsolation(initOn);
      toggle.addEventListener('click', () => {
        const cur = this.modalStates.get(container);
        const next = !cur; this.modalStates.set(container, next);
        toggle.dataset.state = next ? 'on' : 'off';
        toggle.querySelector('.label').textContent = next ? '번역 ON' : '번역 OFF';
        applyIsolation(next);
      });
    } catch (e) { console.warn('toggle inject fail', e); }
  }

  restoreScope(root) {
    const nodes = root.querySelectorAll('[data-autotranslated="true"], [title], [aria-label]');
    nodes.forEach(el => this.restoreElement(el));
  }
}

/* Settings Tab class fixed below */
class AutoTranslateSettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Auto Translate UI — Settings' });

    new Setting(containerEl)
      .setName('Enable translation')
      .addToggle(t => t.setValue(this.plugin.settings.enabled)
        .onChange(async v => { this.plugin.settings.enabled = v; await this.plugin.saveSettings(); if (!v) this.plugin.restoreScope(document.body); this.plugin.refreshAll(); }));

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Default is Azure Translator (F0). You can switch to Google or DeepL Free.')
      .addDropdown(dd => dd.addOptions({ azure: 'Azure', google: 'Google', deepl: 'DeepL' })
        .setValue(this.plugin.settings.provider)
        .onChange(async v => { this.plugin.settings.provider = v; this.plugin.setProvider(v); await this.plugin.saveSettings(); }));

    containerEl.createEl('h3', { text: 'API Keys' });
    new Setting(containerEl).setName('Azure Key')
      .addText(t => t.setPlaceholder('Ocp-Apim key').setValue(this.plugin.settings.apiKeys.azure.key)
        .onChange(async v => { this.plugin.settings.apiKeys.azure.key = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Azure Region (optional)')
      .addText(t => t.setPlaceholder('(e.g., eastasia)').setValue(this.plugin.settings.apiKeys.azure.region)
        .onChange(async v => { this.plugin.settings.apiKeys.azure.region = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Azure Endpoint (optional)')
      .addText(t => t.setPlaceholder('https://api.cognitive.microsofttranslator.com')
        .setValue(this.plugin.settings.apiKeys.azure.endpoint)
        .onChange(async v => { this.plugin.settings.apiKeys.azure.endpoint = v.trim() || 'https://api.cognitive.microsofttranslator.com'; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Google API Key')
      .addText(t => t.setPlaceholder('Google Translate API key').setValue(this.plugin.settings.apiKeys.google.key)
        .onChange(async v => { this.plugin.settings.apiKeys.google.key = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('DeepL API Key')
      .addText(t => t.setPlaceholder('DeepL-Auth-Key ...').setValue(this.plugin.settings.apiKeys.deepl.key)
        .onChange(async v => { this.plugin.settings.apiKeys.deepl.key = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('DeepL Endpoint (optional)')
      .addText(t => t.setPlaceholder('https://api-free.deepl.com').setValue(this.plugin.settings.apiKeys.deepl.endpoint)
        .onChange(async v => { this.plugin.settings.apiKeys.deepl.endpoint = v.trim() || 'https://api-free.deepl.com'; await this.plugin.saveSettings(); }));

    containerEl.createEl('h3', { text: 'Language & Mode' });
    new Setting(containerEl).setName('Source language')
      .addText(t => t.setPlaceholder('auto').setValue(this.plugin.settings.sourceLang)
        .onChange(async v => { this.plugin.settings.sourceLang = (v || 'auto').trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Target language')
      .addText(t => t.setPlaceholder('ko').setValue(this.plugin.settings.targetLang)
        .onChange(async v => { this.plugin.settings.targetLang = (v || 'ko').trim(); await this.plugin.saveSettings(); await this.plugin.diskCache.load(); }));
    new Setting(containerEl).setName('Render mode')
      .addDropdown(dd => dd.addOptions({ replace: 'Replace (default)',  tooltip: 'Tooltip only' })
        .setValue(this.plugin.settings.mode)
        .onChange(async v => { this.plugin.settings.mode = v; await this.plugin.saveSettings(); this.plugin.refreshAll(); }));

    containerEl.createEl('h3', { text: 'Selectors' });
    new Setting(containerEl).setName('Include selectors')
      .setDesc('Comma-separated CSS selectors to translate')
      .addTextArea(t => t.setValue(this.plugin.settings.includeSelectors.join(', '))
        .onChange(async v => { this.plugin.settings.includeSelectors = v.split(',').map(s => s.trim()).filter(Boolean); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Exclude selectors')
      .setDesc('Comma-separated CSS selectors to skip')
      .addTextArea(t => t.setValue(this.plugin.settings.excludeSelectors.join(', '))
        .onChange(async v => { this.plugin.settings.excludeSelectors = v.split(',').map(s => s.trim()).filter(Boolean); await this.plugin.saveSettings(); }));

    containerEl.createEl('h3', { text: 'Per-plugin custom selectors' });
    new Setting(containerEl)
      .setName('Plugin selectors JSON')
      .setDesc('Example: {"my-plugin": [".label", "select>option"]}')
      .addTextArea(t => t.setPlaceholder('{"plugin-id": [".selector"]}')
        .setValue(JSON.stringify(this.plugin.settings.pluginSelectors || {}, null, 2))
        .onChange(async v => { try { this.plugin.settings.pluginSelectors = JSON.parse(v || '{}'); await this.plugin.saveSettings(); } catch (e) { new Notice('Invalid JSON'); } }));

    containerEl.createEl('h3', { text: 'Cache & Rate Limit' });
    new Setting(containerEl).setName('Memory cache size (LRU)')
      .addText(t => t.setValue(String(this.plugin.settings.cacheLimit || 5000))
        .onChange(async v => { const n = Number(v)||5000; this.plugin.settings.cacheLimit = n; this.plugin.lru = new LRU(n); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Requests per second')
      .addText(t => t.setValue(String(this.plugin.settings.rateLimit.rps))
        .onChange(async v => { const n = Math.max(1, Number(v)||4); this.plugin.settings.rateLimit.rps = n; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Batch size')
      .addText(t => t.setValue(String(this.plugin.settings.rateLimit.batchSize))
        .onChange(async v => { const n = Math.max(1, Number(v)||20); this.plugin.settings.rateLimit.batchSize = n; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Use cache only (no API calls during render)')
      .setDesc('캐시에 없는 문자열은 원문으로 표시됩니다. 필요할 때만 아래 버튼으로 캐시를 업데이트하세요.')
      .addToggle(t => t.setValue(this.plugin.settings.offlineOnly)
        .onChange(async v => { this.plugin.settings.offlineOnly = v; await this.plugin.saveSettings(); new Notice(`Cache-only: ${v ? 'ON' : 'OFF'}`); }));

    new Setting(containerEl).setName('Pre-translate all settings (build cache)')
      .setDesc('설정 모달의 모든 탭을 순회하며 문자열을 수집·번역 후 캐시에 저장합니다. 완료 후 자동으로 Cache-only 모드가 켜집니다.')
      .addButton(b => b.setButtonText('Build now').onClick(async () => { await this.plugin.prebuildCacheAllSettings(); }));

    new Setting(containerEl).setName('Export cache')
      .addButton(b => b.setButtonText('Export').onClick(async () => { try { const raw = JSON.stringify(this.plugin.diskCache.map, null, 2); const path = `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/cache/export-${this.plugin.settings.targetLang}.json`; await this.app.vault.adapter.write(path, raw); new Notice('Exported cache to ' + path); } catch (e) { new Notice('Export failed'); } }));

    new Setting(containerEl).setName('Import cache (replace current)')
      .addButton(b => b.setButtonText('Import from file path').onClick(async () => {
        const path = await new Promise(res => { const p = prompt('Enter path to JSON file (inside vault):', `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/cache/export-${this.plugin.settings.targetLang}.json`); res(p); });
        if (!path) return;
        try { const raw = await this.plugin.app.vault.adapter.read(path); const obj = JSON.parse(raw); this.plugin.diskCache.map = obj || {}; await this.plugin.diskCache.flush(); new Notice('Imported cache from ' + path); }
        catch (e) { console.error(e); new Notice('Import failed'); }
      }));

    containerEl.createEl('h3', { text: 'Diagnostics' });
    new Setting(containerEl).setName('Test translate "Hello"')
      .addButton(b => b.setButtonText('Run').onClick(async () => { try { const r = await this.plugin.translateMany(['Hello']); new Notice('Result: ' + r[0]); } catch (e) { new Notice('Failed: ' + (e.message || e)); } }));
  }
}
