/* =============================================================================
 * VMVisualizer — Translation Engine (pure logic, no DOM)
 * Textbook-accurate virtual-memory address translation for education.
 *
 * Works in the browser (attaches to window.VMEngine) and in Node (module.exports)
 * so the same code is unit-tested headlessly.
 *
 * Conventions (standard OS/COA textbook definitions):
 *   offsetBits = log2(pageSize)
 *   vaBits     = log2(virtualAddressSpace)      paBits = log2(physicalAddressSpace)
 *   vpnBits    = vaBits - offsetBits            pfnBits = paBits - offsetBits
 *   numPages   = VAS / pageSize                 numFrames = PAS / pageSize
 *   Multi-level: the vpnBits are split across levels, MOST-significant first
 *                (level 1 = outermost). Default split is even, with the
 *                remainder bits given to the OUTERMOST levels. A custom
 *                levelBits[] may be supplied for GATE-exact problems.
 * ========================================================================== */
(function (root) {
  'use strict';

  // ----- small math helpers -------------------------------------------------
  // NOTE: avoid 32-bit bitwise ops here. JS '&' and '>>>' operate on 32-bit ints,
  // which silently breaks for address spaces >= 2^32. Use plain arithmetic so the
  // tool is correct up to 2^53 (well beyond any classroom config).
  function isPow2(n) { return Number.isInteger(n) && n > 0 && Math.pow(2, Math.round(Math.log2(n))) === n; }
  function log2(n) { return Math.round(Math.log2(n)); }
  function pow2(n) { return Math.pow(2, n); }

  function toBinary(value, bits) {
    let s = Math.floor(value).toString(2);          // no '>>> 0' — supports >= 2^32
    if (bits > 0) while (s.length < bits) s = '0' + s;
    return s.slice(-bits || s.length) || '0';
  }
  function toHex(value, bits) {
    const digits = Math.max(1, Math.ceil(bits / 4));
    let s = Math.floor(value).toString(16).toUpperCase();   // no '>>> 0'
    while (s.length < digits) s = '0' + s;
    return '0x' + s;
  }

  // ----- bit-field split across page-table levels ---------------------------
  // Even split; remainder bits assigned to the OUTERMOST levels (level 1 first).
  function splitVpnBits(vpnBits, levels) {
    const base = Math.floor(vpnBits / levels);
    let rem = vpnBits % levels;
    const arr = [];
    for (let i = 0; i < levels; i++) {
      arr.push(base + (rem > 0 ? 1 : 0));
      if (rem > 0) rem--;
    }
    return arr; // length === levels, sum === vpnBits
  }

  // Extract per-level indices from a VPN, most-significant level first.
  function extractIndices(vpn, levelBits) {
    const indices = [];
    let lower = levelBits.reduce((a, b) => a + b, 0); // === vpnBits
    for (let i = 0; i < levelBits.length; i++) {
      lower -= levelBits[i];
      indices.push(Math.floor(vpn / pow2(lower)) % pow2(levelBits[i]));
    }
    return indices;
  }

  // ----- configuration -------------------------------------------------------
  function buildConfig(raw) {
    const { vas, pas, pageSize, tlbEntries, tlbPolicy, levels } = raw;
    const pteSize = raw.pteSize != null ? raw.pteSize : 4; // page-table entry size in bytes
    const replPolicy = String(raw.replPolicy || 'FIFO').toUpperCase(); // page-replacement policy
    const errs = [];
    [['Virtual address space', vas], ['Physical address space', pas],
     ['Page size', pageSize], ['PTE size', pteSize]].forEach(([n, v]) => {
      if (!isPow2(v)) errs.push(n + ' must be a power of two (got ' + v + ').');
    });
    if (isPow2(pageSize) && isPow2(vas) && pageSize > vas) errs.push('Page size cannot exceed the virtual address space.');
    if (isPow2(pageSize) && isPow2(pas) && pageSize > pas) errs.push('Page size cannot exceed the physical address space.');
    if (!(tlbEntries >= 1)) errs.push('TLB must have at least one entry.');
    if (![1, 2, 3].includes(levels)) errs.push('Page-table levels must be 1, 2, or 3.');
    if (!['FIFO', 'LRU'].includes(tlbPolicy)) errs.push('TLB policy must be FIFO or LRU.');
    if (!['FIFO', 'LRU'].includes(replPolicy)) errs.push('Page-replacement policy must be FIFO or LRU.');
    if (errs.length) return { ok: false, errors: errs };

    const offsetBits = log2(pageSize);
    const vaBits = log2(vas);
    const paBits = log2(pas);
    const vpnBits = vaBits - offsetBits;
    const pfnBits = paBits - offsetBits;
    // "fits-in-a-page": one page-table page holds pageSize/pteSize entries
    const innerBits = log2(pageSize) - log2(pteSize);          // = log2(pageSize / pteSize)
    const entriesPerTable = pow2(innerBits);

    // VPN split, MSB-first: inner levels each take innerBits, outermost takes the remainder.
    // (Single-level always works, even when VPN = 0 bits — a 1-page space. Multilevel cases
    //  that can't be split are caught below with a clear message.)
    let levelBits = null;
    if (Array.isArray(raw.levelBits) && raw.levelBits.length === levels &&
        raw.levelBits.reduce((a, b) => a + b, 0) === vpnBits) {
      levelBits = raw.levelBits.slice();
    } else if (levels === 1) {
      levelBits = [vpnBits];
    } else if (vpnBits < levels) {
      errs.push('Virtual page number is only ' + vpnBits + ' bit(s) — not enough for ' + levels + ' levels.');
    } else if (innerBits < 1) {
      errs.push('Page too small for its entry size — a page holds fewer than 2 entries.');
    } else {
      const outer = vpnBits - (levels - 1) * innerBits;
      if (outer < 1) {
        const maxLevels = Math.ceil(vpnBits / innerBits);
        errs.push('With page=' + pageSize + 'B and PTE=' + pteSize + 'B each table holds ' + entriesPerTable +
          ' entries (' + innerBits + ' bits). The ' + vpnBits + '-bit VPN needs at most ' + maxLevels +
          ' level(s) — reduce levels to ≤ ' + maxLevels + '.');
      } else {
        levelBits = [outer].concat(Array(levels - 1).fill(innerBits));
      }
    }
    if (errs.length) return { ok: false, errors: errs };

    return {
      ok: true,
      vas, pas, pageSize, pteSize, tlbEntries, tlbPolicy, replPolicy, levels, levelBits,
      offsetBits, vaBits, paBits, vpnBits, pfnBits, innerBits, entriesPerTable,
      numPages: vas / pageSize,
      numFrames: pas / pageSize
    };
  }

  // ----- the engine ----------------------------------------------------------
  function Engine(cfg) {
    this.cfg = cfg;
    this.reset();
  }

  Engine.prototype.reset = function () {
    this.tlb = [];                 // {vpn, pfn, valid, insertSeq, lastUsed}
    this.root = {};                // page table tree (allocated on demand)
    this.frames = [];              // physical frames
    for (let i = 0; i < this.cfg.numFrames; i++)
      this.frames.push({ used: false, vpn: null, indices: null, loadSeq: -1, lastUsed: -1 });
    this.nextFreeFrame = 0;
    this.allocSeq = 0;             // monotonic frame-load counter (FIFO page replacement)
    this.clock = 0;
    this.stats = {
      totalRequests: 0, tlbHits: 0, tlbMisses: 0,
      pageTableWalks: 0, pageFaults: 0, replacements: 0,
      evictions: 0, fifoEvictions: 0, lruEvictions: 0
    };
  };

  // Allocate a frame for vpn. Use a free frame if one exists; otherwise evict a
  // victim by the page-replacement policy — invalidating its PTE and flushing it
  // from the TLB so no stale mapping survives. Returns {pfn, evicted}.
  Engine.prototype._allocFrame = function (vpn, indices) {
    let f, evicted = null;
    if (this.nextFreeFrame < this.cfg.numFrames) {
      f = this.nextFreeFrame++;
    } else {
      let vi = 0;
      if (this.cfg.replPolicy === 'LRU') {
        for (let i = 1; i < this.frames.length; i++) if (this.frames[i].lastUsed < this.frames[vi].lastUsed) vi = i;
      } else { // FIFO
        for (let i = 1; i < this.frames.length; i++) if (this.frames[i].loadSeq < this.frames[vi].loadSeq) vi = i;
      }
      f = vi;
      const victimVpn = this.frames[f].vpn;
      if (this.frames[f].indices) this._invalidateLeaf(this.frames[f].indices); // evicted page -> PTE invalid
      this._removeTLB(victimVpn);                                               // flush stale TLB entry
      this.stats.replacements++;
      evicted = { vpn: victimVpn, frame: f };
    }
    this.frames[f] = { used: true, vpn: vpn, indices: indices, loadSeq: ++this.allocSeq, lastUsed: this.clock };
    return { pfn: f, evicted: evicted };
  };

  // set the leaf entry for a page back to invalid (used when its frame is reclaimed)
  Engine.prototype._invalidateLeaf = function (indices) {
    let node = this.root;
    for (let i = 0; i < this.cfg.levels - 1; i++) {
      if (!node[indices[i]]) return;
      node = node[indices[i]].next;
    }
    const leaf = node[indices[this.cfg.levels - 1]];
    if (leaf) { leaf.valid = false; leaf.pfn = null; }
  };

  Engine.prototype._removeTLB = function (vpn) {
    this.tlb = this.tlb.filter(e => e.vpn !== vpn);
  };

  Engine.prototype._findTLB = function (vpn) {
    for (let i = 0; i < this.tlb.length; i++) if (this.tlb[i].valid && this.tlb[i].vpn === vpn) return i;
    return -1;
  };

  // returns {evicted:entry|null}
  Engine.prototype._insertTLB = function (vpn, pfn) {
    const entry = { vpn, pfn, valid: true, insertSeq: this.clock, lastUsed: this.clock };
    if (this.tlb.length < this.cfg.tlbEntries) { this.tlb.push(entry); return { evicted: null }; }
    // choose victim
    let vi = 0;
    if (this.cfg.tlbPolicy === 'FIFO') {
      for (let i = 1; i < this.tlb.length; i++) if (this.tlb[i].insertSeq < this.tlb[vi].insertSeq) vi = i;
      this.stats.fifoEvictions++;
    } else { // LRU
      for (let i = 1; i < this.tlb.length; i++) if (this.tlb[i].lastUsed < this.tlb[vi].lastUsed) vi = i;
      this.stats.lruEvictions++;
    }
    this.stats.evictions++;
    const evicted = this.tlb[vi];
    this.tlb[vi] = entry;
    return { evicted };
  };

  // page-table walk over level indices; does not mutate
  Engine.prototype._walk = function (indices) {
    let node = this.root;
    const path = [];
    for (let i = 0; i < this.cfg.levels - 1; i++) {
      const idx = indices[i];
      const present = !!node[idx];
      path.push({ level: i + 1, idx, present });
      if (!present) return { fault: true, faultLevel: i + 1, path };
      node = node[idx].next;
    }
    const li = indices[this.cfg.levels - 1];
    const entry = node[li];
    const present = !!(entry && entry.valid);
    path.push({ level: this.cfg.levels, idx: li, present, pfn: present ? entry.pfn : null });
    return present ? { fault: false, pfn: entry.pfn, path } : { fault: true, faultLevel: this.cfg.levels, path };
  };

  // create intermediate tables on demand + allocate a frame for the leaf.
  // returns {pfn, evicted} (evicted = {vpn, frame} when a page was replaced).
  Engine.prototype._install = function (indices, vpn) {
    let node = this.root;
    for (let i = 0; i < this.cfg.levels - 1; i++) {
      const idx = indices[i];
      if (!node[idx]) node[idx] = { next: {} };
      node = node[idx].next;
    }
    const a = this._allocFrame(vpn, indices);
    node[indices[this.cfg.levels - 1]] = { valid: true, pfn: a.pfn };
    return a;
  };

  Engine.prototype._snapshot = function (extra) {
    const s = {
      tlb: this.tlb.map(e => ({ vpn: e.vpn, pfn: e.pfn, valid: e.valid, insertSeq: e.insertSeq, lastUsed: e.lastUsed })),
      stats: Object.assign({}, this.stats),
      frames: this.frames.map(f => ({ used: f.used, vpn: f.vpn, loadSeq: f.loadSeq, lastUsed: f.lastUsed })),
      pageTable: JSON.parse(JSON.stringify(this.root))
    };
    return Object.assign(s, extra);
  };

  // Process one access; mutate state; return an array of 8 step descriptors,
  // each carrying a post-step snapshot for clean Next/Prev navigation.
  Engine.prototype.access = function (va) {
    const c = this.cfg;
    if (!(va >= 0 && va < c.vas)) {
      return [{ stage: 0, title: 'Invalid address', explain:
        'Address ' + va + ' is outside the ' + c.vas + '-byte virtual address space (0 … ' + (c.vas - 1) + ').',
        snapshot: this._snapshot({ error: true }) }];
    }
    this.clock++;
    this.stats.totalRequests++;

    const offset = va % c.pageSize;
    const vpn = Math.floor(va / c.pageSize);
    const indices = extractIndices(vpn, c.levelBits);
    const breakdown = {
      va, vaBin: toBinary(va, c.vaBits), vaHex: toHex(va, c.vaBits),
      vpn, vpnBin: toBinary(vpn, c.vpnBits),
      offset, offsetBin: toBinary(offset, c.offsetBits),
      indices, levelBits: c.levelBits.slice()
    };

    const steps = [];
    let n = 0;
    // steps are numbered sequentially, so a shorter (hit) path stays contiguous
    const push = (key, title, explain, concept, extra) => {
      n++;
      steps.push({ stage: n, key, title, explain, concept: concept || '',
                   breakdown, vpn, offset, indices,
                   highlight: (extra && extra.highlight) || null,
                   snapshot: this._snapshot(extra) });
    };

    push('extract', 'Extract VPN & Offset',
      'The low ' + c.offsetBits + ' bits are the page offset (' + offset + '); the high ' +
      c.vpnBits + ' bits are the virtual page number (VPN = ' + vpn + '). The offset is never translated.',
      'The offset indexes a byte within a page and is identical in the virtual and physical address.',
      { highlight: { component: 'breakdown' } });

    const ti = this._findTLB(vpn);
    push('tlb-check', 'Check the TLB',
      'The MMU searches all TLB entries for VPN ' + vpn + ' in parallel (fully-associative TLB).',
      'The TLB is a small, fast cache of recent VPN→PFN mappings, searched before the page table.',
      { highlight: { component: 'tlb', search: vpn } });

    let pfn, hit = (ti >= 0);
    if (hit) {
      // ---- TLB HIT: short path — no page-table walk, no TLB re-insert -----
      this.stats.tlbHits++;
      this.tlb[ti].lastUsed = this.clock; // TLB LRU recency
      pfn = this.tlb[ti].pfn;
      if (this.frames[pfn]) this.frames[pfn].lastUsed = this.clock; // frame LRU recency
      push('tlb-result', 'TLB HIT',
        'VPN ' + vpn + ' is present in the TLB → PFN ' + pfn + '. The page-table walk is skipped entirely.',
        'A hit avoids the page-table walk; a miss forces it. TLB hit rate dominates translation performance.',
        { highlight: { component: 'tlb', hitIndex: ti, vpn: vpn } });
      push('walk', 'Page-Table Walk (skipped)',
        'Because the TLB hit, no page-table memory accesses are needed.',
        'This is exactly why a TLB speeds up address translation.',
        { highlight: { component: 'tlb', hitIndex: ti, vpn: vpn, skipped: true } });
    } else {
      // ---- TLB MISS: full path -------------------------------------------
      this.stats.tlbMisses++;
      push('tlb-result', 'TLB MISS',
        'VPN ' + vpn + ' is not in the TLB. The MMU must walk the ' + c.levels + '-level page table.',
        'A hit avoids the page-table walk; a miss forces it. TLB hit rate dominates translation performance.',
        { highlight: { component: 'tlb', miss: true, vpn: vpn } });

      this.stats.pageTableWalks++;
      const walk = this._walk(indices);
      const idxStr = indices.map((x, i) => 'L' + (i + 1) + '=' + x).join(', ');
      push('walk', 'Page-Table Walk',
        'Split the VPN into level indices [' + idxStr + '] and follow the tree from the root, one access per level.',
        'A page-table walk reads one entry per level; an N-level table costs N memory accesses on a miss.',
        { highlight: { component: 'pagetable', path: walk.path, ptUse: true } });

      if (walk.fault) {
        this.stats.pageFaults++;
        const a = this._install(indices, vpn);
        pfn = a.pfn;
        if (a.evicted) {
          push('resolve', 'PAGE FAULT → page replacement',
            'The page is not present and physical memory is full. Evict VPN ' + a.evicted.vpn + ' from frame ' +
            a.evicted.frame + ' by ' + c.replPolicy + ' policy — its page-table entry is set invalid and it is flushed ' +
            'from the TLB — then load this page into frame ' + pfn + '.',
            'Page replacement: with no free frame, the OS evicts a victim page and marks its page-table entry invalid.',
            { highlight: { component: 'physical', frame: pfn, pageEvicted: a.evicted.vpn, ptUse: true } });
        } else {
          push('resolve', 'PAGE FAULT → frame allocated',
            'The page was not present (valid bit 0). The OS allocates free frame ' + pfn +
            ', creates any missing tables, and sets the leaf entry valid → PFN ' + pfn + '.',
            'A valid leaf entry yields the frame; an invalid entry is a page fault handled by the OS (demand paging).',
            { highlight: { component: 'physical', frame: pfn, ptUse: true } });
        }
      } else {
        pfn = walk.pfn;
        this.frames[pfn].lastUsed = this.clock; // frame LRU recency on a page-table hit
        push('resolve', 'PFN resolved (page table)',
          'The leaf entry is valid → PFN ' + pfn + '.',
          'A valid leaf entry yields the frame number used to build the physical address.',
          { highlight: { component: 'pagetable', path: walk.path, ptUse: true } });
      }

      const r = this._insertTLB(vpn, pfn);
      push('tlb-update', 'Update the TLB',
        'Insert VPN ' + vpn + ' → PFN ' + pfn + ' into the TLB' +
        (r.evicted ? ', evicting VPN ' + r.evicted.vpn + ' by ' + c.tlbPolicy + ' policy.' : '.'),
        'The resolved mapping is cached so the next access to this page is fast; a full TLB evicts a victim by policy.',
        { highlight: { component: 'tlb', inserted: vpn, evicted: r.evicted ? r.evicted.vpn : null } });
    }

    // ---- physical address (both paths) -----------------------------------
    const pa = pfn * c.pageSize + offset;
    push('pa', 'Generate Physical Address',
      'Physical address = PFN × pageSize + offset = ' + pfn + ' × ' + c.pageSize + ' + ' + offset +
      ' = ' + pa + ' (' + toHex(pa, c.paBits) + ').',
      'Physical address = frame number × page size + offset — concatenating PFN and the untouched offset.',
      { highlight: { component: 'physical', frame: pfn }, pa, paBin: toBinary(pa, c.paBits), paHex: toHex(pa, c.paBits) });

    push('final', 'Final Result',
      (hit ? 'TLB HIT' : 'TLB MISS') + '. Virtual ' + toHex(va, c.vaBits) + ' → Physical ' +
      toHex(pa, c.paBits) + '. Hit rate is now ' +
      ((this.stats.tlbHits / this.stats.totalRequests) * 100).toFixed(1) + '%.',
      '', { highlight: { component: 'breakdown' }, pa, paHex: toHex(pa, c.paBits), result: hit ? 'hit' : 'miss' });

    return steps;
  };

  const API = { isPow2, log2, pow2, toBinary, toHex, splitVpnBits, extractIndices, buildConfig, Engine };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.VMEngine = API;
})(typeof window !== 'undefined' ? window : globalThis);
