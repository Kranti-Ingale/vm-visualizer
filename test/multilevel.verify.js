/* Multilevel paging verification — GATE "fits-in-a-page" convention.
 * Run:  node test/multilevel.verify.js
 *
 * Convention under test:
 *   offset = log2(pageSize); VPN = log2(VAS) - offset; PFN = log2(PAS) - offset.
 *   Each inner page-table fits in one page  ->  innerBits = log2(pageSize / PTEsize).
 *   VPN split MSB-first: the (levels-1) inner levels take innerBits each;
 *   the OUTERMOST level takes the remaining VPN bits.
 *   Frames: bump allocator (first fault -> frame 0, then 1, ...).
 */
const E = require('../js/engine.js');
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + a + '\n       want ' + b); }
};
function run(eng, va) {
  const s = eng.access(va);
  const b = s[0].breakdown;
  const res = s.find(x => x.key === 'tlb-result');
  const pa = (s.find(x => x.key === 'pa') || {}).snapshot;
  const walk = s.find(x => x.key === 'walk');
  return {
    vaHex: b.vaHex, vpn: b.vpn, indices: b.indices, offset: b.offset,
    hit: /HIT/.test(res.title),
    pa: pa ? pa.pa : null, pfn: pa ? Math.floor(pa.pa / eng.cfg.pageSize) : null,
    walkPath: walk ? (walk.highlight.path || []).map(p => ({ L: p.level, idx: p.idx })) : null
  };
}
const show = rows => rows.forEach(r =>
  console.log('    ' + r.vaHex + '  vpn=' + r.vpn + '  idx=[' + r.indices.join(',') + ']  off=' + r.offset +
              '  -> PFN ' + r.pfn + '  PA=' + r.pa + '  ' + (r.hit ? 'TLB hit' : 'miss')));

// ============================================================================
console.log('\n[A] TWO-LEVEL fits-in-a-page — VAS 64KB, page 1KB, PTE 128B, PAS 16KB');
// offset 10, vpn 6 ; innerBits = log2(1024/128)=3 ; levels 2 -> outer=6-3=3 -> [3,3]
let A = E.buildConfig({ vas: 65536, pas: 16384, pageSize: 1024, pteSize: 128, tlbEntries: 4, tlbPolicy: 'LRU', levels: 2 });
eq('A ok', A.ok, true);
eq('A offset/vpn/pfn', [A.offsetBits, A.vpnBits, A.pfnBits], [10, 6, 4]);
eq('A innerBits / entriesPerTable', [A.innerBits, A.entriesPerTable], [3, 8]);
eq('A split [3,3]', A.levelBits, [3, 3]);
let ea = new E.Engine(A);
let a1 = run(ea, 45 * 1024 + 7);    // vpn45=101101 -> L1=5,L2=5 ; off 7
let a2 = run(ea, 42 * 1024 + 100);  // vpn42=101010 -> L1=5,L2=2 ; shares L1=5 subtree
let a3 = run(ea, 45 * 1024 + 9);    // vpn45 again -> TLB hit
show([a1, a2, a3]);
eq('A1 idx [5,5], frame 0, PA 7', [a1.indices, a1.pfn, a1.pa], [[5, 5], 0, 7]);
eq('A2 idx [5,2], frame 1, PA 1124', [a2.indices, a2.pfn, a2.pa], [[5, 2], 1, 1124]);
eq('A3 TLB hit, frame 0, PA 9', [a3.hit, a3.pfn, a3.pa], [true, 0, 9]);
eq('A shared L1[5] inner table holds {2,5}',
   Object.keys(ea.root[5].next).map(Number).sort((x, y) => x - y), [2, 5]);

// ============================================================================
console.log('\n[B] THREE-LEVEL fits-in-a-page — VAS 64KB, page 256B, PTE 32B, PAS 16KB');
// offset 8, vpn 8 ; innerBits = log2(256/32)=3 ; levels 3 -> outer=8-6=2 -> [2,3,3]
let B = E.buildConfig({ vas: 65536, pas: 16384, pageSize: 256, pteSize: 32, tlbEntries: 4, tlbPolicy: 'LRU', levels: 3 });
eq('B ok', B.ok, true);
eq('B offset/vpn/pfn', [B.offsetBits, B.vpnBits, B.pfnBits], [8, 8, 6]);
eq('B innerBits / entries', [B.innerBits, B.entriesPerTable], [3, 8]);
eq('B split [2,3,3]', B.levelBits, [2, 3, 3]);
let eb = new E.Engine(B);
let b1 = run(eb, 190 * 256 + 50);   // vpn190=10111110 -> L1=2,L2=7,L3=6 ; cold: faults at L1
let b2 = run(eb, 184 * 256 + 10);   // vpn184=10111000 -> L1=2,L2=7,L3=0 ; shares L1,L2: full walk
show([b1, b2]);
eq('B1 idx [2,7,6]', b1.indices, [2, 7, 6]);
eq('B1 cold walk stops at L1', b1.walkPath.map(p => p.L), [1]);
eq('B1 frame 0, PA 50', [b1.pfn, b1.pa], [0, 50]);
eq('B2 idx [2,7,0]', b2.indices, [2, 7, 0]);
eq('B2 full 3-level walk', b2.walkPath.map(p => p.L), [1, 2, 3]);
eq('B2 frame 1, PA 266', [b2.pfn, b2.pa], [1, 266]);
eq('B leaf via 3-level chain', eb.root[2].next[7].next[6].pfn, 0);

// ============================================================================
console.log('\n[C] CLASSIC GATE — 32-bit VA, 4KB page, PTE 4B (bit-math only)');
// offset 12, vpn 20 ; innerBits = log2(4096/4)=10 ; 2 levels -> [10,10]
let C = E.buildConfig({ vas: 4294967296, pas: 1073741824, pageSize: 4096, pteSize: 4, tlbEntries: 4, tlbPolicy: 'LRU', levels: 2 });
eq('C ok', C.ok, true);
eq('C offset/vpn 12/20', [C.offsetBits, C.vpnBits], [12, 20]);
eq('C innerBits 10, entries 1024', [C.innerBits, C.entriesPerTable], [10, 1024]);
eq('C split [10,10]', C.levelBits, [10, 10]);
eq('C minimum levels = ceil(20/10) = 2', Math.ceil(C.vpnBits / C.innerBits), 2);

// ============================================================================
console.log('\n[D] ERROR — too many levels for the page/PTE size');
// page 1KB / PTE 128B -> innerBits 3 ; vpn 6 ; 3 levels needs outer = 6-6 = 0  -> invalid
let D = E.buildConfig({ vas: 65536, pas: 16384, pageSize: 1024, pteSize: 128, tlbEntries: 4, tlbPolicy: 'LRU', levels: 3 });
eq('D rejected', D.ok, false);
eq('D message mentions level limit', /level/.test(D.errors.join(' ')), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed.\n');
process.exit(fail ? 1 : 0);
