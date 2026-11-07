/*
 * Pentomino Daily - UI, rendering and input. Game rules live in core.js.
 *
 * Positions are stored in "units" (board-cell widths, origin = board top-left) so the
 * layout can be recomputed on resize without moving pieces around.
 */
(function () {
  'use strict';

  var C = window.PentoCore;
  var $ = function (id) { return document.getElementById(id); };

  var canvas = $('board');
  var ctx = canvas.getContext('2d');
  var stage = $('stage');
  var statusEl = $('status');
  var winDialog = $('win');
  var helpDialog = $('help');

  var ACCENT = '#ffb454';
  var PAD = 8;
  var params = new URLSearchParams(location.search);

  var store = {
    get: function (k) {
      try {
        var v = localStorage.getItem(k);
        return v === null ? null : JSON.parse(v);
      } catch (e) { return null; }
    },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    remove: function (k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } },
  };

  // ----------------------------------------------------------------- game state
  var data = null;
  var img = null;
  var puzzleDate = '';
  var cols = 5;
  var rows = 6;
  var pieces = [];
  var states = [];
  var initial = [];
  var trayOrder = [];
  var zOrder = [];
  var selected = -1;
  var drag = null;
  var won = false;
  var practice = false; // replaying after a win: the new result is not saved
  var moves = 0;
  var hints = 0;
  var hintId = -1;
  var hintTimer = 0;
  var outlineAlpha = 1;
  var lastResult = null;
  var clock = { running: false, base: 0, since: 0 };
  var timerId = 0;
  var pausedByHidden = false;

  // --------------------------------------------------------------------- layout
  var W = 0;
  var H = 0;
  var dpr = 1;
  var s = 40; // px per board cell
  var bx = 0;
  var by = PAD;
  var trayTop = 0;
  var tray = { rho: 0.5, slots: [] };
  var boardImg = null;
  var raf = 0;

  function invalidate() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      draw();
    });
  }

  function layout() {
    var rect = stage.getBoundingClientRect();
    W = Math.max(120, rect.width);
    H = Math.max(160, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (!pieces.length) {
      invalidate();
      return;
    }
    var maxBoardH = Math.max(140, (H - 2 * PAD) * 0.6);
    s = Math.max(16, Math.floor(Math.min((W - 2 * PAD) / cols, maxBoardH / rows, 88)));
    bx = Math.round((W - cols * s) / 2);
    by = PAD;
    trayTop = by + rows * s + 14;
    var trayW = W - 2 * PAD;
    var trayH = Math.max(40, H - trayTop - PAD);
    tray = C.layoutTray(trayOrder.map(function (id) { return pieces[id].half; }), trayW / s, trayH / s, 6 / s);
    var ox = (PAD - bx) / s;
    var oy = (trayTop - by) / s;
    trayOrder.forEach(function (id, k) {
      var st = states[id];
      st.slot = [ox + tray.slots[k].cx, oy + tray.slots[k].cy];
      if (!st.placed && !st.dragging) st.pivot = st.slot.slice();
    });
    buildBoardImage();
    invalidate();
  }

  // The picture, centre-cropped to the board's aspect ratio, pre-rendered once per layout.
  function buildBoardImage() {
    var cell = Math.max(32, Math.min(256, Math.ceil(s * dpr)));
    var off = document.createElement('canvas');
    off.width = cols * cell;
    off.height = rows * cell;
    var iw = img.naturalWidth;
    var ih = img.naturalHeight;
    var aspect = cols / rows;
    var cw = iw / ih > aspect ? ih * aspect : iw;
    var ch = iw / ih > aspect ? ih : iw / aspect;
    off.getContext('2d').drawImage(img, (iw - cw) / 2, (ih - ch) / 2, cw, ch, 0, 0, off.width, off.height);
    boardImg = { canvas: off, cell: cell };
  }

  // -------------------------------------------------------------------- drawing
  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function traceEdges(p, px, py, cs, r, f) {
    ctx.beginPath();
    for (var i = 0; i < p.edges.length; i++) {
      var e = p.edges[i];
      var d = p.d[e.k];
      var nx = e.n[0];
      var ny = e.n[1];
      var tx = 0 - ny;
      var ty = nx;
      var a = C.applyT([d[0] + nx * 0.5 + tx * 0.5, d[1] + ny * 0.5 + ty * 0.5], r, f);
      var b = C.applyT([d[0] + nx * 0.5 - tx * 0.5, d[1] + ny * 0.5 - ty * 0.5], r, f);
      ctx.moveTo(px + a[0] * cs, py + a[1] * cs);
      ctx.lineTo(px + b[0] * cs, py + b[1] * cs);
    }
  }

  function drawHint(p) {
    ctx.save();
    ctx.fillStyle = 'rgba(255, 180, 84, 0.3)';
    p.home.forEach(function (c) { ctx.fillRect(bx + c[0] * s, by + c[1] * s, s, s); });
    traceEdges(p, bx + p.centroid[0] * s, by + p.centroid[1] * s, s, 0, false);
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = ACCENT;
    ctx.stroke();
    ctx.restore();
  }

  function drawPiece(id) {
    var p = pieces[id];
    var st = states[id];
    var scale = st.placed || st.dragging ? 1 : tray.rho;
    var cs = s * scale;
    var px = bx + st.pivot[0] * s;
    var py = by + st.pivot[1] * s;
    var cell = boardImg.cell;
    var k;
    var v;

    if (st.dragging) {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = '#000';
      for (k = 0; k < p.d.length; k++) {
        v = C.applyT(p.d[k], st.r, st.f);
        ctx.fillRect(px + v[0] * cs - cs / 2, py + v[1] * cs - cs / 2, cs, cs);
      }
      ctx.restore();
    }

    for (k = 0; k < p.d.length; k++) {
      v = C.applyT(p.d[k], st.r, st.f);
      ctx.save();
      ctx.translate(px + v[0] * cs, py + v[1] * cs);
      ctx.rotate((st.r & 3) * Math.PI / 2);
      if (st.f) ctx.scale(-1, 1);
      ctx.drawImage(boardImg.canvas, p.home[k][0] * cell, p.home[k][1] * cell, cell, cell,
        -cs / 2 - 0.4, -cs / 2 - 0.4, cs + 0.8, cs + 0.8);
      ctx.restore();
    }

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    traceEdges(p, px, py, cs, st.r, st.f);
    if (id === selected && !won) {
      ctx.lineWidth = Math.max(3, cs * 0.09);
      ctx.strokeStyle = ACCENT;
      ctx.shadowColor = ACCENT;
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    if (outlineAlpha > 0) {
      ctx.globalAlpha = outlineAlpha;
      ctx.lineWidth = Math.max(1.5, cs * 0.05);
      ctx.strokeStyle = 'rgba(8, 10, 20, 0.9)';
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!pieces.length || !boardImg) return;

    // board
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    roundRectPath(bx - 4, by - 4, cols * s + 8, rows * s + 8, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i <= cols; i++) { ctx.moveTo(bx + i * s + 0.5, by); ctx.lineTo(bx + i * s + 0.5, by + rows * s); }
    for (var j = 0; j <= rows; j++) { ctx.moveTo(bx, by + j * s + 0.5); ctx.lineTo(bx + cols * s, by + j * s + 0.5); }
    ctx.stroke();

    // tray
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    roundRectPath(PAD, trayTop - 6, W - 2 * PAD, Math.max(20, H - trayTop - PAD + 6), 10);
    ctx.fill();

    if (hintId >= 0) drawHint(pieces[hintId]);
    for (var z = 0; z < zOrder.length; z++) drawPiece(zOrder[z]);
  }

  // ------------------------------------------------------------------- hit test
  function hit(x, y) {
    for (var z = zOrder.length - 1; z >= 0; z--) {
      var id = zOrder[z];
      var p = pieces[id];
      var st = states[id];
      var px = bx + st.pivot[0] * s;
      var py = by + st.pivot[1] * s;
      if (st.placed) {
        for (var k = 0; k < p.d.length; k++) {
          var v = C.applyT(p.d[k], st.r, st.f);
          if (Math.abs(x - (px + v[0] * s)) <= s / 2 && Math.abs(y - (py + v[1] * s)) <= s / 2) return id;
        }
      } else {
        // Loose pieces are small, so the whole slot around them is a touch target.
        var reach = p.half * s * tray.rho;
        if (Math.abs(x - px) <= reach && Math.abs(y - py) <= reach) return id;
      }
    }
    return -1;
  }

  function occupiedMap(except) {
    var m = new Map();
    pieces.forEach(function (p, i) {
      var st = states[i];
      if (i === except || !st.placed) return;
      C.cellsAt(p, st.r, st.f, st.g0).forEach(function (c) { m.set(c[0] + ',' + c[1], i); });
    });
    return m;
  }

  function bringToFront(id) {
    zOrder = zOrder.filter(function (x) { return x !== id; });
    zOrder.push(id);
  }

  function select(id) {
    selected = id;
    if (id >= 0) bringToFront(id);
    updateHud();
    invalidate();
  }

  // ----------------------------------------------------------------- piece moves
  function transformPiece(id, kind) {
    if (won || id < 0) return;
    var st = states[id];
    var p = pieces[id];
    var nr = kind === 'rot' ? (st.r + 1) & 3 : (4 - st.r) & 3; // flip mirrors left-right on screen
    var nf = kind === 'rot' ? st.f : !st.f;
    startClock();
    if (st.placed) {
      var snap = C.findSnap(p, nr, nf, st.pivot, { cols: cols, rows: rows, occupied: occupiedMap(id), radius: 2 });
      st.r = nr;
      st.f = nf;
      if (snap) {
        st.g0 = snap.g0;
        st.pivot = snap.pivot;
      } else { // no room to turn it in place: it pops back to the tray
        st.placed = false;
        st.g0 = null;
        st.pivot = st.slot.slice();
      }
    } else {
      st.r = nr;
      st.f = nf;
    }
    moves++;
    updateHud();
    invalidate();
    checkWin();
  }

  function restorePrev(st, prev) {
    st.placed = prev.placed;
    st.g0 = prev.g0;
    st.r = prev.r;
    st.f = prev.f;
    st.pivot = prev.pivot.slice();
  }

  function dropPiece(id, y) {
    var st = states[id];
    var p = pieces[id];
    var prev = drag.prev;
    st.dragging = false;
    var snap = C.findSnap(p, st.r, st.f, st.pivot, { cols: cols, rows: rows, occupied: occupiedMap(id), radius: 1 });
    if (snap) {
      st.placed = true;
      st.g0 = snap.g0;
      st.pivot = snap.pivot;
    } else if (y > by + rows * s) {
      st.placed = false;
      st.g0 = null;
      st.pivot = st.slot.slice();
    } else {
      restorePrev(st, prev);
    }
    var changed = prev.placed !== st.placed ||
      (st.placed && (prev.g0[0] !== st.g0[0] || prev.g0[1] !== st.g0[1]));
    if (changed) moves++;
    updateHud();
    invalidate();
    checkWin();
  }

  // ---------------------------------------------------------------------- input
  function pos(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (!pieces.length) return;
    if (won) {
      if (lastResult) showWin(lastResult);
      return;
    }
    if (e.button !== undefined && e.button > 0) return;
    var pt = pos(e);
    var id = hit(pt.x, pt.y);
    if (id < 0) {
      select(-1);
      return;
    }
    var st = states[id];
    var scale = st.placed ? 1 : tray.rho;
    drag = {
      id: id,
      pointerId: e.pointerId,
      sx: pt.x,
      sy: pt.y,
      // grab point relative to the pivot, in px at full size
      offX: (pt.x - (bx + st.pivot[0] * s)) / scale,
      offY: (pt.y - (by + st.pivot[1] * s)) / scale,
      moved: false,
      wasSelected: selected === id,
      prev: { placed: st.placed, g0: st.g0 ? st.g0.slice() : null, r: st.r, f: st.f, pivot: st.pivot.slice() },
    };
    select(id);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var pt = pos(e);
    var st = states[drag.id];
    if (!drag.moved) {
      if (Math.hypot(pt.x - drag.sx, pt.y - drag.sy) < 6) return;
      drag.moved = true;
      startClock();
      st.dragging = true;
      st.placed = false; // lifted off the board
    }
    st.pivot = [(pt.x - drag.offX - bx) / s, (pt.y - drag.offY - by) / s];
    invalidate();
  });

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var d = drag;
    drag = null;
    var pt = pos(e);
    if (!d.moved) {
      if (!cancelled && d.wasSelected) transformPiece(d.id, 'rot'); // tap the selected piece again to rotate
      return;
    }
    if (cancelled) {
      var st = states[d.id];
      st.dragging = false;
      restorePrev(st, d.prev);
      invalidate();
      return;
    }
    drag = d; // dropPiece reads drag.prev
    dropPiece(d.id, pt.y);
    drag = null;
  }

  canvas.addEventListener('pointerup', function (e) { endDrag(e, false); });
  canvas.addEventListener('pointercancel', function (e) { endDrag(e, true); });

  $('btn-rotate').addEventListener('click', function () { transformPiece(selected, 'rot'); });
  $('btn-flip').addEventListener('click', function () { transformPiece(selected, 'flip'); });
  $('btn-hint').addEventListener('click', useHint);
  $('btn-restart').addEventListener('click', restart);
  $('btn-help').addEventListener('click', function () { helpDialog.showModal(); });
  $('btn-share').addEventListener('click', share);

  document.addEventListener('keydown', function (e) {
    if (winDialog.open || helpDialog.open || e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === 'r') transformPiece(selected, 'rot');
    else if (k === 'f') transformPiece(selected, 'flip');
    else if (k === 'h') useHint();
    else if (k === 'escape') select(-1);
  });

  helpDialog.addEventListener('close', function () { store.set('pd:seenHelp', true); });

  // ---------------------------------------------------------------------- clock
  function elapsed() {
    return clock.base + (clock.running ? (Date.now() - clock.since) / 1000 : 0);
  }

  function startClock() {
    if (clock.running || won) return;
    clock.running = true;
    clock.since = Date.now();
    if (!timerId) timerId = setInterval(updateHud, 250);
  }

  function stopClock() {
    clock.base = elapsed();
    clock.running = false;
    if (timerId) clearInterval(timerId);
    timerId = 0;
    updateHud();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && clock.running) {
      pausedByHidden = true;
      stopClock();
    } else if (!document.hidden && pausedByHidden && !won) {
      pausedByHidden = false;
      startClock();
    }
  });

  function updateHud() {
    $('timer').textContent = C.formatTime(elapsed() + hints * C.HINT_PENALTY_SECONDS);
    $('moves').textContent = moves + (moves === 1 ? ' move' : ' moves');
    var h = $('hints');
    h.hidden = hints === 0;
    h.textContent = '💡' + hints;
    $('btn-rotate').disabled = selected < 0 || won;
    $('btn-flip').disabled = selected < 0 || won;
    $('btn-hint').disabled = won;
  }

  // ----------------------------------------------------------------------- hints
  function useHint() {
    if (won || !pieces.length) return;
    var wrong = pieces.filter(function (p, i) { return !C.isHome(p, states[i]); });
    if (!wrong.length) return;
    var pick = selected >= 0 && !C.isHome(pieces[selected], states[selected])
      ? pieces[selected]
      : wrong[Math.floor(Math.random() * wrong.length)];
    startClock();
    hints++;
    hintId = pick.id;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { hintId = -1; invalidate(); }, 2200);
    updateHud();
    invalidate();
  }

  // -------------------------------------------------------------------- win/lose
  function checkWin() {
    if (!won && C.isSolved(pieces, states)) finish();
  }

  function finish() {
    won = true;
    // A symmetric piece may sit in its mirrored/turned twin orientation; show it the
    // way the picture is cut so the finished photo is exactly right.
    pieces.forEach(function (p, i) {
      var st = states[i];
      st.r = 0;
      st.f = false;
      st.g0 = p.home[0].slice();
      st.pivot = C.pivotForGrid(p, 0, false, st.g0);
    });
    selected = -1;
    hintId = -1;
    stopClock();
    var seconds = Math.round(elapsed() + hints * C.HINT_PENALTY_SECONDS);
    var result = { seconds: seconds, moves: moves, hints: hints };
    if (!params.has('seed') && !practice) {
      store.set('pd:done:' + puzzleDate, result);
      store.set('pd:stats', C.updateStats(store.get('pd:stats'), puzzleDate, seconds));
    }
    lastResult = result;
    updateHud();
    var t0 = Date.now();
    (function fade() {
      outlineAlpha = Math.max(0, 1 - (Date.now() - t0) / 700);
      invalidate();
      if (outlineAlpha > 0) setTimeout(fade, 30);
      else showWin(result);
    })();
  }

  function showWin(result) {
    var stats = store.get('pd:stats') || {};
    $('win-image').src = data.image;
    $('win-image').alt = data.title || 'Picture of the day';
    $('win-title').textContent = data.title || 'Solved!';
    var credit = $('win-credit');
    credit.textContent = [data.source, data.credit].filter(Boolean).join(' · ');
    if (/^https?:\/\//i.test(data.pageUrl || '')) {
      var a = document.createElement('a');
      a.href = data.pageUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'View original';
      credit.append(' · ', a);
    }
    var bits = ['⏱ ' + C.formatTime(result.seconds), '🔄 ' + result.moves];
    if (result.hints) bits.push('💡 ' + result.hints);
    if (stats.streak) bits.push('🔥 ' + stats.streak + '-day streak');
    if (stats.best !== null && stats.best !== undefined) bits.push('best ' + C.formatTime(stats.best));
    $('win-stats').textContent = bits.join(' · ');
    $('win-desc').textContent = data.description || '';
    $('toast').textContent = '';
    if (!winDialog.open) winDialog.showModal();
  }

  function share() {
    if (!lastResult) return;
    var text = C.shareText({
      date: puzzleDate,
      seconds: lastResult.seconds,
      moves: lastResult.moves,
      hints: lastResult.hints,
      url: location.origin + location.pathname,
    });
    var toast = function (msg) { $('toast').textContent = msg; };
    var viaClipboard = function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { toast('Copied to clipboard'); });
      }
      window.prompt('Copy your result:', text);
      return Promise.resolve();
    };
    if (navigator.share) {
      navigator.share({ text: text }).catch(function (err) {
        if (!err || err.name !== 'AbortError') viaClipboard().catch(function () { toast('Could not copy'); });
      });
    } else {
      viaClipboard().catch(function () { toast('Could not copy'); });
    }
  }

  // ------------------------------------------------------------------ setup/flow
  function resetPositions() {
    states = pieces.map(function (p, i) {
      return { placed: false, dragging: false, g0: null, r: initial[i].r, f: initial[i].f, pivot: [0, 0], slot: [0, 0] };
    });
    zOrder = pieces.map(function (p) { return p.id; });
    selected = -1;
    moves = 0;
    hints = 0;
    hintId = -1;
    outlineAlpha = 1;
    clock = { running: false, base: 0, since: 0 };
    if (timerId) clearInterval(timerId);
    timerId = 0;
  }

  function restart() {
    if (!pieces.length) return;
    if (won) { // restarting a solved puzzle is a practice run; today's saved result stays as it is
      won = false;
      practice = true;
      $('puzzle-date').textContent += ' · practice';
    }
    resetPositions();
    layout();
    updateHud();
  }

  function newPuzzle() {
    var landscape = img.naturalWidth / img.naturalHeight >= 1.1;
    cols = landscape ? 6 : 5;
    rows = landscape ? 5 : 6;
    var seedKey = params.get('seed') || puzzleDate;
    var rng = C.mulberry32(C.hashString('pentomino-daily:' + seedKey + ':' + cols + 'x' + rows));
    pieces = C.generateTiling(cols, rows, rng).map(function (t, i) { return C.buildPiece(t, i); });
    trayOrder = C.shuffle(pieces.map(function (p) { return p.id; }), rng);
    initial = pieces.map(function () { return { r: Math.floor(rng() * 4), f: rng() < 0.5 }; });
    resetPositions();
  }

  function showSolvedBoard(result) {
    won = true;
    outlineAlpha = 0;
    hints = result.hints || 0;
    moves = result.moves || 0;
    clock = { running: false, base: Math.max(0, result.seconds - hints * C.HINT_PENALTY_SECONDS), since: 0 };
    pieces.forEach(function (p, i) {
      var st = states[i];
      st.placed = true;
      st.r = 0;
      st.f = false;
      st.g0 = p.home[0].slice();
      st.pivot = C.pivotForGrid(p, 0, false, st.g0);
    });
    lastResult = result;
  }

  function loadData() {
    var urls = ['data/today.json', 'data/sample.json'];
    return urls.reduce(function (chain, url) {
      return chain.catch(function () {
        return fetch(url, { cache: 'no-cache' }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        });
      });
    }, Promise.reject(new Error('start')));
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('The picture failed to load')); };
      im.src = src;
    });
  }

  function localDate() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function init() {
    layout();
    new ResizeObserver(function () { layout(); }).observe(stage);

    loadData()
      .then(function (d) {
        data = d;
        puzzleDate = d.date || localDate();
        return loadImage(d.image);
      })
      .then(function (im) {
        img = im;
        newPuzzle();
        statusEl.hidden = true;
        $('puzzle-date').textContent = (data.sample ? 'Sample puzzle · ' : '') + C.formatDateShort(puzzleDate);

        if (params.has('reset')) store.remove('pd:done:' + puzzleDate);
        var done = params.has('seed') ? null : store.get('pd:done:' + puzzleDate);
        if (done) showSolvedBoard(done);

        layout();
        updateHud();

        if (done) setTimeout(function () { showWin(done); }, 400);
        else if (!store.get('pd:seenHelp')) helpDialog.showModal();
      })
      .catch(function (err) {
        statusEl.hidden = false;
        statusEl.textContent = 'Could not load today’s puzzle. ' + (err && err.message ? err.message : '');
      });
  }

  if (params.has('debug')) {
    window.__pento = {
      get pieces() { return pieces; },
      get states() { return states; },
      get layout() { return { s: s, bx: bx, by: by, cols: cols, rows: rows, trayTop: trayTop, rho: tray.rho }; },
      get won() { return won; },
    };
  }

  init();
})();
