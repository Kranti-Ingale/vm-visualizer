/* Corner-case verification — the tricky inputs that could embarrass you in class.
 * Run:  node test/corner.verify.js
 * Each check states the hand-computed expectation, then compares the engine.
 */
const E = require('../js/engine.js');
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n        got  ' + a + '\n        want ' + b); }
};
const ok = (name, cond) => eq(name, !!cond, true);

// run one access -> compact summary
function run(eng, va) {
  const s = eng.access(va);
  const b = s[0].breakdown;
  const err = s[0].stage === 0;
  const res = s.find(x => x.key === 'tlb-result');
  const resolve = s.find(x => x.key === 'resolve');
  const pa = (s.find(x => x.key === 'pa') || {}).snapshot;
  return {
    error: err, vpn: b && b.vpn, offset: b && b.offset, indices: b && b.indices,
    hit: res ? /HIT/.test(res.title) : null,
    full: !!(resolve && /full/i.test(resolve.title)),
    pa: pa ? pa.pa : null, pfn: pa ? Math.floor(pa.pa / eng.cfg.pageSize) : null,
    stats: s[s.length - 1].snapshot.stats
  };
}

// ============================================================================
console.log('\n[1] CONFIG VALIDATION (bad inputs must be rejected)');
ok('non-power-of-two VAS rejected', !E.buildConfig({ vas: 1000, pas: 256, pageSize: 64, tlbEntries: 4, tlbPolicy: 'LRU', levels: 1 }).ok);
ok('page > VAS rejected', !E.buildConfig({ vas: 64, pas: 256, pageSize: 128, tlbEntries: 4, tlbPolicy: 'LRU', levels: 1 }).ok);
ok('page > PAS rejected', !E.buildConfig({ vas: 1024, pas: 32, pageSize: 64, tlbEntries: 4, tlbPolicy: 'LRU', levels: 1 }).ok);
ok('non-pow2 PTE rejected', !E.buildConfig({ vas: 1024, pas: 256, pageSize: 64, pteSize: 5, tlbEntries: 4, tlbPolicy: 'LRU', levels: 2 }).ok);
ok('PTE > page (multilevel) rejected', !E.buildConfig({ vas: 1024, pas: 256, pageSize: 64, pteSize: 128, tlbEntries: 4, tlbPolicy: 'LRU', levels: 2 }).ok);
ok('levels=4 rejected', !E.buildConfig({ vas: 1024, pas: 256, pageSize: 64, tlbEntries: 4, tlbPolicy: 'LRU', levels: 4 }).ok);
ok('TLB=0 rejected', !E.buildConfig({ vas: 1024, pas: 256, pageSize: 64, tlbEntries: 0, tlbPolicy: 'LRU', levels: 1 }).ok);
ok('bad policy rejected', !E.buildConfig({ vas: 1024, pas: 256, pageSize: 64, tlbEntries: 4, tlbPolicy: 'RANDOM', levels: 1 }).ok);
ok('too many levels for page/PTE rejected',
   !E.buildConfig({ vas: 65536, pas: 16384, pageSize: 1024, pteSize: 128, tlbEntries: 4, tlbPolicy: 'LRU', levels: 3 }).ok);
ok('TLB=1 (minimum) accepted', E.buildConfig({ vas: 1024, pas: 256, pageSize: 64, tlbEntries: 1, tlbPolicy: 'FIFO', levels: 1 }).ok);

// ============================================================================
console.log('\n[2] ADDRESS BOUNDARIES');
let cfg = E.buildConfig({ vas: 1024, pas: 256, pageSize: 64, pteSize: 16, tlbEntries: 4, tlbPolicy: 'LRU', levels: 2 });
// VAS 1KB, page 64B -> offset 6, vpn 4 ; PAS 256 -> 4 frames ; addresses 0..1023
let e = new E.Engine(cfg);
let r0 = run(e, 0);            // first byte
let rmax = run(e, 1023);       // last valid byte: vpn 15, offset 63
let rbad = run(new E.Engine(cfg), 1024);  // one past the end -> invalid
eq('addr 0 -> vpn 0, offset 0', [r0.vpn, r0.offset], [0, 0]);
eq('addr VAS-1 -> vpn 15, offset 63', [rmax.vpn, rmax.offset], [15, 63]);
ok('addr = VAS rejected as invalid', rbad.error);
ok('addr > VAS rejected', run(new E.Engine(cfg), 999999).error);

