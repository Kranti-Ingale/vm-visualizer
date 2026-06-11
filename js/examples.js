/* Built-in example configurations and sample workloads. */
(function (root) {
  'use strict';
  const EXAMPLES = {
    simple: {
      label: 'Simple Paging (single-level)',
      cfg: { vas: 16384, pas: 4096, pageSize: 1024, pteSize: 4, tlbEntries: 4, tlbPolicy: 'FIFO', levels: 1 },
      requests: [0x0405, 0x0401, 0x0C10, 0x0420, 0x0815]
    },
    gate2: {
      // page 1KB / PTE 128B -> 8 entries/table (innerBits 3); vpn 6 -> split [3,3]
      label: 'Two-Level (fits-in-a-page)',
      cfg: { vas: 65536, pas: 16384, pageSize: 1024, pteSize: 128, tlbEntries: 4, tlbPolicy: 'LRU', levels: 2 },
      requests: [45 * 1024 + 7, 42 * 1024 + 100, 45 * 1024 + 9]
    },
    threelevel: {
      // page 256B / PTE 32B -> 8 entries/table (innerBits 3); vpn 8 -> split [2,3,3]
      label: 'Three-Level (fits-in-a-page)',
      cfg: { vas: 65536, pas: 16384, pageSize: 256, pteSize: 32, tlbEntries: 4, tlbPolicy: 'LRU', levels: 3 },
      requests: [190 * 256 + 50, 184 * 256 + 10, 190 * 256 + 9]
    },
    fifovslru: {
      label: 'TLB FIFO vs LRU (pages 1,2,3,1,4,1)',
      cfg: { vas: 65536, pas: 65536, pageSize: 4096, pteSize: 4, tlbEntries: 3, tlbPolicy: 'FIFO', levels: 1 },
      requests: [0x1000, 0x2000, 0x3000, 0x1000, 0x4000, 0x1000]
    },
    replace: {
      // 2 frames (PAS 8KB / 4KB), big TLB so only PAGE replacement matters.
      // ref 1,2,1,3,2 -> FIFO: 3 faults (final 2 hits); LRU: 4 faults (final 2 faults)
      label: 'Page Replacement (working set > frames)',
      cfg: { vas: 65536, pas: 8192, pageSize: 4096, pteSize: 4, tlbEntries: 8, tlbPolicy: 'LRU', replPolicy: 'FIFO', levels: 1 },
      requests: [0x1000, 0x2000, 0x1000, 0x3000, 0x2000]
    }
  };

  // Deterministic-ish sample workload (no Math.random reliance for reproducibility
  // is not required here; this is a UI convenience generator).
  function generateWorkload(cfg, n) {
    const out = [];
    const pages = cfg.vas / cfg.pageSize;
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < n; i++) {
      // bias toward locality: 60% reuse a small working set
      const p = rnd() < 0.6 ? Math.floor(rnd() * Math.min(4, pages))
                            : Math.floor(rnd() * pages);
      const off = Math.floor(rnd() * cfg.pageSize);
      out.push(p * cfg.pageSize + off);
    }
    return out;
  }

  const API = { EXAMPLES, generateWorkload };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.VMExamples = API;
})(typeof window !== 'undefined' ? window : globalThis);
