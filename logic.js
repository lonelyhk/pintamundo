/* PintaMundo — lógica pura (sem DOM)
   Geometria do canvas, paleta de cores e codificação dos tiles. */
(function (root) {
  'use strict';

  // ---------- Constantes do canvas ----------
  var CANVAS_ZOOM = 13;                              // zoom em que 1 célula = 1px
  var WORLD = 256 * Math.pow(2, CANVAS_ZOOM);        // 2.097.152 células por lado (~4 trilhões de pixels)
  var TILE = 256;                                    // células por lado de um tile
  var NTILES = WORLD / TILE;                         // 8192 tiles por lado
  var CELL_BYTES = 4;                                // RGBA por célula (cor cheia)
  var TILE_BYTES = TILE * TILE * CELL_BYTES;         // 262.144 bytes por tile
  var PALETTE_TILE_BYTES = TILE * TILE;              // formato antigo: 1 índice por célula
  var MAX_LAT = 85.0511287798066;                    // limite da projeção Mercator
  var MIN_RENDER_ZOOM = 12;                          // abaixo disso não desenha pixels
  var MIN_PAINT_ZOOM = 14;                           // abaixo disso não pinta
  var MAX_TILES_FETCH = 520;                         // teto de tiles por consulta

  // ---------- Paleta: 63 cores (índice 0 = vazio/borracha) ----------
  var PALETTE = [
    null,
    // neutros
    '#ffffff', '#f2f2f2', '#d4d4d4', '#a8a8a8', '#7a7a7a', '#4a4a4a', '#000000',
    // marrons / bege
    '#3b1f0b', '#5c3317', '#7a4a21', '#96652f', '#b5824b', '#d2a76c',
    // laranjas
    '#8a3b00', '#b45300', '#e06c00', '#f59b00', '#ffc04d',
    // amarelos
    '#f7e000', '#ffd93d', '#e0c200', '#b8a300', '#8f7f00',
    // verdes claros
    '#d7f0a0', '#a8e060', '#6bcb77', '#3fbf4f', '#1e8c3a',
    // verdes escuros
    '#14662d', '#0d4d22', '#0a3d1c', '#2d6b2f', '#4f8f3a',
    // cianos / água
    '#a0f0e0', '#5fd8c8', '#2bbfae', '#14908f', '#0d6b73',
    // azuis claros
    '#a8e0ff', '#6bc0ff', '#3d9bff', '#4d96ff', '#2f6fe0',
    // azuis escuros
    '#1d4ed8', '#1a3a8f', '#142c6b', '#0f1f4a', '#24406e',
    // roxos
    '#b06ae0', '#8b4fd6', '#6b35c4', '#4d2394', '#351a66',
    // rosas / magenta
    '#ff8ad0', '#ff5fb0', '#e83d96', '#c41e7a', '#8f1457',
    // vermelhos
    '#ff6b6b', '#f03b3b', '#d21f1f', '#a01414', '#6e0d0d'
  ];

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  var PALETTE_RGB = PALETTE.map(function (h) { return h ? hexToRgb(h) : [0, 0, 0]; });

  // ---------- Geometria (Web Mercator, mesmo cálculo do Leaflet) ----------
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function latLngToCell(lat, lng) {
    lat = clamp(lat, -MAX_LAT, MAX_LAT);
    var x = Math.floor(WORLD * (lng + 180) / 360);
    var sin = Math.sin(lat * Math.PI / 180);
    var y = Math.floor(WORLD * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)));
    return [clamp(x, 0, WORLD - 1), clamp(y, 0, WORLD - 1)];
  }

  function cellToLatLng(cx, cy) {
    var lng = (cx / WORLD) * 360 - 180;
    var n = Math.PI - 2 * Math.PI * cy / WORLD;
    var lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lat, lng];
  }

  // Zoom de visão geral: encaixa spanX×spanY células na tela com 10% de margem,
  // entre MIN_RENDER_ZOOM (abaixo não desenha) e CANVAS_ZOOM (célula = 1px)
  function fitZoom(spanX, spanY, screenW, screenH) {
    var fit = Math.min(screenW / Math.max(1, spanX), screenH / Math.max(1, spanY)) * 0.9;
    var z = CANVAS_ZOOM + Math.log(fit) / Math.LN2;
    if (z > CANVAS_ZOOM) z = CANVAS_ZOOM;
    if (z < MIN_RENDER_ZOOM) z = MIN_RENDER_ZOOM;
    return Math.floor(z);
  }

  /* Caixa (em células) de uma lista de tiles [{tx,ty}...].
     Se o desenho estiver espalhado demais (> maxSpanTiles em qualquer eixo,
     ex.: tiles recentes de pontos distantes do mundo), usa o aglomerado mais
     denso em buckets de 16×16 tiles — assim a visão geral não pega o oceano. */
  function tilesBox(rows, maxSpanTiles) {
    if (!rows || !rows.length) return null;
    maxSpanTiles = maxSpanTiles || 24;
    function box(rs) {
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i];
        if (r.tx < x0) x0 = r.tx;
        if (r.tx > x1) x1 = r.tx;
        if (r.ty < y0) y0 = r.ty;
        if (r.ty > y1) y1 = r.ty;
      }
      return {
        x0: x0 * TILE, y0: y0 * TILE,
        x1: (x1 + 1) * TILE - 1, y1: (y1 + 1) * TILE - 1,
        spanX: x1 - x0 + 1, spanY: y1 - y0 + 1
      };
    }
    var b = box(rows);
    if (b.spanX <= maxSpanTiles && b.spanY <= maxSpanTiles) return b;
    var buckets = new Map();
    for (var i = 0; i < rows.length; i++) {
      var k = Math.floor(rows[i].tx / 16) + ',' + Math.floor(rows[i].ty / 16);
      var arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(rows[i]);
    }
    var best = null;
    buckets.forEach(function (arr) { if (!best || arr.length > best.length) best = arr; });
    return best ? box(best) : b;
  }

  // ---------- Linha de células (Bresenham) ----------
  function lineCells(x0, y0, x1, y1, fn) {
    var dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    var dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    var err = dx + dy;
    for (;;) {
      fn(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // ---------- Quantização de imagem para a paleta (Studio / Overlay) ----------
  function nearestPaletteIndex(r, g, b) {
    var best = 1, bestD = Infinity;
    for (var i = 1; i < PALETTE_RGB.length; i++) {
      var p = PALETTE_RGB[i];
      var dr = r - p[0], dg = g - p[1], db = b - p[2];
      var d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
    }
    return best;
  }

  /* data: RGBA (Uint8ClampedArray/Uint8Array) -> índices 0..63 (0 = transparente) */
  function quantizeRgba(data, w, h) {
    var out = new Uint8Array(w * h);
    for (var i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = data[p + 3] < 128 ? 0 : nearestPaletteIndex(data[p], data[p + 1], data[p + 2]);
    }
    return out;
  }

  // ---------- Base64 ----------
  function bytesToB64(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }

  function b64ToBytes(b64) {
    var s = atob(b64);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  var HAS_DEFLATE = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

  /* Tile legado (1 byte por célula = índice da paleta) → RGBA cheio */
  function expandPaletteTile(raw) {
    var out = new Uint8Array(TILE_BYTES);
    var n = Math.min(raw.length, TILE * TILE);
    for (var i = 0; i < n; i++) {
      var ci = raw[i];
      if (!ci || ci >= PALETTE_RGB.length) continue;
      var rgb = PALETTE_RGB[ci], o = i << 2;
      out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255;
    }
    return out;
  }

  /* Payload novo = RGBA cheio: 'C:' + base64(deflate-raw) ou 'U:' + base64(cru)
     Payload legado (só leitura): 'D:'/'R:' + índice da paleta por célula */
  function bytesToPayload(bytes) {
    if (HAS_DEFLATE) {
      var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Response(stream).arrayBuffer().then(function (buf) {
        return 'C:' + bytesToB64(new Uint8Array(buf));
      });
    }
    return Promise.resolve('U:' + bytesToB64(bytes));
  }

  function decodeRaw(payload, tag) {
    var raw;
    try { raw = b64ToBytes(payload.slice(2)); } catch (e) { return null; }
    if (tag === 'C:') {
      if (!HAS_DEFLATE) return null;
      try {
        var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).arrayBuffer().then(function (buf) {
          var b = new Uint8Array(buf);
          return b.length === TILE_BYTES ? b : null;
        }).catch(function () { return null; });
      } catch (e) { return null; }
    }
    if (tag === 'U:') return raw.length === TILE_BYTES ? raw : null;
    // legado: índice da paleta em 1 byte por célula
    if (tag === 'D:') {
      if (!HAS_DEFLATE) return null;
      try {
        var s2 = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(s2).arrayBuffer().then(function (buf) {
          var b = new Uint8Array(buf);
          return b.length === PALETTE_TILE_BYTES ? expandPaletteTile(b) : null;
        }).catch(function () { return null; });
      } catch (e) { return null; }
    }
    if (tag === 'R:') return raw.length === PALETTE_TILE_BYTES ? expandPaletteTile(raw) : null;
    return null;
  }

  function payloadToBytes(payload) {
    if (!payload) return Promise.resolve(new Uint8Array(TILE_BYTES));
    var tag = payload.slice(0, 2);
    var res;
    try { res = decodeRaw(payload, tag); } catch (e) { res = null; }
    if (!res) return Promise.resolve(new Uint8Array(TILE_BYTES));
    return Promise.resolve(res instanceof Uint8Array ? res : res.then(function (b) {
      return b || new Uint8Array(TILE_BYTES);
    }));
  }

  root.PM = {
    CANVAS_ZOOM: CANVAS_ZOOM,
    WORLD: WORLD,
    TILE: TILE,
    NTILES: NTILES,
    CELL_BYTES: CELL_BYTES,
    TILE_BYTES: TILE_BYTES,
    PALETTE_TILE_BYTES: PALETTE_TILE_BYTES,
    MAX_LAT: MAX_LAT,
    MIN_RENDER_ZOOM: MIN_RENDER_ZOOM,
    MIN_PAINT_ZOOM: MIN_PAINT_ZOOM,
    MAX_TILES_FETCH: MAX_TILES_FETCH,
    PALETTE: PALETTE,
    PALETTE_RGB: PALETTE_RGB,
    latLngToCell: latLngToCell,
    cellToLatLng: cellToLatLng,
    fitZoom: fitZoom,
    tilesBox: tilesBox,
    lineCells: lineCells,
    nearestPaletteIndex: nearestPaletteIndex,
    quantizeRgba: quantizeRgba,
    expandPaletteTile: expandPaletteTile,
    bytesToPayload: bytesToPayload,
    payloadToBytes: payloadToBytes,
    HAS_DEFLATE: HAS_DEFLATE
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