// ============================================================================
console.log('\n[3] OFFSET IS PRESERVED & PA IN RANGE (sweep)');
let e3 = new E.Engine(cfg);
let bad = 0, outOfRange = 0;
[0, 5, 63, 64, 65, 200, 511, 512, 1000, 1023].forEach(va => {
  const r = run(e3, va);
  if (r.pa != null) {
    if (r.pa % 64 !== va % 64) bad++;             // offset must survive
    if (r.pa < 0 || r.pa >= cfg.pas) outOfRange++; // PA must be inside physical memory
  }
});
eq('offset preserved for all sampled addresses', bad, 0);
eq('every PA inside physical memory', outOfRange, 0);

// ============================================================================
console.log('\n[4] PHYSICAL MEMORY REPLACEMENT (FIFO, no crash, no "full")');
// PAS 128 / page 64 -> only 2 frames ; FIFO page replacement
let full = E.buildConfig({ vas: 1024, pas: 128, pageSize: 64, pteSize: 16, tlbEntries: 4, tlbPolicy: 'LRU', replPolicy: 'FIFO', levels: 2 });
let ef = new E.Engine(full);
let f0 = run(ef, 0 * 64), f1 = run(ef, 1 * 64), f2 = run(ef, 2 * 64); // 3 distinct pages, 2 frames
eq('page 0 -> frame 0', f0.pfn, 0);
eq('page 1 -> frame 1', f1.pfn, 1);
ok('page 2 reuses a frame via replacement (got a PA, +1 replacement)', f2.pa != null && f2.stats.replacements === 1);
let reacc = run(ef, 0 * 64 + 7); // page 0 was evicted -> must fault again (its PTE was invalidated)
ok('re-accessing the evicted page faults again', reacc.hit === false);

// ============================================================================
console.log('\n[5] TLB CAPACITY / EVICTION (FIFO) & reload-not-refault');
let tcfg = E.buildConfig({ vas: 65536, pas: 65536, pageSize: 4096, pteSize: 4, tlbEntries: 3, tlbPolicy: 'FIFO', levels: 1 });
let et = new E.Engine(tcfg);
[1, 2, 3, 4].forEach(p => run(et, p * 4096));   // fill 3-entry TLB, evict page 1
let reload = run(et, 1 * 4096);                  // page 1: TLB miss, but page-table resident
ok('evicted page is a TLB miss', reload.hit === false);
eq('reload is NOT a new page fault (still 4 faults total)', reload.stats.pageFaults, 4);

// ============================================================================
console.log('\n[6] DEGENERATE SIZES');
// one page only (page == VAS)
let one = E.buildConfig({ vas: 64, pas: 256, pageSize: 64, pteSize: 4, tlbEntries: 2, tlbPolicy: 'LRU', levels: 1 });
eq('single page: numPages 1, vpnBits 0', [one.numPages, one.vpnBits], [1, 0]);
let r1p = run(new E.Engine(one), 40);
eq('single page: vpn 0, offset 40, PA 40', [r1p.vpn, r1p.offset, r1p.pa], [0, 40, 40]);
// one frame only (page == PAS)
let onef = E.buildConfig({ vas: 1024, pas: 64, pageSize: 64, pteSize: 4, tlbEntries: 2, tlbPolicy: 'LRU', replPolicy: 'FIFO', levels: 1 });
eq('single frame: numFrames 1', onef.numFrames, 1);
let ofe = new E.Engine(onef);
run(ofe, 0); let second = run(ofe, 64);
ok('single frame: 2nd distinct page replaces the first', second.pfn === 0 && second.stats.replacements === 1);

// ============================================================================
console.log('\n[7] STATS CONSISTENCY (sweep of mixed accesses)');
let scfg = E.buildConfig({ vas: 65536, pas: 16384, pageSize: 1024, pteSize: 128, tlbEntries: 4, tlbPolicy: 'LRU', levels: 2 });
let es = new E.Engine(scfg);
let last;
[0, 1024, 0, 2048, 1024, 3072, 0, 9000].forEach(va => { last = run(es, va); });
const st = last.stats;
eq('hits + misses == total requests', st.tlbHits + st.tlbMisses, st.totalRequests);
ok('page faults <= TLB misses', st.pageFaults <= st.tlbMisses);
ok('page-table walks == TLB misses', st.pageTableWalks === st.tlbMisses);
ok('hit rate in [0,100]', st.tlbHits / st.totalRequests >= 0 && st.tlbHits / st.totalRequests <= 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed.\n');
process.exit(fail ? 1 : 0);
