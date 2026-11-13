/* PintaMundo — aplicação principal
   Mapa Leaflet + camada de pixels + banco Supabase (PostgREST) */
(function () {
  'use strict';

  var P = window.PM;

  // ================= Configuração =================
  var CFG = window.PINTAMUNDO_CONFIG || {};
  var SUPA_URL = String(CFG.supabaseUrl || '').trim().replace(/\/+$/, '');
  var SUPA_KEY = String(CFG.supabaseAnonKey || '').trim();
  var CONFIGURED = /^https?:\/\//.test(SUPA_URL) &&
    !/SEU-PROJETO/i.test(SUPA_URL) &&
    SUPA_KEY.length >= 30 &&
    !/COLE_AQUI/i.test(SUPA_KEY);

  // ================= Estado =================
  var map = null;
  var pixelCanvas = null;
  var frameQueued = false;
  var pendingRender = new Set();
  var ensureTimer = null;
  var loadingCount = 0;
  var errorState = false;
  var mode = 'move';                 // 'move' | 'paint'
  var brushColor = 0xffffffff >>> 0;   // valor RGBA32 do pincel (0 = borracha)
  var brushIndex = 1;                  // índice da paleta rápida (-1 = cor personalizada)
  var painting = false;
  var lastBlock = null;
  var activePointers = new Set();
  var lruSeq = 0;
  var paintWarnAt = 0;
  var tiles = new Map();             // "tx,ty" -> tile
  var flushTimers = new Map();
  var lastPollTs = null;
  var pollStarted = false;
  var pollBusy = false;

  // Edição (desfazer/refazer, conta-gotas, grade)
  var undoStack = [];
  var redoStack = [];
  var currentStroke = null;
  var strokeStartedAt = 0;
  var pickMode = false;
  var showGrid = true;
  var importing = false;          // importação de imagem → mapa em andamento

  // Overlay de referência
  var overlay = null;            // {rgba,w,h,fw,fh,canvas,anchorX,anchorY,opacity,visible,name,src,detect,fixed}
  var overlayMove = false;
  var overlayDrag = null;        // {cell,ax,ay} durante o arraste
  var movePointers = new Map();  // pointerId → {x,y} enquanto o modo mover está ativo
  var pinchResize = null;        // {d0,fw0} durante a pinça de tamanho
  var overlayMarksOn = false;
  var marksCanvas = null;
  var progressTimer = null;

  // Busca / favoritos / studio
  var searchTimer = null;
  var searchSeq = 0;
  var favs = [];
  var studioResult = null;

  // ================= Helpers DOM =================
  function $(id) { return document.getElementById(id); }

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function clampNum(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // ---------- Célula em cor cheia (RGBA, valor 32-bit; 0 = vazia/borracha) ----------
  function cellVal(bytes, idx) {
    var o = idx << 2;
    return ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  }
  function setCellVal(bytes, idx, v) {
    var o = idx << 2;
    bytes[o] = (v >>> 24) & 255;
    bytes[o + 1] = (v >>> 16) & 255;
    bytes[o + 2] = (v >>> 8) & 255;
    bytes[o + 3] = v & 255;
  }
  function packRgba(r, g, b, a) { return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0; }
  function rgbaToHex(v) {
    function h(n) { return (n & 255).toString(16).padStart(2, '0'); }
    return '#' + h(v >>> 24) + h(v >>> 16) + h(v >>> 8);
  }
  function hexToRgba(hex) {
    var n = parseInt(String(hex).slice(1), 16);
    if (isNaN(n)) return 0;
    return ((n << 8) | 255) >>> 0;
  }
  function paletteValue(i) {
    var rgb = P.PALETTE_RGB[i];
    return rgb ? packRgba(rgb[0], rgb[1], rgb[2], 255) : 0;
  }
  function paletteIndexFor(v) {
    if (!v) return 0;
    for (var i = 1; i < P.PALETTE.length; i++) if (paletteValue(i) === v) return i;
    return -1; // cor personalizada (fora das 63 rápidas)
  }

  function toast(msg, kind) {
    var box = $('toasts');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(function () { el.remove(); }, 320);
    }, kind === 'error' ? 5200 : 3200);
  }

  function updateStatus() {
    var el = $('status');
    if (!el) return;
    if (errorState) { el.textContent = 'erro'; el.className = 'status error'; }
    else if (loadingCount > 0) { el.textContent = 'carregando…'; el.className = 'status busy'; }
    else { el.textContent = mode === 'paint' ? 'pintando' : 'pronto'; el.className = 'status'; }
  }

  function updateZoomLabel() {
    var el = $('zoomLabel');
    if (el) el.textContent = 'z' + map.getZoom();
  }

  function showHint(show) {
    var h = $('hint');
    if (h) h.classList.toggle('hidden', !show);
  }

  function copyText(text, okMsg) {
    function done() { toast(okMsg, 'ok'); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { toast('Copie manualmente: ' + text, 'error'); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else fallback();
  }

  function relTime(iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!isFinite(s) || s < 60) return 'agora';
    if (s < 3600) return 'há ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'há ' + Math.floor(s / 3600) + ' h';
    return 'há ' + Math.floor(s / 86400) + ' d';
  }

  /* RGBA (n×4) → canvas; alfa <128 vira transparente */
  function imageToRgba(data, n) {
    var out = new Uint8Array(n * 4);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      if (data[p + 3] < 128) continue;
      out[p] = data[p]; out[p + 1] = data[p + 1]; out[p + 2] = data[p + 2]; out[p + 3] = 255;
    }
    return out;
  }

  function rgbaToCanvas(rgba, w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(w, h);
    img.data.set(rgba);
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function fileToImage(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('imagem inválida')); };
        img.src = fr.result;
      };
      fr.onerror = function () { reject(new Error('não consegui ler o arquivo')); };
      fr.readAsDataURL(file);
    });
  }

  /* Redução de arte pixel: passo inteiro d×d (cada px de saída = 1 bloco puro
     d×d da origem, sem mistura) em vez de escala fracionada com borrão */
  function pixelStep(base, target) {
    return Math.max(1, Math.ceil(base / Math.max(1, target)));
  }
  function drawExact(ctx, img, d, w, h) {
    ctx.imageSmoothingEnabled = false;
    if (d > 1) ctx.drawImage(img, 0, 0, w * d, h * d, 0, 0, w, h);
    else ctx.drawImage(img, 0, 0, w, h);
  }

  /* Detecta o grid de pixels da arte: maior S inteiro ≥2 tal que W e H são
     múltiplos de S e todo bloco S×S é uniforme (tolerância 12 por canal).
     Exige ≥2 cores (imagem chapada → 1) e ≤8MP (foto enorme não analisa). */
  function detectPixelStep(img) {
    var W = img.width | 0, H = img.height | 0;
    if (W < 8 || H < 8 || W * H > 8388608) return 1;
    var data;
    try {
      var c = document.createElement('canvas');
      c.width = W; c.height = H;
      var cx = c.getContext('2d');
      cx.imageSmoothingEnabled = false;
      cx.drawImage(img, 0, 0);
      data = cx.getImageData(0, 0, W, H).data;
    } catch (e) { return 1; }
    var TOL = 12;
    var r0 = data[0], g0 = data[1], b0 = data[2], a0 = data[3];
    var two = false;
    for (var i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - r0) > TOL || Math.abs(data[i + 1] - g0) > TOL ||
          Math.abs(data[i + 2] - b0) > TOL || Math.abs(data[i + 3] - a0) > TOL) {
        two = true; break;
      }
    }
    if (!two) return 1;
    var maxS = Math.min(W, H, 256);
    for (var S = maxS; S >= 2; S--) {
      if (W % S || H % S) continue;
      var good = true;
      for (var by = 0; good && by < H; by += S) {
        for (var bx = 0; good && bx < W; bx += S) {
          var o = (by * W + bx) * 4;
          var pr = data[o], pg = data[o + 1], pb = data[o + 2], pa = data[o + 3];
          for (var y = 0; good && y < S; y++) {
            var row = ((by + y) * W + bx) * 4;
            for (var x = 0; x < S; x++) {
              var q = row + (x << 2);
              if (Math.abs(data[q] - pr) > TOL || Math.abs(data[q + 1] - pg) > TOL ||
                  Math.abs(data[q + 2] - pb) > TOL || Math.abs(data[q + 3] - pa) > TOL) {
                good = false; break;
              }
            }
          }
        }
      }
      if (good) return S;
    }
    return 1;
  }

  /* Cópia persistível da imagem (máx 640px) — PNG; se enorme, JPEG.
     step>1 grava já no tamanho da grade (para restaurar igual). */
  function downscaleDataUrl(img, maxDim, step) {
    var d = step > 1 ? step : pixelStep(Math.max(img.width, img.height), maxDim);
    var w = Math.max(1, Math.floor(img.width / d));
    var h = Math.max(1, Math.floor(img.height / d));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    drawExact(ctx, img, d, w, h);
    var url = c.toDataURL('image/png');
    if (url && url.length > 900000) url = c.toDataURL('image/jpeg', 0.82);
    return url;
  }

  // ================= Cliente Supabase (PostgREST) =================
  function rest(method, path, body, headers) {
    var h = {
      apikey: SUPA_KEY,
      Authorization: 'Bearer ' + SUPA_KEY
    };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (headers) for (var k in headers) h[k] = headers[k];
    return fetch(SUPA_URL + '/rest/v1/' + path, {
      method: method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.text().then(function (t) {
        if (!res.ok) {
          var e = new Error(res.status + ' ' + t.slice(0, 180));
          e.status = res.status;
          throw e;
        }
        return t ? JSON.parse(t) : null;
      });
    });
  }

  // ================= Tiles =================
  function keyOf(tx, ty) { return tx + ',' + ty; }

  function createTile(tx, ty) {
    var t = {
      tx: tx, ty: ty, key: keyOf(tx, ty),
      loaded: false, exists: false, v: 0,
      bytes: new Uint8Array(P.TILE_BYTES),
      img: null, empty: true,
      changes: new Map(),
      loading: null, saving: false,
      used: ++lruSeq
    };
    tiles.set(t.key, t);
    return t;
  }

  function renderTile(t) {
    var bytes = t.bytes, any = false, i;
    for (i = 3; i < P.TILE_BYTES; i += 4) {
      if (bytes[i]) { any = true; break; }
    }
    if (!any) { t.img = null; t.empty = true; return; }
    var c = t.img;
    if (!c) {
      c = document.createElement('canvas');
      c.width = P.TILE; c.height = P.TILE;
      t.img = c;
    }
    var ctx = c.getContext('2d');
    var imgData = ctx.createImageData(P.TILE, P.TILE);
    // bytes já são RGBA (alfa 0 = vazio, 255 = pintado) → cópia direta
    imgData.data.set(bytes);
    ctx.putImageData(imgData, 0, 0);
    t.empty = false;
  }

  function applyRow(t, row) {
    if (!row) { t.loaded = true; t.exists = false; t.v = 0; return Promise.resolve(); }
    if (t.loaded && t.v === row.v) return Promise.resolve();
    return P.payloadToBytes(row.d).then(function (bytes) {
      if (t.changes.size) t.changes.forEach(function (col, idx) { setCellVal(bytes, idx, col); });
      t.bytes = bytes;
      t.v = row.v;
      t.exists = true;
      t.loaded = true;
      requestFrame(t);
    });
  }

  // Busca um conjunto de tiles no servidor (tiles ausentes = vazios)
  function ensureTiles(coords) {
    var need = [], waits = [], i, c, t;
    for (i = 0; i < coords.length; i++) {
      c = coords[i];
      t = tiles.get(keyOf(c.tx, c.ty)) || createTile(c.tx, c.ty);
      if (t.loaded) continue;
      if (t.loading) { waits.push(t.loading); continue; }
      need.push(t);
    }
    if (need.length) {
      if (need.length > P.MAX_TILES_FETCH) need = need.slice(0, P.MAX_TILES_FETCH);
      var txs = [], tys = [], seenX = {}, seenY = {};
      need.forEach(function (tt) {
        if (!seenX[tt.tx]) { seenX[tt.tx] = 1; txs.push(tt.tx); }
        if (!seenY[tt.ty]) { seenY[tt.ty] = 1; tys.push(tt.ty); }
      });
      var path = 'tiles?tx=in.(' + txs.join(',') + ')&ty=in.(' + tys.join(',') +
        ')&select=tx,ty,d,v&limit=400';
      var p = rest('GET', path).then(function (rows) {
        var byKey = new Map();
        (rows || []).forEach(function (r) { byKey.set(keyOf(r.tx, r.ty), r); });
        return Promise.all(need.map(function (tt) {
          return applyRow(tt, byKey.get(tt.key)).then(function () { tt.loading = null; });
        }));
      }).catch(function (e) {
        need.forEach(function (tt) { tt.loading = null; });
        throw e;
      });
      need.forEach(function (tt) { tt.loading = p; });
      waits.push(p);
    }
    return Promise.all(waits);
  }

  async function ensureTileLoaded(tx, ty) {
    var t = tiles.get(keyOf(tx, ty)) || createTile(tx, ty);
    if (t.loaded) return t;
    try {
      await ensureTiles([{ tx: tx, ty: ty }]);
    } catch (e) {
      console.error(e);
      toast('Falha ao carregar pixels (' + e.message + ')', 'error');
      errorState = true; updateStatus();
      return null;
    }
    errorState = false;
    return tiles.get(keyOf(tx, ty)) || t;
  }

  // ================= Flush (salvar no servidor) =================
  function scheduleFlush(t, delay) {
    if (flushTimers.has(t.key)) return;
    flushTimers.set(t.key, setTimeout(function () {
      flushTimers.delete(t.key);
      flushTile(t);
    }, delay || 450));
  }

  async function flushTile(t) {
    if (t.saving || !t.changes.size || !CONFIGURED) return;
    t.saving = true;
    try {
      var attempts = 0;
      while (t.changes.size && attempts < 5) {
        attempts++;
        var snapshot = new Map(t.changes); // key → valor enviado
        var payload = await P.bytesToPayload(t.bytes);
        var ok = false;
        if (!t.exists) {
          try {
            var rows = await rest('POST', 'tiles',
              [{ tx: t.tx, ty: t.ty, d: payload, v: 1 }],
              { Prefer: 'return=representation' });
            if (rows && rows[0]) { t.v = rows[0].v; t.exists = true; ok = true; }
          } catch (e) {
            if (e.status !== 409) throw e;
            await reloadFromServer(t);
          }
        } else {
          var rows2 = await rest('PATCH',
            'tiles?tx=eq.' + t.tx + '&ty=eq.' + t.ty + '&v=eq.' + t.v,
            { d: payload, v: t.v + 1 },
            { Prefer: 'return=representation' });
          if (rows2 && rows2[0]) { t.v = rows2[0].v; ok = true; }
          else await reloadFromServer(t);
        }
        if (ok) {
          // só limpa se o valor não mudou durante o envio (ex.: traço cancelado)
          snapshot.forEach(function (v, k) { if (t.changes.get(k) === v) t.changes.delete(k); });
        }
      }
      if (t.changes.size) scheduleFlush(t, 1500);
      errorState = false;
      updateStatus();
      if (overlay) scheduleProgress();
    } catch (e) {
      console.error(e);
      errorState = true;
      updateStatus();
      toast('Não consegui salvar: ' + e.message, 'error');
      if (flushTimers.has(t.key)) { clearTimeout(flushTimers.get(t.key)); flushTimers.delete(t.key); }
      scheduleFlush(t, 6000);
    } finally {
      t.saving = false;
      if (t.changes.size && !flushTimers.has(t.key)) scheduleFlush(t, 2000);
    }
  }

  async function reloadFromServer(t) {
    var rows = await rest('GET',
      'tiles?tx=eq.' + t.tx + '&ty=eq.' + t.ty + '&select=tx,ty,d,v&limit=1');
    var row = rows && rows[0];
    if (row) {
      var bytes = await P.payloadToBytes(row.d);
      t.changes.forEach(function (col, idx) { setCellVal(bytes, idx, col); });
      t.bytes = bytes;
      t.v = row.v;
      t.exists = true;
      t.loaded = true;
      requestFrame(t);
    } else {
      t.exists = false;
      t.v = 0;
      t.loaded = true;
    }
  }

  // ================= Visão / projeção =================
  function screenOrigin() {
    return map.latLngToContainerPoint(L.latLng(P.MAX_LAT, -180));
  }

  function computeView() {
    var size = map.getSize();
    var z = map.getZoom();
    var cellSize = Math.pow(2, z - P.CANVAS_ZOOM);
    var o = screenOrigin();
    var ox = Math.round(o.x), oy = Math.round(o.y);
    var x0 = Math.max(0, Math.floor(-ox / cellSize));
    var y0 = Math.max(0, Math.floor(-oy / cellSize));
    var x1 = Math.min(P.WORLD - 1, Math.ceil((size.x - ox) / cellSize));
    var y1 = Math.min(P.WORLD - 1, Math.ceil((size.y - oy) / cellSize));
    if (x1 < x0 || y1 < y0) {
      return {
        size: size, cellSize: cellSize, ox: ox, oy: oy,
        x0: 0, y0: 0, x1: -1, y1: -1,
        tx0: 0, tx1: -1, ty0: 0, ty1: -1, tiles: []
      };
    }
    var tx0 = Math.floor(x0 / P.TILE), tx1 = Math.floor(x1 / P.TILE);
    var ty0 = Math.floor(y0 / P.TILE), ty1 = Math.floor(y1 / P.TILE);
    var list = [];
    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) list.push({ tx: tx, ty: ty });
    }
    return {
      size: size, cellSize: cellSize, ox: ox, oy: oy,
      x0: x0, y0: y0, x1: x1, y1: y1,
      tx0: tx0, tx1: tx1, ty0: ty0, ty1: ty1,
      tiles: list
    };
  }

  // ================= Render =================
  function requestFrame(tile) {
    if (tile) pendingRender.add(tile);
    scheduleRedraw();
  }

  function scheduleRedraw() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(function () {
      frameQueued = false;
      pendingRender.forEach(function (t) { renderTile(t); });
      pendingRender.clear();
      redraw();
    });
  }

  function redraw() {
    if (!map || !pixelCanvas) return;
    var v = computeView();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(v.size.x * dpr));
    var h = Math.max(1, Math.round(v.size.y * dpr));
    if (pixelCanvas.width !== w || pixelCanvas.height !== h) {
      pixelCanvas.width = w;
      pixelCanvas.height = h;
      pixelCanvas.style.width = v.size.x + 'px';
      pixelCanvas.style.height = v.size.y + 'px';
    }
    var ctx = pixelCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.size.x, v.size.y);

    var z = map.getZoom();
    showHint(z < P.MIN_RENDER_ZOOM);
    if (z < P.MIN_RENDER_ZOOM || v.x1 < v.x0) { updateZoomLabel(); return; }

    // nitidez quando célula >= 1px; suavização quando reduz (zoom baixo)
    ctx.imageSmoothingEnabled = v.cellSize < 1;
    ctx.imageSmoothingQuality = 'low';

    var step = P.TILE * v.cellSize;
    for (var i = 0; i < v.tiles.length; i++) {
      var c = v.tiles[i];
      var t = tiles.get(keyOf(c.tx, c.ty));
      if (!t) continue;
      t.used = ++lruSeq;
      if (!t.img) continue;
      var dx = v.ox + c.tx * step;
      var dy = v.oy + c.ty * step;
      ctx.drawImage(t.img, dx, dy, step, step);
    }

    // overlay de referência + marcas de pixels faltantes
    if (overlay && overlay.visible) {
      var ox2 = v.ox + overlay.anchorX * v.cellSize;
      var oy2 = v.oy + overlay.anchorY * v.cellSize;
      var ow = overlay.fw * v.cellSize;
      var oh = overlay.fh * v.cellSize;
      ctx.save();
      ctx.globalAlpha = overlay.opacity;
      ctx.imageSmoothingEnabled = v.cellSize < 1;
      ctx.drawImage(overlay.canvas, ox2, oy2, ow, oh);
      ctx.restore();
      if (overlayMarksOn && marksCanvas && marksCanvas._fw === overlay.fw) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(marksCanvas, ox2, oy2, ow, oh);
        ctx.restore();
      }
    }

    drawGrid(ctx, v);
    updateZoomLabel();
  }

  // ================= Busca de tiles visíveis =================
  function scheduleEnsure() {
    if (!CONFIGURED) return;
    clearTimeout(ensureTimer);
    ensureTimer = setTimeout(ensureVisible, 150);
  }

  async function ensureVisible() {
    if (!CONFIGURED) return;
    if (map.getZoom() < P.MIN_RENDER_ZOOM) return;
    var v = computeView();
    if (v.tiles.length === 0 || v.tiles.length > P.MAX_TILES_FETCH) return;
    var missing = v.tiles.filter(function (c) {
      var t = tiles.get(keyOf(c.tx, c.ty));
      return !t || !t.loaded;
    });
    if (!missing.length) { evict(); return; }
    loadingCount++;
    updateStatus();
    try {
      await ensureTiles(missing);
      errorState = false;
      evict();
      scheduleRedraw();
      if (overlay) scheduleProgress();
    } catch (e) {
      console.error(e);
      errorState = true;
      toast('Falha ao carregar pixels (' + e.message + ')', 'error');
    } finally {
      loadingCount--;
      updateStatus();
    }
  }

  function evict() {
    if (tiles.size <= 96) return;
    var visible = new Set(computeView().tiles.map(function (c) { return keyOf(c.tx, c.ty); }));
    var list = [];
    tiles.forEach(function (t) {
      if (!t.loaded || t.changes.size || t.saving || visible.has(t.key)) return;
      list.push(t);
    });
    list.sort(function (a, b) { return a.used - b.used; });
    var excess = tiles.size - 96;
    for (var i = 0; i < list.length && excess > 0; i++, excess--) {
      tiles.delete(list[i].key);
    }
  }

  // ================= Polling (atualizações dos outros) =================
  async function initPolling() {
    if (!CONFIGURED || pollStarted) return;
    pollStarted = true;
    try {
      var rows = await rest('GET', 'tiles?select=updated_at&order=updated_at.desc&limit=1');
      lastPollTs = rows && rows[0] ? rows[0].updated_at : '1970-01-01T00:00:00+00:00';
    } catch (e) {
      console.warn('poll init:', e);
      lastPollTs = '1970-01-01T00:00:00+00:00';
    }
    setInterval(pollVisible, 8000);
  }

  async function pollVisible() {
    if (!CONFIGURED || document.hidden || pollBusy) return;
    if (map.getZoom() < P.MIN_RENDER_ZOOM) return;
    if (!lastPollTs) lastPollTs = '1970-01-01T00:00:00+00:00';
    pollBusy = true;
    try {
      var v = computeView();
      if (v.tiles.length === 0 || v.tiles.length > P.MAX_TILES_FETCH) return;
      var txs = [], tys = [], seenX = {}, seenY = {};
      v.tiles.forEach(function (c) {
        if (!seenX[c.tx]) { seenX[c.tx] = 1; txs.push(c.tx); }
        if (!seenY[c.ty]) { seenY[c.ty] = 1; tys.push(c.ty); }
      });
      var path = 'tiles?tx=in.(' + txs.join(',') + ')&ty=in.(' + tys.join(',') +
        ')&updated_at=gt.' + encodeURIComponent(lastPollTs) +
        '&select=tx,ty,d,v,updated_at&limit=300';
      var rows = await rest('GET', path);
      if (!rows || !rows.length) return;
      var maxTs = lastPollTs;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var t = tiles.get(keyOf(r.tx, r.ty)) || createTile(r.tx, r.ty);
        if (!t.loaded || r.v !== t.v) await applyRow(t, r);
        if (r.updated_at > maxTs) maxTs = r.updated_at;
      }
      lastPollTs = maxTs;
      evict();
      scheduleRedraw();
      if (overlay) scheduleProgress();
    } catch (e) { /* silencioso: tenta de novo em 8s */ }
    finally { pollBusy = false; }
  }

  // ================= Pintura =================
  function cellFromEvent(e) {
    var rect = map.getContainer().getBoundingClientRect();
    var v = computeView();
    var px = e.clientX - rect.left;
    var py = e.clientY - rect.top;
    var cx = Math.floor((px - v.ox) / v.cellSize);
    var cy = Math.floor((py - v.oy) / v.cellSize);
    if (cx < 0 || cy < 0 || cx >= P.WORLD || cy >= P.WORLD) return null;
    return [cx, cy];
  }

  function warnZoomPaint() {
    var now = Date.now();
    if (now - paintWarnAt > 4500) {
      paintWarnAt = now;
      toast('Aproxime mais: zoom ≥ ' + P.MIN_PAINT_ZOOM + ' para pintar', 'error');
    }
  }

  /* Escreve um valor RGBA32 na célula (com registro no traço/undo) */
  function applyCell(t, idx, val) {
    var old = cellVal(t.bytes, idx);
    if (old === val) return false;
    var had = t.changes.has(idx);
    var prev = t.changes.get(idx);
    setCellVal(t.bytes, idx, val);
    t.changes.set(idx, val);
    if (currentStroke) {
      currentStroke.push({ t: t, idx: idx, old: old, neu: val, had: had, prev: prev });
    }
    t.empty = false;
    t.used = ++lruSeq;
    requestFrame(t);
    scheduleFlush(t);
    return true;
  }

  function applyByte(t, idx) {
    return applyCell(t, idx, brushColor);
  }

  function overlayActive() { return !!(overlay && overlay.visible); }

  // Célula do mapa → pixel da imagem (grade relativa à âncora; fora da arte continua exato)
  function blockOf(cx, cy) {
    if (!overlayActive()) return [cx, cy];
    return [
      Math.floor((cx - overlay.anchorX) * overlay.w / overlay.fw),
      Math.floor((cy - overlay.anchorY) * overlay.h / overlay.fh)
    ];
  }

  // Pixel da imagem → retângulo de células [x0,x1,y0,y1] (inverso exato de blockOf)
  function blockCells(bx, by) {
    if (!overlayActive()) return [bx, bx, by, by];
    var ax = overlay.anchorX, ay = overlay.anchorY;
    return [
      ax + Math.ceil(bx * overlay.fw / overlay.w),
      ax + Math.ceil((bx + 1) * overlay.fw / overlay.w) - 1,
      ay + Math.ceil(by * overlay.fh / overlay.h),
      ay + Math.ceil((by + 1) * overlay.fh / overlay.h) - 1
    ];
  }

  // Pinta um bloco inteiro (1 clique = 1 quadrado da imagem)
  function paintBlockAt(bx, by) {
    if (map.getZoom() < P.MIN_PAINT_ZOOM) { warnZoomPaint(); return Promise.resolve(); }
    var r = blockCells(bx, by);
    var groups = new Map();
    for (var y = r[2]; y <= r[3]; y++) {
      if (y < 0 || y >= P.WORLD) continue;
      for (var x = r[0]; x <= r[1]; x++) {
        if (x < 0 || x >= P.WORLD) continue;
        var tx = Math.floor(x / P.TILE), ty = Math.floor(y / P.TILE);
        var key = keyOf(tx, ty);
        var g = groups.get(key);
        if (!g) { g = { tx: tx, ty: ty, idxs: [] }; groups.set(key, g); }
        g.idxs.push((y - ty * P.TILE) * P.TILE + (x - tx * P.TILE));
      }
    }
    var jobs = [];
    groups.forEach(function (g) {
      jobs.push(ensureTileLoaded(g.tx, g.ty).then(function (t) {
        if (!t) return;
        for (var i = 0; i < g.idxs.length; i++) applyByte(t, g.idxs[i]);
      }));
    });
    return Promise.all(jobs);
  }

  // ================= Desfazer / refazer =================
  function startStroke() {
    if (!currentStroke) {
      currentStroke = [];
      strokeStartedAt = Date.now();
    }
  }

  function endStroke() {
    if (currentStroke && currentStroke.length) {
      undoStack.push(currentStroke);
      if (undoStack.length > 60) undoStack.shift();
      redoStack.length = 0;
      updateUndoButtons();
      if (overlay) scheduleProgress();
    }
    currentStroke = null;
  }

  // Desfaz um traço que ainda não foi enviado (como se nunca tivesse pintado)
  function cancelStrokeEntries(stroke) {
    for (var i = stroke.length - 1; i >= 0; i--) {
      var c = stroke[i];
      if (cellVal(c.t.bytes, c.idx) !== c.neu) continue;
      setCellVal(c.t.bytes, c.idx, c.old);
      if (c.t.changes.has(c.idx) && c.t.changes.get(c.idx) === c.neu) {
        // pendência ainda é nossa: restaura o estado anterior ao traço
        if (c.had) c.t.changes.set(c.idx, c.prev);
        else c.t.changes.delete(c.idx);
      } else {
        // valor já foi enviado ao servidor: manda a reversão
        c.t.changes.set(c.idx, c.old);
      }
      c.t.used = ++lruSeq;
      requestFrame(c.t);
      scheduleFlush(c.t);
    }
  }

  // Pinça/zoom/gesto do navegador interrompe a pintura:
  // traço recém-iniciado é desfeito (zoom não pode pintar);
  // traço antigo é apenas finalizado (não perde o que já foi pintado).
  function interruptStroke() {
    if (importing) return; // a importação não é interrompida por zoom/gesto
    if (currentStroke && currentStroke.length) {
      if (Date.now() - strokeStartedAt < 400) cancelStrokeEntries(currentStroke);
      else endStroke();
    }
    currentStroke = null;
    painting = false;
    lastBlock = null;
  }

  function applyStroke(stroke, useOld) {
    for (var i = stroke.length - 1; i >= 0; i--) {
      var c = stroke[i];
      var val = useOld ? c.old : c.neu;
      if (cellVal(c.t.bytes, c.idx) === val) continue;
      setCellVal(c.t.bytes, c.idx, val);
      c.t.changes.set(c.idx, val);
      c.t.empty = false;
      requestFrame(c.t);
      scheduleFlush(c.t);
    }
    if (overlay) scheduleProgress();
  }

  function undo() {
    var s = undoStack.pop();
    if (!s) { toast('Nada para desfazer', 'error'); return; }
    applyStroke(s, true);
    redoStack.push(s);
    updateUndoButtons();
  }

  function redo() {
    var s = redoStack.pop();
    if (!s) { toast('Nada para refazer', 'error'); return; }
    applyStroke(s, false);
    undoStack.push(s);
    updateUndoButtons();
  }

  function updateUndoButtons() {
    var u = $('btnUndo'), r = $('btnRedo');
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
  }

  // ================= Conta-gotas =================
  function togglePick() {
    pickMode = !pickMode;
    var b = $('btnPick');
    if (b) b.classList.toggle('active', pickMode);
    toast(pickMode ? 'Conta-gotas: toque/clique no mapa (ou na imagem) para pegar a cor' : 'Conta-gotas desligada', 'ok');
  }

  async function pickAt(cx, cy) {
    // primeiro: cor da imagem do overlay (se o clique estiver dentro dela)
    if (overlay && overlay.visible) {
      var ox = Math.floor((cx - overlay.anchorX) * overlay.w / overlay.fw);
      var oy = Math.floor((cy - overlay.anchorY) * overlay.h / overlay.fh);
      if (ox >= 0 && oy >= 0 && ox < overlay.w && oy < overlay.h) {
        var target = cellVal(overlay.rgba, oy * overlay.w + ox);
        if (target) {
          selectColorValue(target);
          toast('Cor da imagem: ' + rgbaToHex(target) + ' (qualquer cor do mundo)', 'ok');
          return;
        }
      }
    }
    var tx = Math.floor(cx / P.TILE), ty = Math.floor(cy / P.TILE);
    var t = await ensureTileLoaded(tx, ty);
    if (!t) return;
    var idx = (cy - ty * P.TILE) * P.TILE + (cx - tx * P.TILE);
    var c = cellVal(t.bytes, idx);
    selectColorValue(c);
    toast(c ? 'Cor escolhida: ' + rgbaToHex(c) : 'Borracha escolhida', 'ok');
  }

  // ================= Grade de pixels =================
  function toggleGrid() {
    showGrid = !showGrid;
    store('pm_grid', showGrid ? '1' : '0');
    var b = $('btnGrid');
    if (b) b.classList.toggle('active', showGrid);
    scheduleRedraw();
  }

  function drawGrid(ctx, v) {
    if (!showGrid || v.cellSize < 6) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    var x, y, sx, sy;
    for (x = v.x0; x <= v.x1; x++) {
      sx = Math.round(v.ox + x * v.cellSize) + 0.5;
      if (sx < 0 || sx > v.size.x) continue;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, v.size.y);
    }
    for (y = v.y0; y <= v.y1; y++) {
      sy = Math.round(v.oy + y * v.cellSize) + 0.5;
      if (sy < 0 || sy > v.size.y) continue;
      ctx.moveTo(0, sy);
      ctx.lineTo(v.size.x, sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  function updateCoordsFromEvent(e) {
    var el = $('coords');
    if (!el) return;
    var cell = cellFromEvent(e);
    if (!cell) { el.textContent = '—'; return; }
    var ll = P.cellToLatLng(cell[0], cell[1]);
    el.textContent = cell[0] + ', ' + cell[1] + ' · ' +
      ll[0].toFixed(3) + ', ' + ll[1].toFixed(3);
    return cell;
  }

  // ================= Pinça de tamanho (modo mover) =================
  function pointerDist() {
    var pts = [];
    movePointers.forEach(function (p) { pts.push(p); });
    if (pts.length < 2) return 0;
    return Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
  }

  function startPinch() {
    var d0 = pointerDist();
    if (!d0 || !overlay) return;
    overlayDrag = null; // deixa de arrastar: agora redimensiona
    pinchResize = { d0: d0, fw0: overlay.fw };
  }

  function doPinchResize() {
    if (!pinchResize || !overlay) return;
    var d = pointerDist();
    if (!d) return;
    setOverlayFootprint(Math.round(pinchResize.fw0 * d / pinchResize.d0));
  }

  function finishPinch() {
    pinchResize = null;
    if (!overlay) return;
    saveOverlay();
    updateOverlayPanel();
    scheduleProgress();
    toast('Tamanho: ' + overlay.fw + '×' + overlay.fh + ' · bloco ' + overlayBlockLabel(), 'ok');
  }

  // Rodapé da imagem no mapa: fw células de largura (min = resolução, max = 4096)
  function setOverlayFootprint(fw) {
    if (!overlay) return;
    fw = Math.round(clampNum(fw, overlay.w, 4096));
    var fh = Math.round(fw * overlay.h / overlay.w);
    if (fh > 4096) {
      fw = Math.max(overlay.w, Math.floor(4096 * overlay.w / overlay.h));
      fh = Math.round(fw * overlay.h / overlay.w);
    }
    overlay.fw = fw;
    overlay.fh = fh;
    scheduleRedraw();
    scheduleProgress();
  }

  function overlayBlockLabel() {
    if (!overlay) return '';
    var K = Math.max(1, Math.round(overlay.fw / overlay.w));
    return K + '×' + K;
  }

  function endMovePointer(e) {
    activePointers.delete(e.pointerId);
    movePointers.delete(e.pointerId);
    if (pinchResize && movePointers.size < 2) finishPinch();
    if (overlayDrag && !activePointers.size) {
      overlayDrag = null;
      saveOverlay();
      scheduleProgress();
    }
    if (!activePointers.size) overlayDrag = null;
  }

  function onPointerDown(e) {
    if (e.target && e.target.closest && e.target.closest('.leaflet-control-container')) return;
    var cell;
    if (e.altKey || pickMode) {
      cell = cellFromEvent(e);
      if (cell) {
        pickAt(cell[0], cell[1]).catch(function () {});
        if (pickMode) togglePick();
      }
      if (e.cancelable) e.preventDefault();
      return;
    }
    if (overlayMove && overlay) {
      activePointers.add(e.pointerId);
      movePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cell = cellFromEvent(e);
      if (activePointers.size === 1 && cell) {
        overlayDrag = { cell: cell, ax: overlay.anchorX, ay: overlay.anchorY };
      } else if (activePointers.size >= 2 && !pinchResize) {
        startPinch(); // 2º dedo: a pinça muda o tamanho da imagem
      }
      if (e.cancelable) e.preventDefault();
      return;
    }
    if (mode !== 'paint') return;
    activePointers.add(e.pointerId);
    if (activePointers.size > 1) { interruptStroke(); return; } // 2º dedo = pinça/zoom
    startStroke();
    painting = true;
    cell = cellFromEvent(e);
    if (cell) {
      lastBlock = blockOf(cell[0], cell[1]);
      paintBlockAt(lastBlock[0], lastBlock[1]).catch(function () {});
    }
    if (e.cancelable) e.preventDefault();
  }

  function onPointerMove(e) {
    if (overlayMove && activePointers.has(e.pointerId)) {
      if (movePointers.has(e.pointerId)) movePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinchResize) {
        doPinchResize();
        if (e.cancelable) e.preventDefault();
        return;
      }
      if (overlayDrag) {
        var oc = cellFromEvent(e);
        if (oc && overlay) {
          var rawX = overlayDrag.ax + (oc[0] - overlayDrag.cell[0]);
          var rawY = overlayDrag.ay + (oc[1] - overlayDrag.cell[1]);
          overlay.anchorX = clampNum(alignAnchor(rawX, overlay.fw / overlay.w), -overlay.fw + 1, P.WORLD - 1);
          overlay.anchorY = clampNum(alignAnchor(rawY, overlay.fh / overlay.h), -overlay.fh + 1, P.WORLD - 1);
          scheduleRedraw();
        }
        if (e.cancelable) e.preventDefault();
        return;
      }
      if (e.cancelable) e.preventDefault();
      return;
    }
    if (activePointers.has(e.pointerId)) {
      if (painting && mode === 'paint' && activePointers.size === 1) {
        var cell = cellFromEvent(e);
        if (cell) {
          var b = blockOf(cell[0], cell[1]);
          if (!lastBlock) {
            lastBlock = b;
            paintBlockAt(b[0], b[1]).catch(function () {});
          } else if (b[0] !== lastBlock[0] || b[1] !== lastBlock[1]) {
            var dist = Math.abs(b[0] - lastBlock[0]) + Math.abs(b[1] - lastBlock[1]);
            if (dist <= 400) {
              P.lineCells(lastBlock[0], lastBlock[1], b[0], b[1], function (x, y) {
                paintBlockAt(x, y).catch(function () {});
              });
            } else {
              paintBlockAt(b[0], b[1]).catch(function () {});
            }
            lastBlock = b;
          }
        }
        if (e.cancelable) e.preventDefault();
      }
      return;
    }
    updateCoordsFromEvent(e);
  }

  function onPointerUp(e) {
    if (overlayMove && activePointers.has(e.pointerId)) { endMovePointer(e); return; }
    activePointers.delete(e.pointerId);
    movePointers.delete(e.pointerId);
    if (!activePointers.size) {
      if (painting) endStroke();
      painting = false;
      lastBlock = null;
    }
  }

  // O navegador/leaflet assumiu o gesto (zoom, rolagem): cancela a pintura
  function onPointerCancel(e) {
    if (activePointers.has(e.pointerId) && (overlayMove || overlayDrag || pinchResize)) {
      endMovePointer(e);
      return;
    }
    activePointers.delete(e.pointerId);
    movePointers.delete(e.pointerId);
    if (painting || currentStroke) interruptStroke();
    if (!activePointers.size) {
      painting = false;
      lastBlock = null;
    }
  }

  // ================= Modo / cores / UI =================
  function updateMapInteraction() {
    var cont = map.getContainer();
    var capture = mode === 'paint' || overlayMove;
    if (capture) {
      map.dragging.disable();
      map.doubleClickZoom.disable();
      cont.style.touchAction = 'none';
    } else {
      map.dragging.enable();
      map.doubleClickZoom.enable();
      cont.style.touchAction = '';
    }
    // no modo mover, a pinça redimensiona a imagem (o zoom do mapa fica off;
    // no modo pincel o touchZoom continua ligado — só cancela o traço)
    if (map.touchZoom) {
      if (overlayMove) map.touchZoom.disable();
      else map.touchZoom.enable();
    }
    if (!overlayMove) {
      overlayDrag = null;
      pinchResize = null;
      movePointers.clear();
    }
    cont.classList.toggle('paint-mode', mode === 'paint' && !overlayMove);
    cont.classList.toggle('overlay-move', overlayMove);
  }

  function setMode(m) {
    mode = m;
    $('modeMove').classList.toggle('active', m === 'move');
    $('modePaint').classList.toggle('active', m === 'paint');
    updateMapInteraction();
    if (m === 'paint') {
      if (map.getZoom() < P.MIN_PAINT_ZOOM) {
        toast('Modo pincel: aproxime o mapa (zoom ≥ ' + P.MIN_PAINT_ZOOM + ') para pintar');
      }
    } else {
      painting = false;
      lastBlock = null;
      if (!overlayMove) endStroke();
    }
    store('pm_mode', m);
    updateStatus();
  }

  function applyBrush(v, idx) {
    brushColor = v >>> 0;
    brushIndex = idx;
    store('pm_color', String(brushColor));
    Array.prototype.forEach.call(document.querySelectorAll('.swatch'), function (s) {
      s.classList.toggle('active', Number(s.dataset.i) === idx);
    });
    var er = $('btnEraser');
    if (er) er.classList.toggle('active', idx === 0);
    var cp = $('colorPick');
    if (cp && brushColor) cp.value = rgbaToHex(brushColor);
  }

  function selectColor(i) {
    applyBrush(i ? paletteValue(i) : 0, i);
    if (mode !== 'paint') setMode('paint');
  }

  /* Qualquer cor do mundo (color picker ou conta-gotas) */
  function selectColorValue(v) {
    v = v >>> 0;
    applyBrush(v, paletteIndexFor(v));
    if (mode !== 'paint') setMode('paint');
  }

  function buildPalette() {
    var el = $('palette');
    P.PALETTE.forEach(function (hex, i) {
      if (i === 0) return;
      var b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = hex;
      b.dataset.i = i;
      b.title = hex + ' · tecla ' + (i <= 9 ? i : '');
      b.addEventListener('click', function () { selectColor(i); });
      el.appendChild(b);
    });
  }

  function restorePrefs() {
    var raw = load('pm_color');
    if (raw != null && raw !== '') {
      var v = Number(raw);
      if (!isNaN(v)) {
        // valor < 64 = índice antigo da paleta; maior = cor RGBA cheia
        if (v < P.PALETTE.length) applyBrush(v ? paletteValue(v) : 0, v);
        else applyBrush(v, paletteIndexFor(v));
      }
    }
    if (load('pm_mode') === 'paint') mode = 'paint';
  }

  // ================= Ações =================
  async function recentTiles(limit) {
    return rest('GET', 'tiles?select=tx,ty&order=updated_at.desc&limit=' + limit);
  }

  async function goRandom() {
    if (!CONFIGURED) { openModal('setupModal'); return; }
    try {
      var rows = await recentTiles(40);
      if (!rows || !rows.length) {
        toast('Ninguém pintou ainda — seja o primeiro!', 'ok');
        map.flyTo([-14.235, -51.925], 5, { duration: 1.2 });
        return;
      }
      var r = rows[Math.floor(Math.random() * rows.length)];
      var ll = P.cellToLatLng(r.tx * P.TILE + P.TILE / 2, r.ty * P.TILE + P.TILE / 2);
      map.flyTo([ll[0], ll[1]], 16, { duration: 1.4 });
      toast('🎲 Levando você a um lugar pintado…', 'ok');
    } catch (e) {
      toast('Falha: ' + e.message, 'error');
    }
  }

  function exportPng() {
    if (map.getZoom() < P.MIN_RENDER_ZOOM) { toast('Aproxime o mapa para exportar', 'error'); return; }
    var v = computeView();
    var w = v.x1 - v.x0 + 1, h = v.y1 - v.y0 + 1;
    if (w <= 0 || h <= 0 || w > 8000 || h > 8000) { toast('Área inválida', 'error'); return; }
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    var cellSize = v.cellSize;
    for (var ty = v.ty0; ty <= v.ty1; ty++) {
      for (var tx = v.tx0; tx <= v.tx1; tx++) {
        var t = tiles.get(keyOf(tx, ty));
        if (!t || !t.img) continue;
        var dx = Math.round(tx * P.TILE * cellSize - v.x0 * cellSize);
        var dy = Math.round(ty * P.TILE * cellSize - v.y0 * cellSize);
        var ds = Math.round(P.TILE * cellSize);
        ctx.drawImage(t.img, dx, dy, ds, ds);
      }
    }
    c.toBlob(function (blob) {
      if (!blob) { toast('Falha ao gerar PNG', 'error'); return; }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pintamundo-' + Date.now() + '.png';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 8000);
      toast('PNG da área visível baixado ✓', 'ok');
    }, 'image/png');
  }

  // ================= Modais =================
  function openModal(id) { var m = $(id); if (m) m.classList.remove('hidden'); }
  function closeModal(id) {
    var m = $(id);
    if (!m) return;
    if (id === 'setupModal' && !CONFIGURED) return; // obrigatório até configurar
    m.classList.add('hidden');
  }
  function anyModalOpen() { return !!document.querySelector('.modal:not(.hidden)'); }
  function closeModals() {
    Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (m) {
      if (m.id === 'setupModal' && !CONFIGURED) return;
      m.classList.add('hidden');
    });
  }

  function copySql() {
    var sql = $('sql-setup').textContent;
    function done() { toast('SQL copiado! Cole no Supabase SQL Editor ✓', 'ok'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(sql).then(done).catch(fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = sql;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copie manualmente o SQL abaixo', 'error'); }
      ta.remove();
    }
  }

  // ================= Busca de lugar (Nominatim + coordenadas) =================
  function hideSearchResults() {
    var el = $('searchResults');
    if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
  }

  function showSearchResults(html) {
    var el = $('searchResults');
    if (el) { el.innerHTML = html; el.classList.remove('hidden'); }
  }

  function parseQuery(q) {
    var m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return null;
    var a = Number(m[1]), b = Number(m[2]);
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
    if (Number.isInteger(a) && Number.isInteger(b) &&
        a >= 0 && b >= 0 && a < P.WORLD && b < P.WORLD) {
      return { cell: [a, b] };
    }
    return null;
  }

  function flyToQuery(coords) {
    if (coords.cell) {
      var ll = P.cellToLatLng(coords.cell[0], coords.cell[1]);
      map.flyTo([ll[0], ll[1]], 16, { duration: 1 });
      toast('Levando ao pixel ' + coords.cell[0] + ', ' + coords.cell[1], 'ok');
    } else {
      map.flyTo([coords.lat, coords.lng], 14, { duration: 1 });
    }
  }

  function goToSearchResult(r) {
    if (r.boundingbox && r.boundingbox.length === 4) {
      var bb = r.boundingbox.map(Number);
      if (isFinite(bb[0]) && isFinite(bb[1]) && isFinite(bb[2]) && isFinite(bb[3])) {
        map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 16 });
        return;
      }
    }
    if (r.lat != null && r.lon != null) map.flyTo([Number(r.lat), Number(r.lon)], 14, { duration: 1 });
  }

  function renderSearchResults(rows) {
    if (!rows || !rows.length) {
      showSearchResults('<div class="empty">Nada encontrado. Tente "Rio de Janeiro" ou "-23.5, -46.6".</div>');
      return;
    }
    var html = '';
    rows.forEach(function (r, i) {
      var parts = String(r.display_name || '').split(',').map(function (s) { return s.trim(); });
      var name = parts[0] || 'Lugar';
      var sub = parts.slice(1, 4).join(', ');
      html += '<button type="button" data-i="' + i + '">' + escapeHtml(name) +
        (sub ? '<span class="sub">' + escapeHtml(sub) + '</span>' : '') + '</button>';
    });
    showSearchResults(html);
    Array.prototype.forEach.call($('searchResults').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        var r = rows[Number(b.dataset.i)];
        if (!r) return;
        goToSearchResult(r);
        $('searchInput').value = (String(r.display_name || '').split(',')[0] || '').trim();
        hideSearchResults();
      });
    });
  }

  async function doSearch(q) {
    if (!q) return;
    var coords = parseQuery(q);
    if (coords) { flyToQuery(coords); hideSearchResults(); return; }
    var seq = ++searchSeq;
    try {
      var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=' +
        encodeURIComponent('pt-BR') + '&q=' + encodeURIComponent(q);
      var res = await fetch(url);
      if (seq !== searchSeq) return;
      var rows = await res.json();
      if (seq !== searchSeq) return;
      renderSearchResults(rows);
    } catch (e) {
      if (seq === searchSeq) {
        showSearchResults('<div class="empty">Falha na busca: ' + escapeHtml(e.message) + '</div>');
      }
    }
  }

  function goMyLocation() {
    if (!navigator.geolocation) { toast('Geolocalização não suportada neste navegador', 'error'); return; }
    toast('📍 Procurando sua localização…', 'ok');
    navigator.geolocation.getCurrentPosition(function (pos) {
      map.flyTo([pos.coords.latitude, pos.coords.longitude], 14, { duration: 1.2 });
      toast('📍 Sua localização', 'ok');
    }, function (err) {
      toast('Não consegui acessar sua localização: ' + (err && err.message || 'erro'), 'error');
    }, { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 });
  }

  function wireSearch() {
    var input = $('searchInput');
    if (!input) return;
    input.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var q = input.value.trim();
      if (q.length < 2) { hideSearchResults(); return; }
      searchTimer = setTimeout(function () { doSearch(q); }, 320);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        clearTimeout(searchTimer);
        doSearch(input.value.trim());
        e.preventDefault();
      } else if (e.key === 'Escape') {
        hideSearchResults();
        input.blur();
      }
      e.stopPropagation();
    });
    input.addEventListener('blur', function () { setTimeout(hideSearchResults, 180); });
    document.addEventListener('click', function (e) {
      var sb = document.querySelector('.searchbar');
      if (sb && !sb.contains(e.target)) hideSearchResults();
    });
    $('btnMyLocation').addEventListener('click', goMyLocation);
  }

  // ================= Favoritos =================
  function loadFavs() {
    try {
      favs = JSON.parse(load('pm_favs') || '[]');
      if (!Array.isArray(favs)) favs = [];
    } catch (e) { favs = []; }
  }

  function saveFavs() { store('pm_favs', JSON.stringify(favs)); }

  function shareUrlFor(lat, lng, z) {
    return location.origin + location.pathname + '#' +
      Number(lat).toFixed(5) + ',' + Number(lng).toFixed(5) + ',' + Math.round(z);
  }

  function renderFavs() {
    var ul = $('favList');
    if (!ul) return;
    if (!favs.length) {
      ul.innerHTML = '<li class="fine">Nenhum favorito ainda.</li>';
      return;
    }
    ul.innerHTML = '';
    favs.forEach(function (f, i) {
      var li = document.createElement('li');
      var grow = document.createElement('span');
      grow.className = 'grow';
      grow.innerHTML = '<span class="name">' + escapeHtml(f.name) + '</span>' +
        '<span class="sub">' + Number(f.lat).toFixed(4) + ', ' + Number(f.lng).toFixed(4) +
        ' · z' + f.z + '</span>';
      var go = document.createElement('button');
      go.className = 'btn small';
      go.textContent = 'Ir';
      go.addEventListener('click', function () {
        map.flyTo([f.lat, f.lng], f.z, { duration: 1.1 });
        closeModal('favModal');
      });
      var link = document.createElement('button');
      link.className = 'btn small';
      link.textContent = '🔗';
      link.title = 'Copiar link deste favorito';
      link.addEventListener('click', function () {
        copyText(shareUrlFor(f.lat, f.lng, f.z), 'Link do favorito copiado ✓');
      });
      var del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = '✕';
      del.title = 'Remover';
      del.addEventListener('click', function () {
        favs.splice(i, 1);
        saveFavs();
        renderFavs();
      });
      li.appendChild(grow);
      li.appendChild(go);
      li.appendChild(link);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  function addFav() {
    var input = $('favName');
    var name = (input && input.value.trim()) || 'Sem nome';
    var c = map.getCenter();
    favs.push({ name: name, lat: Number(c.lat.toFixed(5)), lng: Number(c.lng.toFixed(5)), z: map.getZoom() });
    if (favs.length > 100) favs.shift();
    saveFavs();
    renderFavs();
    if (input) input.value = '';
    toast('⭐ "' + name + '" salvo nos favoritos', 'ok');
  }

  function shareLink() {
    var c = map.getCenter();
    copyText(shareUrlFor(c.lat, c.lng, map.getZoom()), 'Link desta posição copiado ✓');
  }

  function applyHash() {
    var h = (location.hash || '').slice(1);
    var m = h.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d{1,2})$/);
    if (!m) return false;
    var lat = Number(m[1]), lng = Number(m[2]), z = Number(m[3]);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || z < 2 || z > 18) return false;
    map.setView([lat, lng], z);
    return true;
  }

  // Resolve com null se a promessa não terminar no tempo dado
  function withTimeout(p, ms) {
    var t;
    return Promise.race([
      p,
      new Promise(function (r) { t = setTimeout(function () { r(null); }, ms); })
    ]).then(function (v) { clearTimeout(t); return v; });
  }

  // Ao abrir (sem link de posição): encaixa "de cima" onde tem desenho —
  // união dos tiles pintados recentes + a overlay, entre os zooms 12 e 13
  async function autoFitOverview(overlayReady) {
    if (!CONFIGURED) return;
    try {
      var rows = await withTimeout(recentTiles(40).catch(function () { return null; }), 1500);
      await withTimeout(overlayReady || Promise.resolve(), 1500);
      var boxes = [];
      if (rows && rows.length) {
        var pb = P.tilesBox(rows);
        if (pb) boxes.push(pb);
      }
      if (overlay && overlay.visible) {
        boxes.push({
          x0: overlay.anchorX, y0: overlay.anchorY,
          x1: overlay.anchorX + overlay.fw - 1,
          y1: overlay.anchorY + overlay.fh - 1
        });
      }
      if (!boxes.length) return;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (b.x0 < x0) x0 = b.x0;
        if (b.y0 < y0) y0 = b.y0;
        if (b.x1 > x1) x1 = b.x1;
        if (b.y1 > y1) y1 = b.y1;
      }
      x0 = Math.max(0, x0); y0 = Math.max(0, y0);
      x1 = Math.min(P.WORLD - 1, x1); y1 = Math.min(P.WORLD - 1, y1);
      if (x1 < x0 || y1 < y0) return;
      var ll = P.cellToLatLng(Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2));
      var size = map.getSize();
      var z = P.fitZoom(x1 - x0 + 1, y1 - y0 + 1, size.x, size.y);
      map.flyTo([ll[0], ll[1]], z, { duration: 1.1 });
    } catch (e) { /* visão geral é extra: falha não pode quebrar a abertura */ }
  }

  // ================= Contagem de tiles =================
  async function refreshTileCount() {
    if (!CONFIGURED) return;
    try {
      var res = await fetch(SUPA_URL + '/rest/v1/tiles?select=tx&limit=1', {
        headers: {
          apikey: SUPA_KEY,
          Authorization: 'Bearer ' + SUPA_KEY,
          Prefer: 'count=exact'
        }
      });
      if (!res || !res.headers || !res.headers.get) return;
      var cr = res.headers.get('content-range');
      if (cr && cr.indexOf('/') !== -1) {
        var n = Number(cr.split('/')[1]);
        if (isFinite(n)) {
          var el = $('tileCount');
          if (el) el.innerHTML = '<span class="sep">·</span> ' + n.toLocaleString('pt-BR') + ' tiles';
        }
      }
    } catch (e) { /* silencioso */ }
  }

  // ================= Atividade recente =================
  async function loadActivity() {
    var ul = $('activityList');
    if (!ul) return;
    ul.innerHTML = '<li class="fine">Carregando…</li>';
    if (!CONFIGURED) { ul.innerHTML = '<li class="fine">Configure o Supabase primeiro.</li>'; return; }
    try {
      var rows = await rest('GET', 'tiles?select=tx,ty,updated_at&order=updated_at.desc&limit=15');
      if (!rows || !rows.length) {
        ul.innerHTML = '<li class="fine">Nada pintado ainda — seja o primeiro!</li>';
        return;
      }
      ul.innerHTML = '';
      rows.forEach(function (r) {
        var li = document.createElement('li');
        var grow = document.createElement('span');
        grow.className = 'grow';
        grow.innerHTML = '<span class="name">tile ' + r.tx + ', ' + r.ty + '</span>' +
          '<span class="sub">atualizado ' + relTime(r.updated_at) + '</span>';
        var go = document.createElement('button');
        go.className = 'btn small';
        go.textContent = 'Ir';
        go.addEventListener('click', function () {
          var ll = P.cellToLatLng(r.tx * P.TILE + P.TILE / 2, r.ty * P.TILE + P.TILE / 2);
          map.flyTo([ll[0], ll[1]], 16, { duration: 1.2 });
          closeModal('activityModal');
        });
        li.appendChild(grow);
        li.appendChild(go);
        ul.appendChild(li);
      });
    } catch (e) {
      ul.innerHTML = '<li class="fine">Falha: ' + escapeHtml(e.message) + '</li>';
    }
  }

  // ================= Overlay de referência =================
  function updateOverlayOpacityLabel() {
    var el = $('overlayOpacityVal');
    if (el) el.textContent = ($('overlayOpacity').value || '60') + '%';
  }

  function updateOverlayPanel() {
    var has = !!overlay;
    ['overlayAnchor', 'overlayMove', 'overlayVisible', 'overlayRemove', 'overlaySize', 'overlayImport'].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = !has || (importing && id === 'overlayImport');
    });
    var vb = $('overlayVisible');
    if (vb) vb.textContent = has && !overlay.visible ? '👁️ mostrar' : '👁️ ocultar';
    var mb = $('overlayMove');
    if (mb) mb.classList.toggle('active', overlayMove);
    var sl = $('overlaySize'), lv = $('overlaySizeVal');
    if (sl && lv) {
      if (has) {
        var maxK = Math.max(1, Math.floor(4096 / overlay.w));
        sl.max = String(maxK);
        var K = Math.max(1, Math.round(overlay.fw / overlay.w));
        sl.value = String(Math.min(maxK, Math.max(1, K)));
        lv.textContent = overlay.fw + '×' + overlay.fh + ' · bloco ' + K + '×' + K;
      } else {
        lv.textContent = '—';
      }
    }
    if (!has && $('overlayStats')) $('overlayStats').textContent = '—';
  }

  // Tamanho do quadrado: 1 px da arte ≈ 1 célula quando a arte tem ~TILE px
  function blockFor(res) {
    return Math.max(1, Math.round(P.TILE / Math.max(1, res)));
  }
  // Alinha a âncora à grade quando o rodapé é múltiplo inteiro da imagem;
  // com tamanho fracionário (pinça) a âncora só precisa ser inteira.
  function alignAnchor(v, s) {
    if (Number.isInteger(s) && s > 1) return Math.floor(v / s) * s;
    return Math.round(v);
  }
  function centerAnchor(center, fw, dim) {
    var s = fw / dim;
    var a = Math.round(center - fw / 2);
    if (Number.isInteger(s) && s > 1) a = Math.floor(a / s) * s;
    return Math.max(0, a);
  }

  /* opts.fixed  → grade já é a da arte (não reamostra, não detecta)
     opts.plain  → só passo inteiro, sem detecção (restore antigo)
     padrão      → detecta o grid de pixels e usa o passo exato */
  function buildOverlay(img, maxDim, name, opts) {
    opts = opts || {};
    var S = opts.fixed || opts.plain ? 0 : detectPixelStep(img);
    var d = opts.fixed ? 1 : (S > 1 ? S : pixelStep(Math.max(img.width, img.height), maxDim));
    var w = Math.max(1, Math.floor(img.width / d));
    var h = Math.max(1, Math.floor(img.height / d));
    var K = blockFor(maxDim);
    // rodapé no mapa nunca passa de 4096 células por lado
    var maxW = Math.max(1, Math.floor(4096 / K));
    if (w > maxW || h > maxW) {
      d *= Math.ceil(Math.max(w, h) / maxW);
      w = Math.max(1, Math.floor(img.width / d));
      h = Math.max(1, Math.floor(img.height / d));
      while (w > maxW || h > maxW) {
        d++;
        w = Math.max(1, Math.floor(img.width / d));
        h = Math.max(1, Math.floor(img.height / d));
      }
    }
    var fw = w * K, fh = h * K;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    drawExact(ctx, img, d, w, h);
    var data = ctx.getImageData(0, 0, w, h).data;
    var rgba = imageToRgba(data, w * h); // cor cheia: todas as cores preservadas
    var v = computeView();
    var cx = Math.floor((v.x0 + v.x1) / 2);
    var cy = Math.floor((v.y0 + v.y1) / 2);
    overlay = {
      rgba: rgba, w: w, h: h, fw: fw, fh: fh,
      canvas: rgbaToCanvas(rgba, w, h),
      anchorX: centerAnchor(cx, fw, w),
      anchorY: centerAnchor(cy, fh, h),
      opacity: Number($('overlayOpacity').value) / 100,
      visible: true,
      name: name || 'imagem',
      detect: S > 1 ? S : 0,
      fixed: !!(opts.fixed || S > 1),
      src: null
    };
    marksCanvas = null;
    return overlay;
  }

  function saveOverlay() {
    if (!overlay || !overlay.src) return;
    store('pm_overlay', JSON.stringify({
      src: overlay.src,
      ax: overlay.anchorX, ay: overlay.anchorY,
      op: overlay.opacity, vis: overlay.visible,
      fw: overlay.fw, iw: overlay.w,
      fx: overlay.fixed ? 1 : 0,
      res: Number($('overlayRes').value) || 160
    }));
  }

  function removeOverlay() {
    overlay = null;
    overlayMove = false;
    overlayDrag = null;
    pinchResize = null;
    movePointers.clear();
    marksCanvas = null;
    try { localStorage.removeItem('pm_overlay'); } catch (e) {}
    updateOverlayPanel();
    updateMapInteraction();
    scheduleRedraw();
    toast('Overlay removida', 'ok');
  }

  async function onOverlayFile(file) {
    if (!file) return;
    try {
      var img = await fileToImage(file);
      var res = Number($('overlayRes').value) || 160;
      buildOverlay(img, res, file.name);
      overlay.src = downscaleDataUrl(img, 640, overlay.detect || 1);
      updateOverlayPanel();
      saveOverlay();
      scheduleRedraw();
      scheduleProgress();
      if (overlay.detect > 1) {
        toast('🎨 Pixels da imagem: ' + overlay.detect + '×' + overlay.detect +
          ' — grade de ' + overlay.w + '×' + overlay.h +
          ': 1 clique = 1 quadrado da arte (bloco ' + overlayBlockLabel() + ')', 'ok');
      } else {
        toast('🖼️ Overlay: ' + overlay.w + '×' + overlay.h + ' px — cada clique pinta um quadrado ' +
          overlayBlockLabel() + ' dela', 'ok');
      }
    } catch (e) {
      toast('Falha no overlay: ' + e.message, 'error');
    }
  }

  function reprocessOverlay() {
    if (!overlay || !overlay.src) return;
    var keep = {
      ax: overlay.anchorX, ay: overlay.anchorY,
      op: overlay.opacity, vis: overlay.visible,
      src: overlay.src, name: overlay.name,
      fixed: !!overlay.fixed
    };
    var img = new Image();
    img.onload = function () {
      if (!overlay) return;
      buildOverlay(img, Number($('overlayRes').value) || 160, keep.name,
        keep.fixed ? { fixed: true } : { plain: true });
      overlay.anchorX = alignAnchor(keep.ax, overlay.fw / overlay.w);
      overlay.anchorY = alignAnchor(keep.ay, overlay.fh / overlay.h);
      overlay.opacity = keep.op;
      overlay.visible = keep.vis;
      overlay.src = keep.src;
      updateOverlayPanel();
      saveOverlay();
      scheduleRedraw();
      scheduleProgress();
    };
    img.src = keep.src;
  }

  // ===== Importar a imagem para o mapa: pinta cada pixel exato no mundo =====
  function importOverlayToMap() {
    if (!overlay || importing) return;
    var ov = overlay;
    var cells = ov.fw * ov.fh;
    if (cells > 200000) {
      var go = window.confirm('Importar cerca de ' + cells.toLocaleString('pt-BR') +
        ' células no mapa? Pode demorar um pouco (dá para desfazer com Ctrl+Z).');
      if (!go) return;
    }
    importing = true;
    var btn = $('overlayImport');
    if (btn) { btn.disabled = true; }
    toast('📥 Importando os pixels da imagem no mapa…', 'ok');
    startStroke();

    var w = ov.w, h = ov.h, bx = 0, by = 0, painted = 0, transparent = 0;

    // fase 1: carrega todos os tiles do rodapé de uma vez
    var coords = [];
    var tx0 = Math.floor(ov.anchorX / P.TILE), ty0 = Math.floor(ov.anchorY / P.TILE);
    var tx1 = Math.floor((ov.anchorX + ov.fw - 1) / P.TILE);
    var ty1 = Math.floor((ov.anchorY + ov.fh - 1) / P.TILE);
    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) {
        if (tx < 0 || ty < 0 || tx >= P.NTILES || ty >= P.NTILES) continue;
        coords.push({ tx: tx, ty: ty });
      }
    }
    ensureTiles(coords).catch(function () {}).then(function () {
      // fase 2: pinta em fatias de tempo (não trava a interface)
      function step() {
        if (!overlay || overlay !== ov) return finish(true); // overlay sumiu no meio
        var t0 = Date.now();
        while (by < h && Date.now() - t0 < 12) {
          var val = cellVal(ov.rgba, by * w + bx);
          if (val) {
            var x0 = ov.anchorX + Math.ceil(bx * ov.fw / ov.w);
            var x1 = ov.anchorX + Math.ceil((bx + 1) * ov.fw / ov.w) - 1;
            var y0 = ov.anchorY + Math.ceil(by * ov.fh / ov.h);
            var y1 = ov.anchorY + Math.ceil((by + 1) * ov.fh / ov.h) - 1;
            for (var y = y0; y <= y1; y++) {
              if (y < 0 || y >= P.WORLD) continue;
              for (var x = x0; x <= x1; x++) {
                if (x < 0 || x >= P.WORLD) continue;
                var t = tiles.get(keyOf(Math.floor(x / P.TILE), Math.floor(y / P.TILE)));
                if (!t || !t.loaded) continue;
                if (applyCell(t, (y % P.TILE) * P.TILE + (x % P.TILE), val)) painted++;
              }
            }
          } else transparent++;
          bx++;
          if (bx >= w) { bx = 0; by++; }
        }
        if (btn) btn.textContent = '⏳ ' + Math.min(100, Math.round((by * w + bx) * 100 / (w * h))) + '%';
        if (by < h) setTimeout(step, 0);
        else finish(false);
      }
      function finish(aborted) {
        importing = false;
        endStroke();
        if (btn) { btn.disabled = false; btn.textContent = '📥 importar no mapa'; }
        if (aborted) toast('Importação interrompida', 'error');
        else toast('✅ ' + painted + ' células pintadas no mapa' +
          (transparent ? ' · ' + transparent + ' pixels transparentes pulados' : ''), 'ok');
        scheduleProgress();
        scheduleRedraw();
      }
      step();
    });
  }

  function computeOverlayProgress() {
    if (!overlay) return null;
    var w = overlay.w, h = overlay.h;
    var fw = overlay.fw, fh = overlay.fh; // extensão no mapa (em células)
    // marcas em resolução limitada (até 1024 de largura) para imagens gigantes;
    // contagens usam peso por região → total exato = fw*fh
    var mw = Math.min(1024, fw);
    var mh = Math.max(1, Math.round(fh * mw / fw));
    if (!marksCanvas) marksCanvas = document.createElement('canvas');
    if (marksCanvas.width !== mw || marksCanvas.height !== mh) {
      marksCanvas.width = mw;
      marksCanvas.height = mh;
    }
    marksCanvas._fw = fw;
    var mctx = marksCanvas.getContext('2d');
    var id = mctx.createImageData(mw, mh);
    var md = id.data;
    var done = 0, total = 0, missing = 0, wrong = 0;
    for (var my = 0; my < mh; my++) {
      var fy0 = Math.floor(my * fh / mh);
      var fy1 = Math.floor((my + 1) * fh / mh);
      for (var mx = 0; mx < mw; mx++) {
        var p = (my * mw + mx) << 2;
        var fx0 = Math.floor(mx * fw / mw);
        var fx1 = Math.floor((mx + 1) * fw / mw);
        var weight = (fx1 - fx0) * (fy1 - fy0);
        if (weight <= 0) { md[p + 3] = 0; continue; }
        var ox = Math.floor(fx0 * w / fw);
        var oy = Math.floor(fy0 * h / fh);
        var target = cellVal(overlay.rgba, oy * w + ox);
        if (!target) { md[p + 3] = 0; continue; }
        var cx = overlay.anchorX + fx0;
        var cy = overlay.anchorY + fy0;
        var t = null;
        if (cx >= 0 && cy >= 0 && cx < P.WORLD && cy < P.WORLD) {
          t = tiles.get(keyOf(Math.floor(cx / P.TILE), Math.floor(cy / P.TILE)));
        }
        var cur = (t && t.loaded) ? cellVal(t.bytes, (cy % P.TILE) * P.TILE + (cx % P.TILE)) : 0;
        total += weight;
        if (cur === target) {
          done += weight;
          md[p + 3] = 0;
        } else if (cur === 0) {
          missing += weight;
          md[p] = 150; md[p + 1] = 150; md[p + 2] = 150; md[p + 3] = 220;
        } else {
          wrong += weight;
          md[p] = 255; md[p + 1] = 60; md[p + 2] = 60; md[p + 3] = 220;
        }
      }
    }
    mctx.putImageData(id, 0, 0);
    return { done: done, total: total, missing: missing, wrong: wrong };
  }

  function scheduleProgress() {
    if (!overlay) return;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(runProgress, 700);
  }

  function runProgress() {
    if (!overlay) return;
    var panelOpen = !$('overlayPanel').classList.contains('hidden');
    var wantStats = panelOpen || overlayMarksOn ||
      ($('overlayProgress') && $('overlayProgress').checked);
    if (!wantStats) return;
    var res = computeOverlayProgress();
    if (!res) return;
    var el = $('overlayStats');
    if (el) {
      var pct = res.total ? Math.round(res.done * 1000 / res.total) / 10 : 0;
      el.textContent = res.done + ' / ' + res.total + ' pixels (' + pct + '%) · ' +
        res.missing + ' faltando · ' + res.wrong + ' com cor errada' +
        ' · bloco ' + overlayBlockLabel();
    }
    scheduleRedraw();
  }

  function toggleOverlayPanel() {
    var p = $('overlayPanel');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) {
      updateOverlayPanel();
      updateOverlayOpacityLabel();
      if (overlay) scheduleProgress();
    }
  }

  function restoreOverlay() {
    return new Promise(function (resolve) {
      var raw = load('pm_overlay');
      if (!raw) return resolve();
      try {
        var d = JSON.parse(raw);
        if (!d.src) return resolve();
        if (d.res) $('overlayRes').value = String(d.res);
        if (d.op != null) $('overlayOpacity').value = String(Math.round(Number(d.op) * 100));
        updateOverlayOpacityLabel();
        var img = new Image();
        img.onload = function () {
          buildOverlay(img, Number($('overlayRes').value) || 160, 'overlay salva',
            d.fx ? { fixed: true } : { plain: true });
          if (!overlay) return resolve();
          overlay.src = d.src;
          // fw salvo só vale se a largura da arte não mudou (senão o passo
          // inteiro novo já reposicionou fw = w×K)
          var sameW = d.iw == null || Number(d.iw) === overlay.w;
          if (sameW && d.fw && Number(d.fw) >= overlay.w) setOverlayFootprint(Number(d.fw));
          overlay.anchorX = alignAnchor(Number(d.ax) || 0, overlay.fw / overlay.w);
          overlay.anchorY = alignAnchor(Number(d.ay) || 0, overlay.fh / overlay.h);
          overlay.opacity = d.op != null ? Number(d.op) : 0.6;
          overlay.visible = d.vis !== false;
          updateOverlayPanel();
          scheduleRedraw();
          scheduleProgress();
          resolve();
        };
        img.onerror = function () { resolve(); };
        img.src = d.src;
      } catch (e) { resolve(); /* dados corrompidos: ignora */ }
    });
  }

  function wireOverlay() {
    updateOverlayOpacityLabel();
    $('btnOverlay').addEventListener('click', toggleOverlayPanel);
    $('overlayFile').addEventListener('change', function (e) {
      onOverlayFile(e.target.files && e.target.files[0]);
    });
    $('overlayRes').addEventListener('change', reprocessOverlay);
    $('overlaySize').addEventListener('input', function () {
      if (!overlay) return;
      setOverlayFootprint(overlay.w * Number($('overlaySize').value));
      updateOverlayPanel();
    });
    $('overlaySize').addEventListener('change', saveOverlay);
    $('overlayOpacity').addEventListener('input', function () {
      updateOverlayOpacityLabel();
      if (overlay) {
        overlay.opacity = Number($('overlayOpacity').value) / 100;
        scheduleRedraw();
      }
    });
    $('overlayOpacity').addEventListener('change', saveOverlay);
    $('overlayAnchor').addEventListener('click', function () {
      if (!overlay) return;
      var v = computeView();
      overlay.anchorX = centerAnchor(Math.floor((v.x0 + v.x1) / 2), overlay.fw, overlay.w);
      overlay.anchorY = centerAnchor(Math.floor((v.y0 + v.y1) / 2), overlay.fh, overlay.h);
      saveOverlay();
      scheduleRedraw();
      scheduleProgress();
      toast('Overlay ancorada no centro da tela', 'ok');
    });
    $('overlayMove').addEventListener('click', function () {
      if (!overlay) return;
      overlayMove = !overlayMove;
      updateMapInteraction();
      updateOverlayPanel();
      toast(overlayMove ? 'Mover overlay: arraste no mapa' : 'Modo mover desligado', 'ok');
    });
    $('overlayVisible').addEventListener('click', function () {
      if (!overlay) return;
      overlay.visible = !overlay.visible;
      saveOverlay();
      updateOverlayPanel();
      scheduleRedraw();
    });
    $('overlayRemove').addEventListener('click', removeOverlay);
    $('overlayImport').addEventListener('click', importOverlayToMap);
    // arrastar e soltar uma imagem no painel carrega como overlay
    var op = $('overlayPanel');
    op.addEventListener('dragover', function (e) { if (e.preventDefault) e.preventDefault(); });
    op.addEventListener('drop', function (e) {
      if (e.preventDefault) e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onOverlayFile(f);
    });
    $('overlayProgress').addEventListener('change', function () {
      if (overlay) scheduleProgress();
    });
    $('overlayMarks').addEventListener('change', function (e) {
      overlayMarksOn = e.target.checked;
      if (overlay && overlayMarksOn) scheduleProgress();
      scheduleRedraw();
    });
  }

  // ================= Pixel-art Studio =================
  async function processStudio() {
    var input = $('studioFile');
    var file = input && input.files && input.files[0];
    if (!file) return;
    try {
      var img = await fileToImage(file);
      var targetW = Number($('studioWidth').value) || 64;
      var d = pixelStep(img.width, targetW);
      var w = Math.max(1, Math.floor(img.width / d));
      var h = Math.max(1, Math.floor(img.height / d));
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var ctx = c.getContext('2d');
      drawExact(ctx, img, d, w, h);
      var data = ctx.getImageData(0, 0, w, h).data;
      // cor cheia: nenhuma cor da imagem é perdida (sem quantizar na paleta)
      var rgba = imageToRgba(data, w * h);
      studioResult = { rgba: rgba, w: w, h: h, canvas: rgbaToCanvas(rgba, w, h) };
      var pv = $('studioPreview');
      pv.width = w;
      pv.height = h;
      pv.getContext('2d').drawImage(studioResult.canvas, 0, 0);
      pv.style.width = Math.min(w * 4, 460) + 'px';
      pv.style.height = 'auto';
      var empty = $('studioEmpty');
      if (empty) empty.classList.add('hidden');
      $('studioToOverlay').disabled = false;
      $('studioDownload').disabled = false;
      toast('Studio: ' + w + '×' + h + ' px — todas as cores da imagem preservadas ✓', 'ok');
    } catch (e) {
      toast('Falha no studio: ' + e.message, 'error');
    }
  }

  function studioToOverlay() {
    if (!studioResult) return;
    var v = computeView();
    var K = blockFor(studioResult.w);
    var fw = studioResult.w * K, fh = studioResult.h * K;
    var scx = Math.floor((v.x0 + v.x1) / 2);
    var scy = Math.floor((v.y0 + v.y1) / 2);
    overlay = {
      rgba: studioResult.rgba,
      w: studioResult.w,
      h: studioResult.h,
      fw: fw,
      fh: fh,
      canvas: studioResult.canvas,
      anchorX: centerAnchor(scx, fw, studioResult.w),
      anchorY: centerAnchor(scy, fh, studioResult.h),
      opacity: Number($('overlayOpacity').value) / 100,
      visible: true,
      name: 'studio',
      detect: 0,
      fixed: true,
      src: studioResult.canvas.toDataURL('image/png')
    };
    marksCanvas = null;
    closeModal('studioModal');
    $('overlayPanel').classList.remove('hidden');
    updateOverlayPanel();
    saveOverlay();
    scheduleRedraw();
    scheduleProgress();
    toast('Pixel art usada como overlay — pinte por cima! 🎨', 'ok');
  }

  function studioDownload() {
    if (!studioResult) return;
    studioResult.canvas.toBlob(function (blob) {
      if (!blob) { toast('Falha ao gerar PNG', 'error'); return; }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pixel-art-' + studioResult.w + 'x' + studioResult.h + '.png';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 8000);
      toast('Pixel art baixada ✓', 'ok');
    }, 'image/png');
  }

  function wireStudio() {
    $('studioFile').addEventListener('change', processStudio);
    $('studioWidth').addEventListener('change', processStudio);
    $('studioToOverlay').addEventListener('click', studioToOverlay);
    $('studioDownload').addEventListener('click', studioDownload);
  }

  function wireExtras() {
    wireSearch();
    wireOverlay();
    wireStudio();

    $('btnFav').addEventListener('click', function () {
      renderFavs();
      openModal('favModal');
    });
    $('favSave').addEventListener('click', addFav);
    $('favName').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { addFav(); e.stopPropagation(); }
    });

    $('btnActivity').addEventListener('click', function () {
      openModal('activityModal');
      loadActivity();
    });
    $('activityRefresh').addEventListener('click', loadActivity);

    $('btnShare').addEventListener('click', shareLink);
    $('btnStudio').addEventListener('click', function () { openModal('studioModal'); });

    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    $('btnPick').addEventListener('click', togglePick);
    $('btnGrid').addEventListener('click', toggleGrid);
  }

  // ================= Mapa =================
  function initMap() {
    map = L.map('map', {
      center: [-14.235, -51.925],
      zoom: 4,
      minZoom: 2,
      maxZoom: 18,
      zoomSnap: 1,
      zoomDelta: 1,
      zoomAnimation: false,
      fadeAnimation: true,
      zoomControl: false,
      worldCopyJump: false
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

    pixelCanvas = document.createElement('canvas');
    pixelCanvas.id = 'pixelCanvas';
    map.getContainer().appendChild(pixelCanvas);

    map.on('move', scheduleRedraw);
    map.on('moveend', function () { scheduleRedraw(); scheduleEnsure(); });
    map.on('zoomend', function () { scheduleRedraw(); scheduleEnsure(); updateZoomLabel(); });
    map.on('zoomstart', function () { if (painting || currentStroke) interruptStroke(); });
    map.on('resize', function () { scheduleRedraw(); scheduleEnsure(); });
    map.on('mouseout', function () { var el = $('coords'); if (el) el.textContent = '—'; });
  }

  function wireEvents() {
    var cont = map.getContainer();
    cont.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);

    $('modeMove').addEventListener('click', function () { setMode('move'); });
    $('modePaint').addEventListener('click', function () { setMode('paint'); });
    $('btnEraser').addEventListener('click', function () { selectColor(0); });
    $('colorPick').addEventListener('input', function (e) {
      selectColorValue(hexToRgba(e.target.value));
    });
    $('btnZoomIn').addEventListener('click', function () { map.zoomIn(); });
    $('btnZoomOut').addEventListener('click', function () { map.zoomOut(); });
    $('btnRandom').addEventListener('click', goRandom);
    $('btnExport').addEventListener('click', exportPng);
    $('btnHelp').addEventListener('click', function () { openModal('helpModal'); });
    $('btnCopySql').addEventListener('click', copySql);
    $('btnReload').addEventListener('click', function () { location.reload(); });

    wireExtras();

    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
      b.addEventListener('click', function () {
        var m = b.closest ? b.closest('.modal') : null;
        if (m) closeModal(m.id);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (m) {
      m.addEventListener('click', function (e) {
        if (e.target === m) closeModal(m.id);
      });
    });

    window.addEventListener('keydown', function (e) {
      if (e.target && e.target.matches && e.target.matches('input,textarea,select')) return;
      if (e.key === 'Escape') { closeModals(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (anyModalOpen()) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); openModal('helpModal'); return; }
      var k = e.key.toLowerCase();
      if (k === 'b') setMode('paint');
      else if (k === 'm') setMode('move');
      else if (k === 'e') selectColor(0);
      else if (k === 'r') goRandom();
      else if (k === 'g') toggleGrid();
      else if (k === 'o') toggleOverlayPanel();
      else if (k === 's') openModal('studioModal');
      else if (k === 'f') { renderFavs(); openModal('favModal'); }
      else if (e.key === '+' || e.key === '=') map.zoomIn();
      else if (e.key === '-' || e.key === '_') map.zoomOut();
      else if (e.key >= '1' && e.key <= '9') selectColor(Number(e.key));
    });

    window.addEventListener('resize', function () {
      if (map) map.invalidateSize({ animate: false });
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { scheduleEnsure(); pollVisible(); }
    });
  }

  // ================= Init =================
  function init() {
    if (typeof L === 'undefined') {
      document.body.innerHTML = '<p style="color:#fff;font-family:sans-serif;padding:40px">' +
        'Não foi possível carregar o Leaflet (CDN bloqueado). Verifique sua conexão.</p>';
      return;
    }
    buildPalette();
    restorePrefs();
    showGrid = load('pm_grid') !== '0';
    loadFavs();
    initMap();
    wireEvents();

    Array.prototype.forEach.call(document.querySelectorAll('.swatch'), function (s) {
      s.classList.toggle('active', Number(s.dataset.i) === brushIndex);
    });
    $('btnEraser').classList.toggle('active', brushIndex === 0);
    $('btnGrid').classList.toggle('active', showGrid);
    setMode(mode);

    var hashApplied = applyHash();

    if (CONFIGURED) {
      ensureVisible();
      initPolling();
      refreshTileCount();
      setInterval(refreshTileCount, 60000);
    } else {
      $('sqlPreview').textContent = $('sql-setup').textContent;
      openModal('setupModal');
      toast('Configure o Supabase para o canvas funcionar', 'error');
    }
    var overlayReady = restoreOverlay();
    // sem link de posição: abre já encaixando o desenho (+ overlay) "de cima"
    if (!hashApplied) autoFitOverview(overlayReady);
    var hintEl = $('hint');
    if (hintEl) {
      hintEl.textContent = '🔍 Aproxime mais (zoom ≥ ' + P.MIN_RENDER_ZOOM +
        ') para ver os pixels · zoom ≥ ' + P.MIN_PAINT_ZOOM + ' para pintar';
    }
    updateStatus();
    updateZoomLabel();
    scheduleRedraw();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
