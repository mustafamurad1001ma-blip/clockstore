/* Real-time system: every change is saved to the online database, written to the activity log,
   and pushed live to every device that uses the same store sync code. */
(() => {
  const DATA_KEYS = {
    categories: 'toy_categories', products: 'toy_products', workers: 'toy_workers',
    transactions: 'toy_transactions', cashOuts: 'toy_cashouts', repairs: 'toy_repairs',
    orders: 'toy_orders', storeInvoices: 'toy_store_invoices',
    workerInvoices: 'toy_worker_invoices', dailyEarnings: 'toy_daily_earnings'
  };
  const LABELS = {
    categories: 'Kategori', products: 'Ürün', workers: 'Çalışan', transactions: 'Satış',
    cashOuts: 'Kasa çıkışı', repairs: 'Tamir', orders: 'Sipariş', storeInvoices: 'Dükkan faturası',
    workerInvoices: 'Çalışan faturası', dailyEarnings: 'Günlük gelir'
  };
  const CFG_KEY = 'toy_live_sync_v1';
  const PENDING_KEY = 'toy_live_pending_v1';
  const FORCE_KEY = 'toy_live_force_push';
  const POLL_MS = 2500;
  const API = '/api/sync';
  const $ = id => document.getElementById(id);
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => (Number(n) || 0).toLocaleString('en-US') + ' IQD';
  const keyOf = it => (it && typeof it === 'object' && it.id != null ? 'id:' + it.id : 'v:' + JSON.stringify(it));
  const nameOf = it => {
    if (it == null || typeof it !== 'object') return String(it);
    return it.name || it.customer || it.title || it.worker || it.device || it.code || ('#' + (it.id || '?'));
  };
  const emptyOps = () => ({});

  function snapshot(app) {
    const o = {};
    for (const prop of Object.keys(DATA_KEYS)) o[prop] = clone(Array.isArray(app[prop]) ? app[prop] : []);
    return o;
  }

  // ---------- Diffing: turn two snapshots into merge-able ops + human readable actions ----------
  function diff(prev, next) {
    const ops = {}; const actions = [];
    for (const coll of Object.keys(DATA_KEYS)) {
      const a = (prev && prev[coll]) || []; const b = next[coll] || [];
      const am = new Map(a.map(it => [keyOf(it), it]));
      const bm = new Map(b.map((it, i) => [keyOf(it), { it, i }]));
      const added = [], changed = [], removed = [];
      for (const [k, { it, i }] of bm) {
        if (!am.has(k)) added.push({ k, it, front: i === 0 && b.length > 1 });
        else if (JSON.stringify(am.get(k)) !== JSON.stringify(it)) changed.push({ k, it, old: am.get(k), front: i === 0 && b.length > 1 });
      }
      for (const [k, it] of am) if (!bm.has(k)) removed.push({ k, it });
      if (!added.length && !changed.length && !removed.length) continue;
      const op = ops[coll] = { upsert: {}, remove: {} };
      for (const x of [...added, ...changed]) op.upsert[x.k] = { item: x.it, front: x.front };
      for (const x of removed) op.remove[x.k] = true;
      actions.push(...describe(coll, added, changed, removed));
    }
    return { ops, actions };
  }

  function txDetails(t) {
    const items = (t.items || []).map(x => `${x.name || x.code || ''}${x.colorName ? ' (' + x.colorName + ')' : ''} ×${x.qty || 1}`).join(', ');
    return `${items}${items ? ' — ' : ''}Toplam: ${money(t.total)}${t.seller ? ' — Satıcı: ' + t.seller : ''}`;
  }

  function changedFields(oldIt, newIt) {
    if (!oldIt || !newIt || typeof oldIt !== 'object') return [];
    const keys = new Set([...Object.keys(oldIt), ...Object.keys(newIt)]);
    const out = [];
    for (const k of keys) {
      if (k === 'image') { if (oldIt[k] !== newIt[k]) out.push('fotoğraf'); continue; }
      const a = oldIt[k], b = newIt[k];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      const fmt = v => (v != null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—'));
      out.push(`${k}: ${fmt(a).slice(0, 60)} → ${fmt(b).slice(0, 60)}`);
    }
    return out;
  }

  function summaryOf(coll, it) {
    const bits = [];
    if (it && typeof it === 'object') {
      if (coll === 'products') bits.push(`Kod: ${it.code || '—'}`, `Stok: ${it.stock ?? 0}`, `Satış fiyatı: ${money(it.sellPrice)}`);
      else {
        if (it.amount != null) bits.push(`Tutar: ${money(it.amount)}`);
        if (it.total != null) bits.push(`Toplam: ${money(it.total)}`);
        if (it.price != null) bits.push(`Fiyat: ${money(it.price)}`);
        if (it.type) bits.push(`Tür: ${it.type}`);
        if (it.status) bits.push(`Durum: ${it.status}`);
        if (it.phone) bits.push(`Tel: ${it.phone}`);
        if (it.reason) bits.push(`Neden: ${it.reason}`);
        if (it.notes) bits.push(`Not: ${String(it.notes).slice(0, 80)}`);
      }
    }
    return bits.join(' — ');
  }

  function describe(coll, added, changed, removed) {
    const label = LABELS[coll]; const out = [];
    const many = (list, verb) => {
      out.push({ section: label, action: `${list.length} ${label.toLowerCase()} kaydı ${verb}`, details: list.slice(0, 15).map(x => nameOf(x.it)).join(', ') + (list.length > 15 ? '…' : '') });
    };

    if (coll === 'transactions') {
      for (const x of added) {
        const t = x.it;
        if (t.type === 'SALE') out.push({ section: 'Satış', action: 'Satış yapıldı', details: txDetails(t) });
        else if (t.type === 'REFUND') out.push({ section: 'Satış', action: 'İade yapıldı', details: txDetails(t) });
        else out.push({ section: 'Satış', action: `İşlem eklendi (${t.type || '—'})`, details: txDetails(t) });
      }
      for (const x of changed) out.push({ section: 'Satış', action: 'Satış kaydı güncellendi', details: changedFields(x.old, x.it).join('; ') });
      if (removed.length > 5) many(removed, 'silindi');
      else for (const x of removed) out.push({ section: 'Satış', action: 'Satış kaydı silindi', details: txDetails(x.it) });
      return out;
    }

    if (coll === 'categories') {
      for (const x of added) out.push({ section: label, action: `Kategori eklendi: ${x.it}` });
      for (const x of removed) out.push({ section: label, action: `Kategori silindi: ${x.it}` });
      return out;
    }

    if (added.length > 8) many(added, 'eklendi');
    else for (const x of added) out.push({ section: label, action: `${label} eklendi: ${nameOf(x.it)}`, details: summaryOf(coll, x.it) });

    if (coll === 'products') {
      // Group stock-only changes (e.g. caused by a sale) into a single entry.
      const stockOnly = [], other = [];
      for (const x of changed) {
        const f = changedFields(x.old, x.it).filter(s => !/^(stock|colorStocks):/.test(s));
        (f.length ? other : stockOnly).push(x);
      }
      if (stockOnly.length) out.push({ section: 'Stok', action: stockOnly.length === 1 ? `Stok değişti: ${nameOf(stockOnly[0].it)}` : `${stockOnly.length} üründe stok değişti`, details: stockOnly.map(x => `${nameOf(x.it)}: ${x.old.stock ?? 0} → ${x.it.stock ?? 0}`).join(', ') });
      if (other.length > 8) many(other, 'güncellendi');
      else for (const x of other) out.push({ section: label, action: `Ürün düzenlendi: ${nameOf(x.it)}`, details: changedFields(x.old, x.it).join('; ') });
    } else if (changed.length > 8) many(changed, 'güncellendi');
    else for (const x of changed) {
      const statusChanged = x.old && x.it && x.old.status !== x.it.status;
      out.push({ section: label, action: statusChanged ? `${label} durumu değişti: ${nameOf(x.it)}` : `${label} güncellendi: ${nameOf(x.it)}`, details: changedFields(x.old, x.it).join('; ') });
    }

    if (removed.length > 8) many(removed, 'silindi');
    else for (const x of removed) out.push({ section: label, action: `${label} silindi: ${nameOf(x.it)}`, details: summaryOf(coll, x.it) });
    return out;
  }

  // Later ops win over earlier ones.
  function mergeOps(base, later) {
    const out = clone(base) || {};
    for (const [coll, op] of Object.entries(later || {})) {
      const t = out[coll] || (out[coll] = { upsert: {}, remove: {} });
      for (const [k, v] of Object.entries(op.upsert)) { t.upsert[k] = v; delete t.remove[k]; }
      for (const k of Object.keys(op.remove)) { t.remove[k] = true; delete t.upsert[k]; }
    }
    return out;
  }

  // Replay this device's unsynced changes on top of the newer server data.
  function rebase(remote, ops) {
    const out = {};
    for (const coll of Object.keys(DATA_KEYS)) {
      let arr = Array.isArray(remote && remote[coll]) ? clone(remote[coll]) : [];
      const op = ops[coll];
      if (op) {
        arr = arr.filter(it => !op.remove[keyOf(it)]);
        const idx = new Map(arr.map((it, i) => [keyOf(it), i]));
        for (const [k, { item, front }] of Object.entries(op.upsert)) {
          if (idx.has(k)) arr[idx.get(k)] = item;
          else if (front) arr.unshift(item);
          else arr.push(item);
        }
      }
      out[coll] = arr;
    }
    return out;
  }

  const hasOps = ops => Object.keys(ops || {}).length > 0;

  // ---------------------------------- Sync engine ----------------------------------
  const sync = window.cloudSync = {
    suppress: false,
    cfg: null,
    lastSnap: null,
    ops: emptyOps(),
    actions: [],
    inFlight: false,
    again: false,
    flushTimer: null,
    pollTimer: null,
    retryTimer: null,
    online: false,
    logEntries: [],
    logDone: false,

    readCfg() { try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch (_) { return null; } },
    saveCfg() { if (this.cfg) localStorage.setItem(CFG_KEY, JSON.stringify(this.cfg)); else localStorage.removeItem(CFG_KEY); },
    savePending() {
      try {
        if (!hasOps(this.ops) && !this.actions.length) localStorage.removeItem(PENDING_KEY);
        else localStorage.setItem(PENDING_KEY, JSON.stringify({ ops: this.ops, actions: this.actions }));
      } catch (e) { console.warn('Pending queue could not be saved', e); }
    },
    loadPending() {
      try { const p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); if (p) { this.ops = p.ops || {}; this.actions = p.actions || []; } } catch (_) {}
    },

    togglePanel() {
      const p = $('cloud-panel'); const open = p.style.display === 'none';
      p.style.display = open ? 'block' : 'none';
      if (open && this.cfg) { $('sync-code').value = this.cfg.code; $('sync-device').value = this.cfg.device || ''; }
    },

    status(message, state) {
      const e = $('cloud-status');
      const colors = { live: ['#E8F1E7', '#3F6B43', '#34A853'], busy: ['#FFF4E0', '#8A5A00', '#F5A623'], error: ['#FBE9E7', '#A23B2A', '#E5484D'], idle: ['#F2ECE4', '#273247', '#B8B2A7'] }[state || 'idle'];
      if (e) { e.textContent = message; e.style.background = colors[0]; e.style.color = colors[1]; }
      const dot = $('live-dot'); if (dot) dot.style.background = colors[2];
      const lbl = $('live-label');
      if (lbl) lbl.textContent = { live: 'Canlı', busy: 'Kaydediliyor…', error: 'Çevrimdışı', idle: 'Canlı kayıt' }[state || 'idle'];
    },

    device() { return (this.cfg && this.cfg.device) || 'Cihaz'; },
    actor() { return (window.app && window.app.currentUser) || null; },

    async api(path, opts = {}) {
      const res = await fetch(API + path, {
        ...opts,
        headers: { 'content-type': 'application/json', 'x-store-code': this.cfg.code, ...(opts.headers || {}) },
        cache: 'no-store'
      });
      let data = null; try { data = await res.json(); } catch (_) {}
      return { ok: res.ok, status: res.status, data };
    },

    applyPayload(payload) {
      if (!payload || typeof payload !== 'object' || !window.app) return;
      this.suppress = true;
      try {
        for (const [prop, key] of Object.entries(DATA_KEYS)) {
          if (Array.isArray(payload[prop])) {
            window.app[prop] = clone(payload[prop]);
            try { localStorage.setItem(key, JSON.stringify(payload[prop])); } catch (e) { console.warn('Local copy not saved', e); }
          }
        }
        window.app.renderAll();
        if (typeof window.app.renderOrders === 'function') window.app.renderOrders();
      } finally { this.suppress = false; }
      this.lastSnap = snapshot(window.app);
    },

    // Called by app.saveStorage() after every change.
    schedule(app) {
      if (!this.cfg) return;
      const snap = snapshot(app);
      const { ops, actions } = diff(this.lastSnap, snap);
      this.lastSnap = snap;
      if (!hasOps(ops)) return;
      const actor = this.actor(); const at = new Date().toISOString();
      this.ops = mergeOps(this.ops, ops);
      this.actions.push(...actions.map(a => ({ ...a, actor, at })));
      this.savePending();
      this.status('Kaydediliyor…', 'busy');
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), 350);
    },

    // Log an event that doesn't change data (login, logout, …).
    logEvent(action, section, details) {
      if (!this.cfg) return;
      this.actions.push({ action, section, details: details || null, actor: this.actor(), at: new Date().toISOString() });
      this.savePending();
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), 200);
    },

    async flush(attempt = 0) {
      if (!this.cfg) return;
      if (this.inFlight) { this.again = true; return; }
      if (!hasOps(this.ops) && !this.actions.length) return;
      this.inFlight = true;
      let retryConflict = false;
      clearTimeout(this.retryTimer);
      const sentOps = this.ops, sentActions = this.actions;
      this.ops = emptyOps(); this.actions = [];
      const restore = () => { this.ops = mergeOps(sentOps, this.ops); this.actions = sentActions.concat(this.actions); this.savePending(); };
      try {
        let r;
        if (hasOps(sentOps)) {
          r = await this.api('/state', { method: 'PUT', body: JSON.stringify({ payload: snapshot(window.app), baseVersion: this.cfg.version || 0, actions: sentActions, device: this.device(), actor: this.actor() }) });
        } else {
          r = await this.api('/log', { method: 'POST', body: JSON.stringify({ actions: sentActions, device: this.device(), actor: this.actor() }) });
        }
        if (r.ok) {
          if (r.data && typeof r.data.version === 'number') { this.cfg.version = r.data.version; this.saveCfg(); }
          this.savePending();
          this.online = true;
          this.status('⚡ Canlı — tüm işlemler kaydedildi (' + new Date().toLocaleTimeString('tr-TR') + ')', 'live');
          this.refreshLogIfVisible();
        } else if (r.status === 409 && r.data && r.data.current && attempt < 5) {
          // Someone else saved first: merge our changes on top of theirs and try again.
          restore();
          const cur = r.data.current;
          this.applyPayload(rebase(cur.payload, this.ops));
          this.cfg.version = cur.version; this.saveCfg();
          retryConflict = true;
        } else {
          restore();
          this.status(r.status === 413 ? 'Veri çok büyük — ürün fotoğraflarını küçültün. İşlemler bu cihazda bekliyor.' : 'Sunucu hatası — işlemler bu cihazda bekliyor, tekrar denenecek.', 'error');
          this.retryTimer = setTimeout(() => this.flush(), 8000);
        }
      } catch (e) {
        restore();
        this.online = false;
        this.status('İnternet yok — ' + (hasOps(this.ops) || this.actions.length ? 'işlemler bu cihazda bekletiliyor, bağlantı gelince gönderilecek.' : 'bağlantı bekleniyor.'), 'error');
        this.retryTimer = setTimeout(() => this.flush(), 5000);
      } finally {
        this.inFlight = false;
      }
      if (retryConflict) { this.again = false; return this.flush(attempt + 1); }
      if (this.again) { this.again = false; this.flush(); }
    },

    async poll() {
      if (!this.cfg || this.inFlight || hasOps(this.ops) || this.actions.length) return;
      try {
        const r = await this.api('/state?since=' + (this.cfg.version || 0));
        if (!r.ok) { if (r.status === 401) this.status('Senkronizasyon kodu geçersiz.', 'error'); return; }
        // Re-check: a local change may have happened while the request was in flight.
        if (this.inFlight || hasOps(this.ops)) return;
        const d = r.data;
        if (d && d.payload && d.version > (this.cfg.version || 0)) {
          this.applyPayload(d.payload);
          this.cfg.version = d.version; this.saveCfg();
          this.status('⚡ Canlı — ' + (d.updatedBy || 'başka cihaz') + ' cihazından güncellendi (' + new Date().toLocaleTimeString('tr-TR') + ')', 'live');
          this.refreshLogIfVisible();
        } else if (!this.online) {
          this.status('⚡ Canlı bağlantı açık — gerçek zamanlı kayıt aktif', 'live');
        }
        this.online = true;
      } catch (_) {
        if (this.online) this.status('İnternet yok — bağlantı bekleniyor.', 'error');
        this.online = false;
      }
    },

    startPolling() {
      clearTimeout(this.pollTimer);
      const gen = this.pollGen = (this.pollGen || 0) + 1;
      const loop = async () => {
        if (gen !== this.pollGen) return;
        await this.poll();
        if (!this.cfg || gen !== this.pollGen) return;
        this.pollTimer = setTimeout(loop, document.hidden ? POLL_MS * 6 : POLL_MS);
      };
      loop();
    },

    async connectFromForm() {
      const code = $('sync-code').value.trim();
      const device = $('sync-device').value.trim() || 'Cihaz';
      if (code.length < 6) { this.status('Senkronizasyon kodu en az 6 karakter olmalı.', 'error'); return; }
      const sameStore = this.cfg && this.cfg.code === code;
      this.cfg = { code, device, version: sameStore ? this.cfg.version : 0 };
      this.status('Bağlanılıyor…', 'busy');
      let r;
      try { r = await this.api('/state?since=0'); } catch (_) { this.status('Sunucuya ulaşılamadı. İnternet bağlantısını kontrol et.', 'error'); return; }
      if (!r.ok) { this.status('Bağlantı hatası (' + r.status + ').', 'error'); return; }
      this.saveCfg();
      this.lastSnap = snapshot(window.app);
      const d = r.data || {};
      if (!d.version) {
        await this.forcePush('Canlı kayıt sistemi başlatıldı — ilk veriler yüklendi');
      } else if (sameStore) {
        if (hasOps(this.ops) || this.actions.length) this.flush();
      } else if (confirm('Bu mağaza kodu için online veriler bulundu.\n\nTamam: Online verileri bu cihaza yükle (önerilen)\nİptal: Bu cihazdaki verileri online verilerin yerine gönder')) {
        this.ops = emptyOps(); this.actions = []; this.savePending();
        this.applyPayload(d.payload);
        this.cfg.version = d.version; this.saveCfg();
        this.logEvent('Cihaz canlı sisteme bağlandı', 'Sistem');
        this.status('⚡ Bağlandı — online veriler yüklendi, canlı kayıt aktif', 'live');
      } else {
        await this.forcePush('Cihaz verileri online verilerin yerine gönderildi');
      }
      this.startPolling();
    },

    async forcePush(reason) {
      if (!this.cfg) { this.status('Önce mağaza koduyla bağlan.', 'error'); return; }
      this.ops = emptyOps();
      const actions = this.actions.concat([{ action: reason, section: 'Sistem', actor: this.actor(), at: new Date().toISOString() }]);
      this.actions = [];
      this.status('Gönderiliyor…', 'busy');
      try {
        const r = await this.api('/state', { method: 'PUT', body: JSON.stringify({ payload: snapshot(window.app), force: true, actions, device: this.device(), actor: this.actor() }) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        this.cfg.version = r.data.version; this.saveCfg();
        this.lastSnap = snapshot(window.app);
        this.savePending();
        this.status('⚡ ' + reason + ' — canlı kayıt aktif', 'live');
        this.refreshLogIfVisible();
      } catch (e) {
        this.actions = actions.concat(this.actions); this.savePending();
        this.status('Gönderilemedi: ' + e.message, 'error');
      }
    },

    pushLocal() {
      if (!this.cfg) { this.status('Önce mağaza koduyla bağlan.', 'error'); return; }
      if (!confirm('Bu cihazdaki veriler online verilerin yerine geçecek. Devam edilsin mi?')) return;
      this.forcePush('Cihaz verileri buluta aktarıldı');
    },

    async pullCloud() {
      if (!this.cfg) { this.status('Önce mağaza koduyla bağlan.', 'error'); return; }
      if (!confirm('Online veriler bu cihazdaki kayıtların yerine geçecek. Devam edilsin mi?')) return;
      try {
        const r = await this.api('/state?since=0');
        if (!r.ok || !r.data || !r.data.payload) { this.status('Online kayıt bulunamadı.', 'error'); return; }
        this.ops = emptyOps(); this.actions = []; this.savePending();
        this.applyPayload(r.data.payload);
        this.cfg.version = r.data.version; this.saveCfg();
        this.status('Online veriler bu cihaza yüklendi.', 'live');
      } catch (_) { this.status('Sunucuya ulaşılamadı.', 'error'); }
    },

    disconnect() {
      if (!this.cfg) return;
      if ((hasOps(this.ops) || this.actions.length) && !confirm('Gönderilmemiş işlemler var. Yine de bağlantı kesilsin mi?')) return;
      clearTimeout(this.pollTimer); clearTimeout(this.retryTimer); clearTimeout(this.flushTimer);
      this.pollGen = (this.pollGen || 0) + 1;
      this.cfg = null; this.saveCfg();
      this.ops = emptyOps(); this.actions = []; this.savePending();
      this.status('Bağlantı kesildi. Veriler sadece bu cihazda saklanıyor.', 'idle');
    },

    // ---------------------------------- Activity log page ----------------------------------
    openLog() {
      $('cloud-panel').style.display = 'none';
      const btn = [...document.querySelectorAll('.nav-btn')].find(b => (b.getAttribute('onclick') || '').includes("'activity'"));
      if (btn) btn.click(); else if (window.app) window.app.navigate('activity');
    },

    refreshLogIfVisible() {
      const s = $('screen-activity');
      if (s && s.classList.contains('active')) this.loadLog();
    },

    async loadLog(more = false) {
      const st = $('activity-status');
      if (!this.cfg) {
        this.logEntries = []; this.renderLog();
        if (st) st.innerHTML = 'Canlı kayıt kapalı. Üstteki <b>Canlı kayıt</b> düğmesinden mağaza koduyla bağlanın.';
        return;
      }
      try {
        const before = more && this.logEntries.length ? '&before=' + this.logEntries[this.logEntries.length - 1].id : '';
        const r = await this.api('/log?limit=200' + before);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const entries = r.data.entries || [];
        this.logEntries = more ? this.logEntries.concat(entries) : entries;
        this.logDone = entries.length < 200;
        const pending = this.actions.length;
        if (st) st.textContent = `${this.logEntries.length} kayıt gösteriliyor` + (pending ? ` — ${pending} işlem gönderilmeyi bekliyor` : '') + ' — son güncelleme ' + new Date().toLocaleTimeString('tr-TR');
      } catch (e) {
        if (st) st.textContent = 'Kayıtlar yüklenemedi: ' + e.message;
      }
      this.renderLog();
    },

    renderLog() {
      const body = $('activity-body'); if (!body) return;
      const q = (($('activity-filter') || {}).value || '').trim().toLowerCase();
      const rows = this.logEntries.filter(e => !q || [e.action, e.section, e.details, e.actor, e.device].join(' ').toLowerCase().includes(q));
      body.innerHTML = rows.map(e => `<tr>
        <td style="white-space:nowrap">${esc(new Date(e.createdAt).toLocaleString('tr-TR'))}</td>
        <td>${esc(e.section || '—')}</td>
        <td><b>${esc(e.action)}</b></td>
        <td style="font-size:.82rem;color:var(--text-muted);max-width:420px">${esc(e.details || '')}</td>
        <td>${esc(e.actor || '—')}</td>
        <td>${esc(e.device || '—')}</td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center">Henüz kayıt yok</td></tr>';
      const more = $('activity-more'); if (more) more.style.display = this.logDone || q ? 'none' : 'inline-flex';
    }
  };

  // Log login / logout / finance access attempts as well.
  function wrapAppEvents(app) {
    const login = app.login.bind(app);
    app.login = function () {
      const user = document.getElementById('login-user-select').value;
      login();
      if (this.currentUser) sync.logEvent('Giriş yapıldı', 'Oturum', 'Kullanıcı: ' + this.currentUser);
      else sync.logEvent('Hatalı giriş denemesi', 'Oturum', 'Seçilen kullanıcı: ' + user);
    };
    const logout = app.logout.bind(app);
    app.logout = function () {
      const user = this.currentUser;
      if (user) sync.logEvent('Çıkış yapıldı', 'Oturum', 'Kullanıcı: ' + user);
      logout();
    };
    const fin = app.authFinancial.bind(app);
    app.authFinancial = function () {
      fin();
      sync.logEvent(this.finAuthed ? 'Finans bölümüne giriş yapıldı' : 'Finans bölümü: hatalı PIN', 'Finans');
    };
  }

  window.addEventListener('load', () => {
    const app = window.app; if (!app) return;
    wrapAppEvents(app);
    sync.cfg = sync.readCfg();
    if (!sync.cfg || !sync.cfg.code) { sync.cfg = null; sync.status('Canlı kayıt kapalı — bağlanmak için mağaza kodunu girin.', 'idle'); return; }
    sync.loadPending();
    sync.lastSnap = snapshot(app);
    if (localStorage.getItem(FORCE_KEY)) {
      localStorage.removeItem(FORCE_KEY);
      sync.forcePush('Yedek dosyası içe aktarıldı').then(() => sync.startPolling());
      return;
    }
    sync.status('Bağlanılıyor…', 'busy');
    if (hasOps(sync.ops) || sync.actions.length) sync.flush();
    sync.startPolling();
  });
  window.addEventListener('online', () => { if (sync.cfg) { sync.flush(); sync.poll(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && sync.cfg) sync.startPolling(); });
})();
