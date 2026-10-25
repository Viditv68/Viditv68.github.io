/* =========================================================================
   Vidit Rawat — interactive background
   One fixed 2D canvas behind every page: a synthwave perspective grid that
   scrolls toward the viewer, and a field of pixel motes that drift upward,
   light up and scatter around the cursor.

   2D canvas rather than WebGL: a few dozen lines and squares a frame cost
   well under a millisecond, and the companion already owns the one WebGL
   context a mid-range laptop should be asked to keep alive.

   No canvas support → nothing is added and the body's CSS gradient stays.
   Reduced motion → one still frame, no loop, no listeners.
   ========================================================================= */
(function () {
  "use strict";

  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  canvas.className = "bg-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.insertBefore(canvas, document.body.firstChild);

  var ACCENT = [47, 123, 255];
  var ACCENT2 = [139, 60, 255];
  var PALE = [170, 208, 255];

  var w = 0, h = 0, dpr = 1;
  var motes = [];
  var glow = null;

  // Pointer target and a lerped copy, so the vanishing point eases rather
  // than snapping when the cursor jumps.
  var px = -9999, py = -9999;
  var vx = 0.5, vxTarget = 0.5;

  var scrollY = window.scrollY || 0;
  var lastScroll = scrollY;
  var boost = 0;
  var phase = 0;
  var last = 0;
  var raf = 0;

  function rgba(c, a) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a.toFixed(3) + ")";
  }

  function makeMotes() {
    // Phones get a third of the field; it is the pixel count, not the
    // maths, that a small GPU notices.
    var count = w < 700 ? 34 : w < 1200 ? 70 : 96;
    motes = [];
    for (var i = 0; i < count; i++) {
      motes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        z: 0.3 + Math.random() * 0.7, // depth: nearer motes move and parallax more
        s: Math.random() < 0.18 ? 3 : 2,
        c: Math.random() < 0.55 ? ACCENT : Math.random() < 0.6 ? ACCENT2 : PALE,
        tw: Math.random() * Math.PI * 2,
        ox: 0,
        oy: 0
      });
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    makeMotes();
  }

  function horizonY() {
    // The floor sinks as the page scrolls, so the grid reads as a distant
    // layer instead of a sticker glued to the glass.
    var base = h * (w < 700 ? 0.7 : 0.64);
    return base + Math.min(scrollY * 0.12, h * 0.16);
  }

  function drawGrid(hy) {
    // Past the hero the grid steps back so body copy owns the foreground.
    var fade = 1 - Math.min(scrollY / (h * 1.2), 1) * 0.55;
    var floorH = h - hy;
    if (floorH <= 0) return;

    if (!glow || glow.h !== h || glow.hy !== Math.round(hy)) {
      var g = ctx.createLinearGradient(0, hy - 90, 0, hy + 40);
      g.addColorStop(0, "rgba(139,60,255,0)");
      g.addColorStop(0.7, "rgba(139,60,255,0.10)");
      g.addColorStop(0.86, "rgba(47,123,255,0.16)");
      g.addColorStop(1, "rgba(47,123,255,0)");
      glow = { g: g, h: h, hy: Math.round(hy) };
    }
    ctx.fillStyle = glow.g;
    ctx.fillRect(0, hy - 90, w, 130);

    var cx = w * (0.38 + vx * 0.24);
    ctx.lineWidth = 1;

    // Rows: evenly spaced in depth, squared on screen, so they bunch at the
    // horizon and open up toward the viewer. `phase` walks them forward.
    var rows = 16;
    for (var i = 0; i < rows; i++) {
      var t = (i + phase) / rows;
      var y = hy + floorH * t * t;
      var a = (0.05 + t * 0.32) * fade;
      ctx.strokeStyle = rgba(i % 4 === 0 ? ACCENT2 : ACCENT, a);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Columns converge on the (cursor-nudged) vanishing point.
    var cols = w < 700 ? 14 : 24;
    var spread = w * 2.4;
    for (var j = 0; j <= cols; j++) {
      var bx = cx + (j / cols - 0.5) * spread;
      var tx = cx + (bx - cx) * 0.04;
      ctx.strokeStyle = rgba(ACCENT, 0.2 * fade);
      ctx.beginPath();
      ctx.moveTo(tx, hy);
      ctx.lineTo(bx, h);
      ctx.stroke();
    }

    ctx.strokeStyle = rgba(PALE, 0.35 * fade);
    ctx.beginPath();
    ctx.moveTo(0, hy);
    ctx.lineTo(w, hy);
    ctx.stroke();
  }

  function drawMotes(dt, dy, time) {
    var R = w < 700 ? 90 : 150;
    var R2 = R * R;

    for (var i = 0; i < motes.length; i++) {
      var m = motes[i];

      m.y -= (6 + m.z * 10) * dt;   // slow upward drift
      m.y -= dy * m.z * 0.35;       // scroll parallax, nearer moves more
      if (m.y < -10) { m.y = h + 10; m.x = Math.random() * w; }
      if (m.y > h + 10) { m.y = -10; m.x = Math.random() * w; }

      var x = m.x + m.ox;
      var y = m.y + m.oy;
      var dx = x - px;
      var dyy = y - py;
      var d2 = dx * dx + dyy * dyy;
      var lit = 0;

      if (d2 < R2) {
        var d = Math.sqrt(d2) || 1;
        lit = 1 - d / R;
        // Push out along the cursor ray; the offset springs back below.
        m.ox += (dx / d) * lit * 90 * dt * 2;
        m.oy += (dyy / d) * lit * 90 * dt * 2;
      }
      m.ox *= 0.94;
      m.oy *= 0.94;

      var twinkle = 0.5 + 0.5 * Math.sin(time * 0.0016 + m.tw);
      var a = (0.18 + twinkle * 0.22) * m.z + lit * 0.7;
      var s = m.s + (lit > 0.4 ? 1 : 0);
      ctx.fillStyle = rgba(lit > 0.25 ? PALE : m.c, Math.min(a, 0.95));
      ctx.fillRect(Math.round(x), Math.round(y), s, s);
    }
  }

  function drawCursorLight() {
    if (px < 0) return;
    var r = w < 700 ? 120 : 220;
    var g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, "rgba(47,123,255,0.10)");
    g.addColorStop(1, "rgba(47,123,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(px - r, py - r, r * 2, r * 2);
  }

  function frame(time) {
    var dt = last ? Math.min((time - last) / 1000, 0.05) : 0.016;
    last = time;

    var dy = scrollY - lastScroll;
    lastScroll = scrollY;
    // Scrolling either way briefly speeds the floor up, then it coasts.
    boost += (Math.min(Math.abs(dy), 60) * 0.06 - boost) * 0.08;
    phase = (phase + dt * (0.35 + boost)) % 1;
    vx += (vxTarget - vx) * 0.05;

    ctx.clearRect(0, 0, w, h);
    var hy = horizonY();
    drawGrid(hy);
    drawCursorLight();
    drawMotes(dt, dy, time);

    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf || document.hidden) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function still() {
    ctx.clearRect(0, 0, w, h);
    phase = 0.5;
    drawGrid(horizonY());
    drawMotes(0, 0, 0);
  }

  resize();

  if (reduceMotion) {
    still();
    window.addEventListener("resize", function () { resize(); still(); });
    return;
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("scroll", function () {
    scrollY = window.scrollY || window.pageYOffset || 0;
  }, { passive: true });

  window.addEventListener("pointermove", function (e) {
    // Touch "hover" would leave a light stuck wherever the finger lifted.
    if (e.pointerType === "touch") return;
    px = e.clientX;
    py = e.clientY;
    vxTarget = e.clientX / (w || 1);
  }, { passive: true });

  document.documentElement.addEventListener("pointerleave", function () {
    px = py = -9999;
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else start();
  });

  start();
})();
