/* Headless correctness tests for the translation engine. Run: node test/engine.test.js */
const E = require('../js/engine.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n   got  ' + a + '\n   want ' + b); }
}

// --- config maths (VAS 64KB, PAS 16KB, page 1KB) -----------------------------
let cfg = E.buildConfig({ vas: 65536, pas: 16384, pageSize: 1024, tlbEntries: 4, tlbPolicy: 'FIFO', levels: 1 });
eq('cfg.ok', cfg.ok, true);
eq('offsetBits', cfg.offsetBits, 10);
eq('vaBits', cfg.vaBits, 16);
eq('paBits', cfg.paBits, 14);
eq('vpnBits', cfg.vpnBits, 6);
eq('pfnBits', cfg.pfnBits, 4);
eq('numPages', cfg.numPages, 64);
eq('numFrames', cfg.numFrames, 16);

// --- bit splitting for levels ------------------------------------------------
eq('split 6/2', E.splitVpnBits(6, 2), [3, 3]);
eq('split 6/3', E.splitVpnBits(6, 3), [2, 2, 2]);
eq('split 7/2 (remainder to outer)', E.splitVpnBits(7, 2), [4, 3]);
// index extraction: vpn=0b101101 (45), levelBits [3,3] -> 0b101=5 , 0b101=5
eq('extract 45 [3,3]', E.extractIndices(45, [3, 3]), [5, 5]);
// vpn = 0b100110 (38), [2,2,2] -> 10=2, 01=1, 10=2
eq('extract 38 [2,2,2]', E.extractIndices(38, [2, 2, 2]), [2, 1, 2]);

// --- single-level translation, page faults, PA -------------------------------
let eng = new E.Engine(cfg);
let s = eng.access(0x0405); // 1029 -> vpn=1 (1024..2047), offset=5
let last = s[s.length - 1].snapshot;
eq('first access is miss', s.find(x => x.key === 'tlb-result').title, 'TLB MISS');
eq('page fault count', last.stats.pageFaults, 1);
// PFN should be frame 0 (bump), PA = 0*1024 + 5 = 5
eq('PA after fault', s.find(x => x.key === 'pa').snapshot.pa, 5);
eq('frame0 used by vpn1', { used: last.frames[0].used, vpn: last.frames[0].vpn }, { used: true, vpn: 1 });

// same page again -> TLB hit, no new fault
s = eng.access(0x0401); // vpn 1, offset 1
eq('second access hit', s.find(x => x.key === 'tlb-result').title, 'TLB HIT');
eq('still one fault', s[s.length - 1].snapshot.stats.pageFaults, 1);
eq('hit PA', s.find(x => x.key === 'pa').snapshot.pa, 1);

// --- FIFO eviction proof: pages 1,2,3,1,4,1 with TLB=3 -----------------------
function pageAddr(p, cfg) { return p * cfg.pageSize; }
let f = E.buildConfig({ vas: 65536, pas: 65536, pageSize: 4096, tlbEntries: 3, tlbPolicy: 'FIFO', levels: 1 });
let fe = new E.Engine(f);
const seq = [1, 2, 3, 1, 4, 1];
const fres = seq.map(p => { const st = fe.access(pageAddr(p, f)); return st.find(x => x.key === 'tlb-result').title.includes('HIT'); });
// FIFO: only step-4 (the 2nd access to page 1) hits => [F,F,F,T,F,F]
eq('FIFO hit pattern', fres, [false, false, false, true, false, false]);
eq('FIFO final hits', fe.stats.tlbHits, 1);

// --- LRU on the same sequence: page 1 survives => last access hits -----------
let l = E.buildConfig({ vas: 65536, pas: 65536, pageSize: 4096, tlbEntries: 3, tlbPolicy: 'LRU', levels: 1 });
let le = new E.Engine(l);
const lres = seq.map(p => { const st = le.access(pageAddr(p, l)); return st.find(x => x.key === 'tlb-result').title.includes('HIT'); });
// LRU: step-4 hit AND step-6 hit => [F,F,F,T,F,T]
eq('LRU hit pattern', lres, [false, false, false, true, false, true]);
eq('LRU final hits', le.stats.tlbHits, 2);

// --- two-level walk correctness ---------------------------------------------
// fits-in-a-page: page 1KB / PTE 128B -> 8 entries/table (innerBits 3); vpn 6 -> [3,3]
let t2 = E.buildConfig({ vas: 65536, pas: 16384, pageSize: 1024, pteSize: 128, tlbEntries: 4, tlbPolicy: 'LRU', levels: 2 });
eq('two-level split', t2.levelBits, [3, 3]);
let te = new E.Engine(t2);
let ts = te.access(45 * 1024 + 7); // vpn=45 -> L1=5,L2=5 ; offset 7
const walkStep = ts.find(x => x.key === 'walk');
eq('two-level indices', walkStep.indices, [5, 5]);
eq('two-level offset', ts[0].breakdown.offset, 7);
eq('two-level PA', ts.find(x => x.key === 'pa').snapshot.pa, 0 * 1024 + 7); // first frame

// --- invalid address ---------------------------------------------------------
let bad = new E.Engine(cfg).access(70000);
eq('invalid address flagged', bad[0].stage, 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
