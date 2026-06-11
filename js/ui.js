/* VMVisualizer — UI layer: rendering of the five views from engine snapshots,
 * plus the Next/Prev/Run/Pause/Reset timeline navigation.
 * Depends on window.VMEngine and window.VMExamples. */
(function (root) {
  'use strict';
  const E = root.VMEngine, EX = root.VMExamples;
  const $ = id => document.getElementById(id);
  const MAX_CELLS = 256; // safety cap for grid rendering

  // Parse "64KB", "16 K", "1MB", "256B", or a raw byte count -> integer bytes.
  function parseSize(str) {
    if (str == null) return NaN;
    const m = String(str).trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*(B|KB|K|MB|M|GB|G)?$/);
    if (!m) return NaN;
    const mult = { '': 1, B: 1, K: 1024, KB: 1024, M: 1048576, MB: 1048576, G: 1073741824, GB: 1073741824 };
    return Math.round(parseFloat(m[1]) * mult[m[2] || '']);
  }

  // integer bytes -> friendly "64KB" / "1MB" / "256B"
  function formatSize(bytes) {
    if (bytes >= 1048576 && bytes % 1048576 === 0) return (bytes / 1048576) + 'MB';
    if (bytes >= 1024 && bytes % 1024 === 0) return (bytes / 1024) + 'KB';
    return bytes + 'B';
  }

  function UI() {
    this.cfg = null; this.engine = null; this.requests = []; this.timeline = []; this.pos = 0;
    this.timer = null;
  }

  // ---- configuration --------------------------------------------------------
  UI.prototype.readForm = function () {
    const pteRaw = ($('pteSize').value || '').trim();   // optional: only matters for multilevel
    return {
      vas: parseSize($('vas').value), pas: parseSize($('pas').value), pageSize: parseSize($('pageSize').value),
      pteSize: pteRaw ? parseSize(pteRaw) : 4,
      tlbEntries: +$('tlbEntries').value,
      tlbPolicy: String($('tlbPolicy').value || '').trim().toUpperCase(),
      replPolicy: String($('replPolicy').value || '').trim().toUpperCase(),
      levels: +$('levels').value
    };
  };

  // wipe the configuration and all views (fresh start)
  UI.prototype.clear = function () {
    this.pause();
    this.cfg = null; this.engine = null; this.requests = []; this.timeline = []; this.pos = 0;
    ['tlbView', 'pageTableView', 'physicalView', 'breakdownView', 'statsView', 'reqQueue']
      .forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });
    $('progress').textContent = '';
    $('addrSummary').innerHTML = ''; $('configError').textContent = '';
    $('tlbPolicyTag').textContent = ''; $('ptLevelsTag').textContent = '';
    $('stepBadge').textContent = 'Ready';
    $('infoText').textContent = 'Configuration cleared. Enter values and press Apply Configuration.';
    $('conceptText').textContent = '';
  };

  UI.prototype.apply = function () {
    const cfg = E.buildConfig(this.readForm());
    if (!cfg.ok) { $('configError').textContent = cfg.errors.join('  '); return false; }
    $('configError').textContent = '';
    this.cfg = cfg;
    $('addrSummary').innerHTML =
      `VA = ${cfg.vaBits} bits  ·  PA = ${cfg.paBits} bits  ·  offset = ${cfg.offsetBits} bits  ·  ` +
      `VPN = ${cfg.vpnBits} bits` +
      (cfg.levels > 1 ? ` split as [${cfg.levelBits.join(' | ')}]` : '') +
      `  ·  ${cfg.numPages} pages  ·  ${cfg.numFrames} frames` +
      (cfg.levels > 1 ? `  ·  PTE ${formatSize(cfg.pteSize)} → ${cfg.entriesPerTable} entries / inner table` : '');
    $('tlbPolicyTag').textContent = cfg.tlbPolicy;
    $('replPolicyTag').textContent = cfg.replPolicy + ' repl';
    $('ptLevelsTag').textContent = cfg.levels + (cfg.levels > 1 ? '-level' : '-level');
    this.rebuild();
    return true;
  };

  // ---- timeline -------------------------------------------------------------
  UI.prototype.rebuild = function () {
    if (!this.cfg) return;
    this.engine = new E.Engine(this.cfg);
    // step 0: freshly-initialized state — empty TLB, page table all-invalid, free frames
    const init = {
      stage: 0, title: 'Configuration applied',
      explain: 'TLB and page table are initialized: every entry is present but its valid bit is 0 (no mapping yet). ' +
               'Physical memory is entirely free. Add requests, then press Next Step to begin translating.',
      breakdown: null, vpn: null, offset: null, indices: [], highlight: null, reqIndex: -1,
      snapshot: this.engine._snapshot({})
    };
    this.timeline = [init];
    this.requests.forEach((va, i) => {
      const steps = this.engine.access(va);
      steps.forEach(s => { s.reqIndex = i; });   // which request (by position) this step belongs to
      this.timeline = this.timeline.concat(steps);
    });
    this.pos = 0;
    this.render();
  };

  UI.prototype.next = function () { if (this.pos < this.timeline.length - 1) { this.pos++; this.render(); } else this.pause(); };
  UI.prototype.prev = function () { if (this.pos > 0) { this.pos--; this.render(); } };
  UI.prototype.reset = function () { this.pause(); this.rebuild(); };
  UI.prototype.run = function () {
    this.pause();
    const speed = +$('speed').value;
    this.timer = setInterval(() => this.next(), speed);
  };
  UI.prototype.pause = function () { if (this.timer) { clearInterval(this.timer); this.timer = null; } };

  // ---- requests -------------------------------------------------------------
  UI.prototype.addRequest = function (text) {
    if (!text) return;
    // accept several addresses separated by commas / spaces / newlines
    const tokens = String(text).split(/[\s,]+/).filter(Boolean);
    let added = 0;
    tokens.forEach(tok => {
      const va = tok.toLowerCase().startsWith('0x') ? parseInt(tok, 16) : parseInt(tok, 10);
      if (!Number.isNaN(va)) { this.requests.push(va); added++; }
    });
    if (added) { this.renderQueue(); this.rebuild(); }
  };
  UI.prototype.clearRequests = function () { this.requests = []; this.renderQueue(); this.rebuild(); };
  UI.prototype.generate = function () {
    if (!this.cfg) return;
    this.requests = this.requests.concat(EX.generateWorkload(this.cfg, 10));
    this.renderQueue(); this.rebuild();
  };

  UI.prototype.renderQueue = function () {
    const cur = this.timeline[this.pos];
    const curIdx = (cur && cur.reqIndex != null) ? cur.reqIndex : -1;  // highlight by POSITION, not value
    $('reqQueue').innerHTML = this.requests.map((va, i) =>
      `<span class="chip${i === curIdx ? ' active' : ''}">${E.toHex(va, this.cfg ? this.cfg.vaBits : 16)}</span>`).join('');
  };

  // ---- master render --------------------------------------------------------
  UI.prototype.render = function () {
    const step = this.timeline[this.pos];
    $('progress').textContent = this.timeline.length
      ? `step ${this.pos + 1} / ${this.timeline.length}` : 'no requests';
    if (!step) { this.renderQueue(); return; }
    const snap = step.snapshot, hl = step.highlight || {};
    $('stepBadge').textContent = step.stage ? ('Step ' + step.stage + ' — ' + step.title) : step.title;
    $('infoText').textContent = step.explain;
    $('conceptText').textContent = step.concept || '';
    this.renderQueue();
    this.renderBreakdown(step);
    this.renderTLB(snap, hl);
    this.renderPageTable(step, snap, hl);
    this.renderPhysical(snap, hl);
    this.renderStats(snap.stats);
    this.setActive(hl.component);
  };

  // outline the panel that currently has control
  UI.prototype.setActive = function (component) {
    ['panel-tlb', 'panel-pagetable', 'panel-physical', 'panel-breakdown']
      .forEach(id => { const el = $(id); if (el) el.classList.remove('active-panel'); });
    const map = { tlb: 'panel-tlb', pagetable: 'panel-pagetable', physical: 'panel-physical', breakdown: 'panel-breakdown' };
    const el = $(map[component]); if (el) el.classList.add('active-panel');
  };

  // 5 · address breakdown
  UI.prototype.renderBreakdown = function (step) {
    const b = step.breakdown, c = this.cfg;
    if (!b) { $('breakdownView').innerHTML =
      '<div class="pt-note">No address selected yet. Press <b>Next Step</b> to translate the first request.</div>'; return; }

    // a coloured bit-cell row, first `splitBits` cells = high part, rest = offset
    const bitRow = (bin, highBits, highCls) => {
      let s = '<div class="bd-row"><span class="bd-label">Binary</span><span class="bits">';
      bin.split('').forEach((bit, i) => { s += `<span class="bit ${i < highBits ? highCls : 'offset'}">${bit}</span>`; });
      return s + '</span></div>';
    };

    // ---- Virtual address ---------------------------------------------------
    let html = `<div class="bd-row"><span class="bd-label">Virtual address</span><b>${b.vaHex}</b> = ${b.va} (dec)</div>`;
    html += bitRow(b.vaBin, c.vpnBits, 'vpn');

    // ---- Physical address — same representation, shown after the response --
    const pa = step.snapshot.pa;
    if (pa != null) {
      html += `<div class="bd-sep"></div>`;
      html += `<div class="bd-row"><span class="bd-label">Physical address</span><b>${step.snapshot.paHex}</b> = ${pa} (dec)</div>`;
      html += bitRow(E.toBinary(pa, c.paBits), c.pfnBits, 'frame');
    } else {
      html += `<div class="bd-sep"></div><div class="pt-note">Physical address — pending; complete the lookup.</div>`;
    }
    $('breakdownView').innerHTML = html;
  };

  // 2 · TLB  (fully-associative: a query badge + parallel fan-out search)
  UI.prototype.renderTLB = function (snap, hl) {
    const queryVpn = hl.search != null ? hl.search : (hl.vpn != null ? hl.vpn : null);
    const state = hl.hitIndex != null ? 'hit' : hl.miss ? 'miss' : (hl.search != null ? 'search' : null);
    const badge = state
      ? `<div class="tlb-query ${state}" id="tlbQuery">VPN ${queryVpn} ?` +
        (state === 'hit' ? '  ✓ found' : state === 'miss' ? '  ✗ not found' : '  (compare all)') + `</div>`
      : '';
    let rows = '';
    for (let i = 0; i < this.cfg.tlbEntries; i++) {
      const e = snap.tlb[i];
      let cls = (hl.search != null) ? 'searching' : '';   // parallel associative search lights all rows
      if (e) {
        if (hl.hitIndex === i) cls = 'hit';
        if (hl.inserted != null && e.vpn === hl.inserted) cls = 'insert';
      }
      rows += `<tr id="tlbRow${i}" class="${cls}"><td>${i}</td>` +
              (e ? `<td>${e.vpn}</td><td>${e.pfn}</td><td>1</td><td>${this.cfg.tlbPolicy === 'FIFO' ? e.insertSeq : e.lastUsed}</td>`
                 : `<td>—</td><td>—</td><td>0</td><td>—</td>`) + `</tr>`;
    }
    if (hl.evicted != null) rows += `<tr class="evict"><td colspan="5">evicted VPN ${hl.evicted} (TLB full, ${this.cfg.tlbPolicy})</td></tr>`;
    if (hl.pageEvicted != null) rows += `<tr class="evict"><td colspan="5">VPN ${hl.pageEvicted} flushed (its page was replaced in memory)</td></tr>`;
    $('tlbView').innerHTML = badge +
      `<table><tr><th>#</th><th>VPN</th><th>PFN</th><th>V</th><th>${this.cfg.tlbPolicy === 'FIFO' ? 'in-seq' : 'used'}</th></tr>${rows}</table>`;
  };

  // 3 · page table — single-level: one table; multilevel: Outer + Inner (always shown)
  UI.prototype.renderPageTable = function (step, snap, hl) {
    const c = this.cfg, pt = snap.pageTable;
    const PT_CAP = 64;
    // highlight the current entry ONLY when the page table is actually consulted
    // (a TLB hit does NOT touch the page table — that's the whole point of a TLB).
    const idx = (hl && hl.ptUse && step.indices && step.indices.length) ? step.indices : null;
    const skipNote = (hl && hl.skipped)
      ? '<div class="pt-note" style="color:var(--steel)"><b>TLB hit</b> — the page table is not consulted on this access.</div>' : '';

    if (c.levels === 1) {
      const leafIdx = idx ? idx[0] : null;
      const n = Math.min(c.numPages, MAX_CELLS);
      let rows = '';
      for (let v = 0; v < n; v++) {
        const e = pt[v];
        rows += `<tr class="${v === leafIdx ? 'sel' : ''}"><td>${v}</td><td>${e ? e.pfn : '—'}</td><td>${e ? 1 : 0}</td></tr>`;
      }
      const more = c.numPages > MAX_CELLS ? `<div class="pt-note">(${c.numPages - MAX_CELLS} more entries hidden)</div>` : '';
      $('pageTableView').innerHTML = skipNote + `<table><tr><th>VPN</th><th>PFN</th><th>V</th></tr>${rows}</table>${more}`;
      return;
    }

    // one level's table (table may be null => not created yet -> all entries invalid)
    const col = (title, sub, count, table, hi, leaf) => {
      const n = Math.min(count, PT_CAP);
      let rows = '';
      for (let i = 0; i < n; i++) {
        const e = table ? table[i] : null;
        const val = e ? (leaf ? e.pfn : '→ tbl') : '—';
        rows += `<tr class="${i === hi ? 'sel' : ''}"><td>${i}</td><td>${val}</td><td>${e ? 1 : 0}</td></tr>`;
      }
      const more = count > PT_CAP ? `<div class="pt-note">(+${count - PT_CAP})</div>` : '';
      return `<div class="pt-col"><h3>${title}</h3><div class="pt-sub">${sub}</div>` +
             `<table><tr><th>idx</th><th>${leaf ? 'PFN' : 'ptr'}</th><th>V</th></tr>${rows}</table>${more}</div>`;
    };

    const names = c.levels === 3
      ? ['Outer page table', 'Middle page table', 'Inner page table']
      : ['Outer page table', 'Inner page table'];
    const CAPT = 8;             // max tables to draw per level
    const keys = o => Object.keys(o || {}).map(Number).sort((a, b) => a - b);

    // Outer (L1) — indexed by the MSB VPN bits; always shown in full
    let cols = col(names[0], 'L1 · top ' + c.levelBits[0] + ' VPN bits · ' + E.pow2(c.levelBits[0]) + ' entries',
                   E.pow2(c.levelBits[0]), pt, idx ? idx[0] : null, false);

    // --- gather EVERY allocated level-2 table (so none disappears as we step) ---
    let lvl2 = keys(pt).map(k => ({ l1: k, tab: pt[k].next }));
    if (idx && pt[idx[0]] == null) lvl2.push({ l1: idx[0], tab: null });   // current L1 not created yet
    if (lvl2.length === 0) lvl2.push({ l1: '—', tab: null });              // config-time placeholder
    const leaf2 = (c.levels === 2);
    lvl2.slice(0, CAPT).forEach(t => {
      const hi = (idx && idx[0] === t.l1) ? idx[1] : null;
      cols += col(names[1], 'under L1=' + t.l1 + (t.tab ? '' : ' · not created yet'),
                  E.pow2(c.levelBits[1]), t.tab, hi, leaf2);
    });
    if (lvl2.length > CAPT) cols += `<div class="pt-col pt-note">(+${lvl2.length - CAPT} more inner tables)</div>`;

    // --- level-3 tables (3-level only): every allocated L3 table ---------------
    if (c.levels === 3) {
      let lvl3 = [];
      keys(pt).forEach(k => keys(pt[k].next).forEach(j => lvl3.push({ l1: k, l2: j, tab: pt[k].next[j].next })));
      const haveCur = idx && pt[idx[0]] && pt[idx[0]].next[idx[1]] && pt[idx[0]].next[idx[1]].next;
      if (idx && !haveCur) lvl3.push({ l1: idx[0], l2: idx[1], tab: null });
      if (lvl3.length === 0) lvl3.push({ l1: '—', l2: '—', tab: null });
      lvl3.slice(0, CAPT).forEach(t => {
        const hi = (idx && idx[0] === t.l1 && idx[1] === t.l2) ? idx[2] : null;
        cols += col(names[2], 'under L1=' + t.l1 + ', L2=' + t.l2 + (t.tab ? '' : ' · not created yet'),
                    E.pow2(c.levelBits[2]), t.tab, hi, true);
      });
      if (lvl3.length > CAPT) cols += `<div class="pt-col pt-note">(+${lvl3.length - CAPT} more)</div>`;
    }

    $('pageTableView').innerHTML = skipNote + `<div class="pt-cols">${cols}</div>` +
      `<div class="pt-note">Outer table is indexed by the top ${c.levelBits[0]} VPN bits; each <b>inner</b> table holds ` +
      `${c.entriesPerTable} entries and fits in one page (the outer table may be larger). All allocated tables stay visible; the highlighted row is the entry used by the current address.</div>`;
  };

  // 4 · physical memory
  UI.prototype.renderPhysical = function (snap, hl) {
    const n = Math.min(snap.frames.length, MAX_CELLS);
    // which resident frame would be evicted NEXT, by the current policy?
    let victim = -1;
    const used = snap.frames.map((f, i) => ({ f, i })).filter(x => x.f.used);
    if (used.length === this.cfg.numFrames) {  // only meaningful once memory is full
      const metric = this.cfg.replPolicy === 'LRU' ? (x => x.f.lastUsed) : (x => x.f.loadSeq);
      victim = used.reduce((a, b) => metric(b) < metric(a) ? b : a).i;
    }
    let cells = '';
    for (let i = 0; i < n; i++) {
      const f = snap.frames[i];
      let cls = f.used ? 'mapped' : 'free';
      if (hl.frame === i) cls += ' active';
      if (hl.full) cls += ' fault';
      if (i === victim) cls += ' victim';
      const tag = (f.used && i === victim) ? '<span class="sub vt">next out ↩</span>' : '';
      cells += `<div class="cell ${cls}"><span class="n">F${i}</span>` +
               `<span class="sub">${f.used ? 'VPN ' + f.vpn : 'free'}</span>${tag}</div>`;
    }
    const more = snap.frames.length > MAX_CELLS ? `<div class="pt-note">(${snap.frames.length - MAX_CELLS} more frames hidden)</div>` : '';
    const evict = hl.pageEvicted != null
      ? `<div class="pt-note" style="color:var(--evict)">page replacement: evicted VPN ${hl.pageEvicted} (its page-table entry is now invalid)</div>` : '';
    $('physicalView').innerHTML = `<div class="cells">${cells}</div>${evict}${more}`;
  };

  // stats
  UI.prototype.renderStats = function (st) {
    const total = st.totalRequests || 0;
    const hr = total ? (st.tlbHits / total * 100).toFixed(1) : '0.0';
    const mr = total ? (st.tlbMisses / total * 100).toFixed(1) : '0.0';
    const items = [
      ['Total Requests', st.totalRequests, ''],
      ['TLB Hits', st.tlbHits, 'good'],
      ['TLB Misses', st.tlbMisses, 'bad'],
      ['Hit Rate', hr + '%', 'good'],
      ['Miss Rate', mr + '%', 'bad'],
      ['Page-Table Walks', st.pageTableWalks, ''],
      ['Page Faults', st.pageFaults, ''],
      ['Page Replacements', st.replacements, ''],
      ['TLB Evictions', st.evictions, ''],
      ['FIFO Evictions', st.fifoEvictions, ''],
      ['LRU Evictions', st.lruEvictions, '']
    ];
    $('statsView').innerHTML = items.map(([k, v, cls]) =>
      `<div class="stat ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
  };

  UI.formatSize = formatSize;
  UI.parseSize = parseSize;
  root.VMUI = UI;
})(window);
