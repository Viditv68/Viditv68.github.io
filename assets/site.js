/* =========================================================================
   Vidit Rawat — portfolio behaviour
   Vanilla JS, no dependencies. Everything degrades gracefully:
   without JS the page renders fully, just without motion.
   ========================================================================= */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* --- Mobile nav ------------------------------------------------------ */
  function initNav() {
    var toggle = document.querySelector(".hud-nav__toggle");
    var links = document.querySelector(".hud-nav__links");
    if (!toggle || !links) return;

    function close() {
      links.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    }

    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    // Close after tapping a destination, or on Escape.
    links.addEventListener("click", function (e) {
      if (e.target.closest("a")) close();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });

    // Reset the collapsed state when we grow past the mobile breakpoint.
    window.matchMedia("(min-width: 821px)").addEventListener("change", close);
  }

  /* --- Scroll reveals --------------------------------------------------- */
  function initReveals() {
    var items = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
    if (!items.length) return;

    // No IntersectionObserver (or motion is off): show everything immediately.
    if (reduceMotion || !("IntersectionObserver" in window)) {
      items.forEach(function (el) {
        el.classList.add("is-visible");
      });
      return;
    }

    // Give each element a stagger index based on its position among
    // revealing siblings, unless the markup already set one.
    var seen = new Map();
    items.forEach(function (el) {
      var parent = el.parentNode;
      var n = seen.get(parent) || 0;
      seen.set(parent, n + 1);
      // Count every revealing sibling so hand-authored indices stay in
      // sequence, but only assign one where the markup didn't set it.
      if (el.style.getPropertyValue("--i")) return;
      // Cap the delay so long lists don't crawl in one at a time.
      el.style.setProperty("--i", String(Math.min(n, 6)));
    });

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target); // reveal once, then stop watching
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );

    items.forEach(function (el) {
      observer.observe(el);
    });

    // Failsafe: if anything is still hidden well after load — a zero-size
    // container, a layout we didn't anticipate — show it rather than leave
    // content permanently invisible.
    window.addEventListener("load", function () {
      setTimeout(function () {
        items.forEach(function (el) {
          if (!el.classList.contains("is-visible")) {
            // Only force elements that are actually in or above the viewport.
            var rect = el.getBoundingClientRect();
            if (rect.top < window.innerHeight * 1.5) {
              el.classList.add("is-visible");
              observer.unobserve(el);
            }
          }
        });
      }, 2500);
    });
  }

  /* --- Smooth scrolling for in-page links ------------------------------- */
  function initSmoothScroll() {
    document.addEventListener("click", function (e) {
      var link = e.target.closest('a[href^="#"]');
      if (!link) return;

      var id = link.getAttribute("href");
      if (!id || id === "#") return;

      var target = document.querySelector(id);
      if (!target) return;

      e.preventDefault();
      target.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start"
      });

      // Keep the URL shareable without the jump scrollIntoView already handled.
      if (history.replaceState) history.replaceState(null, "", id);

      // Move keyboard focus along with the viewport.
      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    });
  }

  /* --- Video: only ever let one clip play at a time --------------------- */
  function initVideos() {
    var videos = Array.prototype.slice.call(document.querySelectorAll("video"));
    videos.forEach(function (video) {
      video.addEventListener("play", function () {
        videos.forEach(function (other) {
          if (other !== video && !other.paused) other.pause();
        });
      });
    });
  }

  /* --- Hero scan glow ---------------------------------------------------
     Moves a single element with translate3d. No canvas, no per-frame paint.
     The loop only runs while the hero is on screen AND the tab is visible;
     touch devices never start it at all and use a CSS drift instead.       */
  function initHeroGlow() {
    var hero = document.querySelector(".hero");
    var spot = hero && hero.querySelector(".hero__spot");
    if (!spot) return;

    // Reduced motion: CSS already parks it. Never start anything.
    if (reduceMotion) return;

    var canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

    // No pointer to follow — hand off to the CSS keyframe drift, which
    // costs nothing per frame, and just pause it when the tab is hidden.
    if (!canHover) {
      hero.classList.add("is-drifting");
      document.addEventListener("visibilitychange", function () {
        hero.classList.toggle("is-paused", document.hidden);
      });
      return;
    }

    var w = 0;
    var h = 0;
    function measure() {
      var r = hero.getBoundingClientRect();
      w = r.width;
      h = r.height;
    }
    measure();

    // Offsets relative to the spot's CSS anchor. Resting position is 0,0 —
    // which is also where the CSS drift keyframes begin and end.
    var curX = 0;
    var curY = 0;
    var tgtX = 0;
    var tgtY = 0;
    var idleSince = 0;
    var tracking = false; // true => JS drives it; false => CSS drift does
    var onScreen = true;
    var frame = 0;

    // Where the CSS animation has the spot right now, so we can pick up
    // from exactly there instead of snapping back to the anchor.
    function readCurrent() {
      curX = 0;
      curY = 0;
      var t = getComputedStyle(spot).transform;
      if (!t || t === "none" || typeof DOMMatrixReadOnly === "undefined") return;
      try {
        var m = new DOMMatrixReadOnly(t);
        curX = m.m41;
        curY = m.m42;
      } catch (err) {
        /* unparseable transform — start from rest */
      }
    }

    function startTracking() {
      if (tracking) return;
      tracking = true;
      readCurrent();
      hero.classList.remove("is-drifting");
      spot.style.transform =
        "translate3d(" + curX.toFixed(1) + "px," + curY.toFixed(1) + "px,0)";
      frame = requestAnimationFrame(tick);
    }

    // Hand back to the CSS keyframes: composited, and costs the main
    // thread nothing while the visitor is just reading the page.
    function stopTracking(resumeDrift) {
      if (!tracking) return;
      tracking = false;
      cancelAnimationFrame(frame);
      if (resumeDrift) {
        spot.style.transform = "";
        hero.classList.add("is-drifting");
      }
    }

    function onPointerMove(e) {
      if (!onScreen || document.hidden) return;
      var r = hero.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom) return;
      tgtX = e.clientX - r.left - w / 2;
      tgtY = e.clientY - r.top - h * 0.45;
      idleSince = performance.now();
      startTracking();
    }

    function tick(now) {
      // Two seconds without pointer movement: ease back to the resting
      // position, then let the CSS drift take over and shut the loop down.
      var idle = now - idleSince > 2000;
      if (idle) {
        tgtX = 0;
        tgtY = 0;
      }

      // Ease toward the target — makes the glow trail the cursor rather
      // than being glued to it.
      curX += (tgtX - curX) * 0.075;
      curY += (tgtY - curY) * 0.075;

      if (idle && Math.abs(curX) < 1.5 && Math.abs(curY) < 1.5) {
        stopTracking(true);
        return;
      }

      spot.style.transform =
        "translate3d(" + curX.toFixed(1) + "px," + curY.toFixed(1) + "px,0)";
      frame = requestAnimationFrame(tick);
    }

    function sync() {
      var active = onScreen && !document.hidden;
      // Going inactive: hand back to the CSS drift rather than leaving the
      // spot frozen at the pointer's last position with a stale inline
      // transform — otherwise it stays stuck until the pointer moves again.
      // The drift is paused in the same breath, so the swap is never seen.
      if (!active) stopTracking(true);
      else if (!tracking) {
        spot.style.transform = "";
        hero.classList.add("is-drifting");
      }
      hero.classList.toggle("is-paused", !active);
    }

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("resize", measure);
    document.addEventListener("visibilitychange", sync);

    // Stop entirely once the hero is scrolled past — nothing to animate.
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        sync();
      }).observe(hero);
    }

    // Idle until the pointer actually moves.
    hero.classList.add("is-drifting");
  }

  /* --- WebGL neural vortex -----------------------------------------------
     Hand-written GLSL, no library. A swirling, domain-warped noise field in
     the brand cyan/violet, composited with `screen` so only its light lands
     on the page.

     Kept cheap deliberately: it renders to a fraction of device resolution
     (it's a soft glow, so upscaling is invisible), drops octaves on small
     screens, renders a single static frame under reduced motion, and stops
     entirely when off-screen or backgrounded.

     Returns false if a context can't be created or the program won't link,
     which lets the caller fall back to the pure-CSS scan glow.            */
  var VERT_SRC =
    "attribute vec2 aPos;" +
    "void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }";

  function fragSource(octaves) {
    return [
      "#ifdef GL_FRAGMENT_PRECISION_HIGH",
      "precision highp float;",
      "#else",
      "precision mediump float;",
      "#endif",
      "uniform vec2 uRes;",
      "uniform float uTime;",
      "uniform vec2 uMouse;",

      "float hash(vec2 p){",
      "  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);",
      "}",

      "float noise(vec2 p){",
      "  vec2 i = floor(p), f = fract(p);",
      "  vec2 u = f * f * (3.0 - 2.0 * f);",
      "  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),",
      "             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);",
      "}",

      "float fbm(vec2 p){",
      "  float v = 0.0, a = 0.5;",
      "  for (int i = 0; i < " + octaves + "; i++) {",
      "    v += a * noise(p);",
      "    p *= 2.02;",
      "    a *= 0.5;",
      "  }",
      "  return v;",
      "}",

      "void main(){",
      // Normalise by half the diagonal so r is ~0 at centre and ~1.0 at the
      // corners on ANY aspect ratio. Dividing by min(uRes) instead put a
      // wide viewport's corners right at the bright ring.
      "  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * length(uRes));",
      // drift the whole field gently toward the pointer
      "  uv -= (uMouse - 0.5) * 0.28;",

      "  float r = length(uv);",
      "  float ang = atan(uv.y, uv.x);",

      // the vortex itself: angular offset tightens as radius shrinks
      "  float swirl = ang + uTime * 0.05 - 1.5 / (r + 0.38);",
      "  vec2 q = vec2(cos(swirl), sin(swirl)) * r;",

      // two-step domain warp gives the field its filament structure
      "  float n1 = fbm(q * 2.3 + uTime * 0.045);",
      "  float n2 = fbm(q * 3.4 - uTime * 0.06 + n1 * 1.4);",
      "  float f  = fbm(q * 1.7 + vec2(n1, n2) * 1.7 + uTime * 0.025);",

      "  float bands = smoothstep(0.38, 0.86, f);",
      "  float filaments = pow(1.0 - abs(f * 2.0 - 1.0), 3.0);",

      // Blue-leaning cyan: a greener one turns lime once `screen` blending
      // stacks it on the navy page beneath.
      "  vec3 cyan   = vec3(0.05, 0.72, 1.00);",
      "  vec3 violet = vec3(0.58, 0.30, 1.00);",
      "  vec3 col = mix(violet, cyan, clamp(bands + filaments * 0.5, 0.0, 1.0));",
      "  col *= filaments * 0.55 + bands * 0.18;",

      // Annulus, not a disc: brightest just outside the glass card so it
      // frames the card, near-dark behind the text, gone before the edges.
      "  float ring = smoothstep(0.30, 0.66, r) * smoothstep(1.02, 0.72, r);",
      "  col *= ring;",

      // hard ceiling so the card text can never be washed out
      "  col = min(col, vec3(0.22));",
      "  gl_FragColor = vec4(col, 1.0);",
      "}"
    ].join("\n");
  }

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function initVortex(hero) {
    var canvas = hero.querySelector(".hero__vortex");
    if (!canvas || !window.WebGLRenderingContext) return false;

    var opts = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power"
    };

    var gl = null;
    try {
      gl = canvas.getContext("webgl", opts) ||
           canvas.getContext("experimental-webgl", opts);
    } catch (e) {
      return false;
    }
    if (!gl) return false;

    var small = window.matchMedia("(max-width: 700px)").matches;
    var vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fragSource(small ? 3 : 5));
    if (!vs || !fs) return false;

    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;

    gl.useProgram(prog);

    // One oversized triangle covers the viewport with 3 vertices.
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var uRes = gl.getUniformLocation(prog, "uRes");
    var uTime = gl.getUniformLocation(prog, "uTime");
    var uMouse = gl.getUniformLocation(prog, "uMouse");

    // Soft glow — no need for device resolution.
    var scale = Math.min(window.devicePixelRatio || 1, 1.5) * (small ? 0.45 : 0.6);

    function resize() {
      var w = Math.max(1, Math.round(hero.clientWidth * scale));
      var h = Math.max(1, Math.round(hero.clientHeight * scale));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    }
    resize();

    var mx = 0.5, my = 0.5, tmx = 0.5, tmy = 0.5;
    var start = performance.now();
    var frame = 0;
    var running = false;
    var onScreen = true;
    var lost = false;

    function draw(t) {
      mx += (tmx - mx) * 0.05;
      my += (tmy - my) * 0.05;
      gl.uniform1f(uTime, t);
      gl.uniform2f(uMouse, mx, my);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function loop() {
      draw((performance.now() - start) / 1000);
      frame = requestAnimationFrame(loop);
    }

    function start_() {
      if (running || lost || reduceMotion) return;
      running = true;
      frame = requestAnimationFrame(loop);
    }

    function stop_() {
      if (!running) return;
      running = false;
      cancelAnimationFrame(frame);
    }

    function sync() {
      if (onScreen && !document.hidden) start_();
      else stop_();
    }

    // Reduced motion: one static frame, then never again.
    if (reduceMotion) {
      draw(12.0);
      window.addEventListener("resize", function () {
        resize();
        draw(12.0);
      });
      return true;
    }

    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      window.addEventListener("pointermove", function (e) {
        var r = hero.getBoundingClientRect();
        if (e.clientY < r.top || e.clientY > r.bottom) return;
        tmx = (e.clientX - r.left) / r.width;
        tmy = 1.0 - (e.clientY - r.top) / r.height;
      }, { passive: true });
    }

    var resizeTimer = 0;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    });

    // A dropped context must not leave a dead canvas on screen.
    canvas.addEventListener("webglcontextlost", function (e) {
      e.preventDefault();
      lost = true;
      stop_();
      hero.classList.remove("has-vortex");
    });

    canvas.addEventListener("webglcontextrestored", function () {
      lost = false;
      if (initVortex(hero)) hero.classList.add("has-vortex");
    });

    document.addEventListener("visibilitychange", sync);

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        sync();
      }).observe(hero);
    }

    sync();
    return true;
  }

  /* Vortex first; the CSS scan glow is the fallback when WebGL is
     unavailable, blocked, or fails to compile. */
  function initHeroBackground() {
    var hero = document.querySelector(".hero");
    if (!hero) return;
    if (initVortex(hero)) hero.classList.add("has-vortex");
    else initHeroGlow();
  }

  /* --- Footer year ------------------------------------------------------ */
  function initYear() {
    document.querySelectorAll("[data-year]").forEach(function (el) {
      el.textContent = String(new Date().getFullYear());
    });
  }

  function init() {
    initNav();
    initReveals();
    initSmoothScroll();
    initVideos();
    initHeroBackground();
    initYear();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
