/* Frame (page) replacement verification — FIFO vs LRU, with correct PTE
 * invalidation and TLB flush.  Run:  node test/replacement.verify.js
 *
 * Setup note: TLB is made large (8) so the TLB never evicts on its own —
 * this isolates PAGE replacement from TLB replacement.
 */
const E = require('../js/engine.js');
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n        got  ' + a + '\n        want ' + b); }
};
const ok = (name, c) => eq(name, !!c, true);
function run(eng, va) {
  const s = eng.access(va);
  const res = s.find(x => x.key === 'tlb-result');
  return { hit: /HIT/.test(res.title), stats: s[s.length - 1].snapshot.stats };
}
const P = p => p * 4096; // page number -> address (4KB pages)

// ============================================================================
console.log('\n[R1] FIFO eviction + PTE invalidation + TLB flush  (2 frames)');
let c = E.buildConfig({ vas: 65536, pas: 8192, pageSize: 4096, tlbEntries: 8, tlbPolicy: 'LRU', replPolicy: 'FIFO', levels: 1 });
eq('2 frames', c.numFrames, 2);
let e = new E.Engine(c);
run(e, P(1)); run(e, P(2));               // frames full: page1->f0, page2->f1
let r3 = run(e, P(3));                     // page3 faults -> FIFO evicts page1 (oldest, frame0)
eq('page 3 reused frame 0', e.frames[0].vpn, 3);
eq('exactly one replacement so far', r3.stats.replacements, 1);
ok('evicted page 1 PTE is now invalid', e.root[1] && e.root[1].valid === false);
ok('evicted page 1 flushed from TLB', e._findTLB(1) === -1);
let r1again = run(e, P(1));                 // page1 re-access -> must fault again
ok('re-access of evicted page is a TLB miss', r1again.hit === false);
eq('that re-access is a fresh page fault (4 total)', r1again.stats.pageFaults, 4);

// ============================================================================
console.log('\n[R2] FIFO vs LRU diverge on ref 1,2,1,3,2  (2 frames)');
const seq = [1, 2, 1, 3, 2];
function trace(policy) {
  const cfg = E.buildConfig({ vas: 65536, pas: 8192, pageSize: 4096, tlbEntries: 8, tlbPolicy: 'LRU', replPolicy: policy, levels: 1 });
  const eng = new E.Engine(cfg);
  let last; seq.forEach(p => { last = run(eng, P(p)); });
  return { finalHit: last.hit, faults: last.stats.pageFaults, repl: last.stats.replacements };
}
let fifo = trace('FIFO'), lru = trace('LRU');
console.log('    FIFO:', JSON.stringify(fifo), '  LRU:', JSON.stringify(lru));
// FIFO: page2 stays resident -> final access 2 HITS; 3 faults; 1 replacement
eq('FIFO final access 2 -> hit', fifo.finalHit, true);
eq('FIFO faults = 3', fifo.faults, 3);
eq('FIFO replacements = 1', fifo.repl, 1);
// LRU: page2 was evicted by the time we revisit -> final access 2 FAULTS; 4 faults; 2 replacements
eq('LRU final access 2 -> miss (was evicted)', lru.finalHit, false);
eq('LRU faults = 4', lru.faults, 4);
eq('LRU replacements = 2', lru.repl, 2);

// ============================================================================
console.log('\n[R3] Working set <= frames -> NO replacement');
let c3 = E.buildConfig({ vas: 65536, pas: 16384, pageSize: 4096, tlbEntries: 8, tlbPolicy: 'LRU', replPolicy: 'FIFO', levels: 1 });
eq('4 frames', c3.numFrames, 4);
let e3 = new E.Engine(c3);
let last3; [1, 2, 3, 1, 2, 3].forEach(p => { last3 = run(e3, P(p)); });
eq('no replacements (3 pages, 4 frames)', last3.stats.replacements, 0);
eq('only 3 page faults', last3.stats.pageFaults, 3);

console.log('\n' + pass + ' passed, ' + fail + ' failed.\n');
process.exit(fail ? 1 : 0);
