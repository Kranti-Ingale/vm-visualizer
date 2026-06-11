/* VMVisualizer — wire DOM controls to the UI controller. */
(function () {
  'use strict';
  const ui = new window.VMUI();
  const $ = id => document.getElementById(id);

  // populate example dropdown
  const sel = $('exampleSelect');
  Object.keys(window.VMExamples.EXAMPLES).forEach(key => {
    const o = document.createElement('option');
    o.value = key; o.textContent = window.VMExamples.EXAMPLES[key].label;
    sel.appendChild(o);
  });

  function loadExample(key) {
    const ex = window.VMExamples.EXAMPLES[key];
    if (!ex) return;
    const fmt = window.VMUI.formatSize;
    $('vas').value = fmt(ex.cfg.vas); $('pas').value = fmt(ex.cfg.pas); $('pageSize').value = fmt(ex.cfg.pageSize);
    $('pteSize').value = fmt(ex.cfg.pteSize || 4);
    $('tlbEntries').value = ex.cfg.tlbEntries; $('tlbPolicy').value = ex.cfg.tlbPolicy;
    $('replPolicy').value = ex.cfg.replPolicy || 'FIFO';
    $('levels').value = ex.cfg.levels;
    ui.requests = ex.requests.slice();
    if (ui.apply()) ui.renderQueue();
  }

  sel.addEventListener('change', e => { if (e.target.value) loadExample(e.target.value); });
  $('applyBtn').addEventListener('click', () => ui.apply());
  $('clearCfgBtn').addEventListener('click', () => {
    ['vas', 'pas', 'pageSize', 'pteSize', 'tlbEntries', 'levels'].forEach(id => { $(id).value = ''; });
    sel.value = '';
    ui.clear();
  });
  $('addReqBtn').addEventListener('click', () => { ui.addRequest($('reqInput').value); $('reqInput').value = ''; });
  $('reqInput').addEventListener('keydown', e => { if (e.key === 'Enter') { ui.addRequest($('reqInput').value); $('reqInput').value = ''; } });
  $('genBtn').addEventListener('click', () => ui.generate());
  $('clearReqBtn').addEventListener('click', () => ui.clearRequests());
  $('prevBtn').addEventListener('click', () => ui.prev());
  $('nextBtn').addEventListener('click', () => ui.next());
  $('runBtn').addEventListener('click', () => ui.run());
  $('pauseBtn').addEventListener('click', () => ui.pause());
  $('resetBtn').addEventListener('click', () => ui.reset());

  // start with a friendly default example
  sel.value = 'simple'; loadExample('simple');
})();
