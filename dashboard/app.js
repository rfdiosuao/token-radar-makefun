// Token Radar dashboard: renders window.RADAR (written by main.ts into
// data.js beside this page). No fetch, no network, no framework.
// Columns sort on click; rows open a detail panel with the value breakdown
// and the farm plan. Deep links: #detail=<slug>, #chain=<chain>, #q=<text>.

(function () {
  var D = window.RADAR;
  if (!D || !D.rows) {
    document.body.innerHTML = '<p style="padding:32px">Radar data is missing.</p>';
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var state = { q: '', chain: '', cat: '', tab: 'board', sort: 'rank', dir: 1, sel: null };

  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ageText(r) {
    if (r.age_days === null || r.age_days === undefined) return '—';
    if (r.age_days < 365) return r.age_days + 'd';
    return (r.age_days / 365).toFixed(1) + 'y';
  }
  function changeHtml(v) {
    if (v === null || v === undefined) return '<span class="flat">n/a</span>';
    var cls = v > 0.5 ? 'up' : v < -0.5 ? 'down' : 'flat';
    var sign = v > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + v.toFixed(1) + '%</span>';
  }

  // Header stats.
  var top = D.rows[0];
  $('stats').innerHTML =
    '<div class="stat"><b>' + D.board_size + '</b><span>protocols ranked</span></div>' +
    '<div class="stat"><b>' + D.watchlist_size + '</b><span>watchlist covered</span></div>' +
    '<div class="stat"><b>' + money(top ? top.implied_value_usd : 0) + '</b><span>top implied value</span></div>' +
    '<div class="stat"><b>' + esc(D.as_of) + '</b><span>snapshot date</span></div>';

  // Filter options, built from the data (sorted, no duplicates).
  function fillSelect(el, values) {
    var seen = {};
    values.forEach(function (v) { if (v) seen[v] = true; });
    Object.keys(seen).sort().forEach(function (v) {
      var o = document.createElement('option');
      o.value = v; o.textContent = v;
      el.appendChild(o);
    });
  }
  fillSelect($('chain'), D.rows.flatMap(function (r) { return r.chains; }));
  fillSelect($('cat'), D.rows.map(function (r) { return r.category; }));

  // Column definitions: label, key, numeric?
  var COLS = [
    { label: '#', key: 'rank', num: true },
    { label: 'Protocol', key: 'name', num: false },
    { label: 'Category', key: 'category', num: false },
    { label: 'Chains', key: 'chains', num: false },
    { label: 'TVL', key: 'tvl_usd', num: true },
    { label: '7d', key: 'change_7d', num: true },
    { label: 'Age', key: 'age_days', num: true },
    { label: 'Implied value', key: 'implied_value_usd', num: true },
  ];
  var LIVE_COLS = [
    { label: 'Protocol', key: 'name', num: false },
    { label: 'Category', key: 'category', num: false },
    { label: 'Chains', key: 'chains', num: false },
    { label: 'TVL', key: 'tvl_usd', num: true },
    { label: '7d', key: 'change_7d', num: true },
    { label: 'Market cap', key: 'mcap_usd', num: true },
  ];

  function sortVal(r, key) {
    var v = r[key];
    if (v === null || v === undefined) return state.dir === 1 ? Infinity : -Infinity;
    if (Array.isArray(v)) return v.length;
    return v;
  }
  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = state.tab === 'live' ? D.live.slice() : D.rows.slice();
    if (state.tab === 'board') {
      list = list.filter(function (r) {
        if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
        if (state.cat && r.category !== state.cat) return false;
        if (q && (r.name + ' ' + r.slug).toLowerCase().indexOf(q) === -1) return false;
        return true;
      });
    } else if (q) {
      list = list.filter(function (r) { return (r.name + ' ' + r.slug).toLowerCase().indexOf(q) !== -1; });
    }
    var key = state.sort;
    list.sort(function (a, b) {
      var va = sortVal(a, key), vb = sortVal(b, key);
      if (va < vb) return -1 * state.dir;
      if (va > vb) return 1 * state.dir;
      return (a.slug < b.slug ? -1 : 1);
    });
    return list;
  }

  function renderHead() {
    var cols = state.tab === 'live' ? LIVE_COLS : COLS;
    $('head').innerHTML = cols.map(function (c) {
      var arrow = state.sort === c.key ? (state.dir === 1 ? ' ▲' : ' ▼') : '';
      return '<th class="' + (c.num ? 'num' : '') + '"><button data-k="' + c.key + '">' + esc(c.label) + arrow + '</button></th>';
    }).join('');
    Array.prototype.forEach.call($('head').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-k');
        if (state.sort === k) state.dir = -state.dir;
        else { state.sort = k; state.dir = k === 'name' || k === 'category' ? 1 : -1; }
        render();
      });
    });
  }

  function renderRows() {
    var list = filtered();
    var live = state.tab === 'live';
    $('count').textContent = list.length + ' of ' + (live ? D.live_size : D.board_size) + ' shown';
    if (list.length === 0) {
      $('rows').innerHTML = '<tr><td class="empty" colspan="8">No protocols match these filters.</td></tr>';
      return;
    }
    $('rows').innerHTML = list.map(function (r) {
      if (live) {
        return '<tr data-slug="' + esc(r.slug) + '">' +
          '<td class="name"><b>' + esc(r.name) + '</b><small>' + esc(r.slug) + '</small></td>' +
          '<td>' + esc(r.category || '—') + '</td>' +
          '<td>' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
          '<td class="num">' + money(r.tvl_usd) + '</td>' +
          '<td class="num">' + changeHtml(r.change_7d) + '</td>' +
          '<td class="num val">' + money(r.mcap_usd) + '</td></tr>';
      }
      return '<tr data-slug="' + esc(r.slug) + '" class="' + (state.sel === r.slug ? 'sel' : '') + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td class="name"><b>' + esc(r.name) + '</b><small>' + esc(r.slug) + '</small></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + changeHtml(r.change_7d) + '</td>' +
        '<td class="num">' + ageText(r) + '</td>' +
        '<td class="num val">' + money(r.implied_value_usd) + '</td></tr>';
    }).join('');
    Array.prototype.forEach.call($('rows').querySelectorAll('tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug')); });
    });
  }

  function openDetail(slug) {
    var r = null;
    D.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    var box = $('detail');
    if (!r) { box.hidden = true; state.sel = null; renderRows(); return; }
    state.sel = slug;
    var base = Math.round(r.implied_value_usd / (r.growth_factor * r.age_factor * r.chain_factor * r.sector_factor));
    box.hidden = false;
    box.innerHTML =
      '<button class="close" id="dclose">Close ✕</button>' +
      '<h2>' + esc(r.name) + ' <small>rank #' + r.rank + ' · ' + esc(r.slug) + '</small></h2>' +
      '<div class="meta"><span>TVL <b>' + money(r.tvl_usd) + '</b></span>' +
      '<span>7d <b>' + (r.change_7d === null ? 'n/a' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</b></span>' +
      '<span>Age <b>' + ageText(r) + '</b></span>' +
      '<span>Listed <b>' + esc(r.listed_at || 'unknown') + '</b></span>' +
      '<span>Category <b>' + esc(r.category || '—') + '</b></span>' +
      '<span>Chains <b>' + esc(r.chains.slice(0, 5).join(', ') + (r.chains.length > 5 ? ' +' + (r.chains.length - 5) + ' more' : '') || '—') + '</b></span>' +
      '<span>Implied value <b>' + money(r.implied_value_usd) + '</b></span></div>' +
      '<div class="breakdown">' +
      '<span class="chip">size base <b>' + money(base) + '</b></span>' +
      '<span class="chip">growth ×<b>' + r.growth_factor.toFixed(2) + '</b></span>' +
      '<span class="chip">age ×<b>' + r.age_factor.toFixed(2) + '</b></span>' +
      '<span class="chip">chains ×<b>' + r.chain_factor.toFixed(2) + '</b></span>' +
      '<span class="chip">sector ×<b>' + r.sector_factor.toFixed(2) + '</b></span>' +
      '</div>' +
      '<h2>Farm plan — ' + r.farm_steps.length + ' steps</h2>' +
      '<ol>' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    $('dclose').addEventListener('click', function () { box.hidden = true; state.sel = null; renderRows(); });
    renderRows();
    box.scrollIntoView({ block: 'nearest' });
  }

  function render() { renderHead(); renderRows(); }

  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderRows(); });
  $('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderRows(); });
  $('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderRows(); });
  $('tab').addEventListener('change', function (e) {
    state.tab = e.target.value;
    state.sort = state.tab === 'live' ? 'mcap_usd' : 'rank';
    state.dir = state.tab === 'live' ? -1 : 1;
    $('detail').hidden = true; state.sel = null;
    render();
  });

  // Deep links for screenshots and sharing: #detail=<slug>&chain=<chain>&q=<text>
  var hash = window.location.hash.slice(1);
  if (hash) {
    hash.split('&').forEach(function (part) {
      var kv = part.split('=');
      var k = kv[0], v = decodeURIComponent(kv[1] || '');
      if (k === 'chain' && v) { state.chain = v; $('chain').value = v; }
      if (k === 'cat' && v) { state.cat = v; $('cat').value = v; }
      if (k === 'q' && v) { state.q = v; $('q').value = v; }
      if (k === 'detail' && v) state.sel = v;
    });
  }
  render();
  if (state.sel) openDetail(state.sel);
})();
