# VMVisualizer

A zero-install, dependency-free **Virtual Memory & Address Translation** simulator for teaching
(undergrad / GATE / FDP). Pure HTML + CSS + JavaScript — open `index.html` in any browser.

## Run
- Double-click `index.html`, **or** serve the folder: `python3 -m http.server` then visit `localhost:8000`.
- No build step, no backend, no external libraries.

## Features
- Configurable virtual/physical address space, page size, TLB entries, **FIFO/LRU** policy, and **1/2/3-level** page tables.
- Five synchronized views: Virtual Memory · TLB · Page Table (multi-level path) · Physical Memory · Address Breakdown.
- 8-stage step-by-step translation with **Next / Prev / Run / Pause / Reset** and a live Information panel.
- Statistics: hits, misses, hit/miss rate, page-table walks, page faults, evictions (FIFO/LRU).
- Built-in examples + sample-workload generator.

## Layout
```
index.html          # structure + view containers
css/styles.css      # clean academic theme
js/engine.js        # pure translation engine (DOM-free, unit-tested)
js/examples.js      # example configs + workload generator
js/ui.js            # rendering of the five views + timeline navigation
js/main.js          # DOM wiring
test/engine.test.js # headless correctness tests:  node test/engine.test.js
```

## Conventions (textbook-accurate)
- `offsetBits = log2(pageSize)`, `vpnBits = log2(VAS) − offsetBits`, `pfnBits = log2(PAS) − offsetBits`.
- Multi-level: VPN bits split MSB-first (level 1 = outermost); even split, remainder to outer levels. A custom `levelBits[]` may be supplied for GATE-exact problems.
- Physical allocation is a **bump allocator** (contiguous from free space) — educational simplicity; frame replacement is a roadmap item (kept out so the page table never shows stale mappings).
