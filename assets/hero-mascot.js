/* =========================================================================
   Hero mascot — Zeph, standing in front of the portrait frame.
   The character itself lives in mascot.js (built from three.js primitives,
   no model file). This module owns the renderer, the lighting that ties him
   to the fluid background, and the cursor → look-angle mapping.

   Wide screens only: at 860px and below the portrait shrinks to a thumbnail
   and there is no room for him, so no renderer is ever created there. The
   loop also stops while the hero is scrolled out of view or the tab is
   hidden, so past the first screen he costs nothing.
   ========================================================================= */
import * as THREE from "three";
import { makeMascot } from "./mascot.js";

/* 35° each way: past roughly 45° the near eye pokes out of the head outline
   in 3/4 view. The head takes about 0.84 of this (head + torso share). */
const LOOK = { maxYaw: THREE.MathUtils.degToRad(35), maxPitch: THREE.MathUtils.degToRad(28), damp: 5 };
const HEIGHT = 2; // world units the character is scaled to

export function mountHeroMascot(canvas) {
  if (!canvas || location.protocol === "file:") return null;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wide = window.matchMedia("(min-width: 861px)");

  var renderer = null, scene, camera, zeph, rimU;
  var raf = 0, last = 0, inView = true;

  /* Built on first need, so a phone never allocates the GPU context. */
  function init() {
    if (renderer) return true;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    } catch (err) {
      if (window.console) console.warn("[mascot] WebGL unavailable:", err.message);
      return false;
    }
    renderer.setClearAlpha(0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);

    // Dim cool fill + saturated rims in the site palette, so he reads as lit by the smoke.
    scene.add(new THREE.HemisphereLight(0x6f8fd0, 0x080b14, 0.55));
    var key = new THREE.DirectionalLight(0xc8d4ff, 1.25); key.position.set(-2, 3, 4); scene.add(key);
    var rimB = new THREE.DirectionalLight(0x2f7bff, 3.2); rimB.position.set(-4, 2, -3); scene.add(rimB);
    var rimV = new THREE.DirectionalLight(0x8b3cff, 3.0); rimV.position.set(4, 1.5, -3); scene.add(rimV);

    // Fresnel edge glow, blue on left-facing edges and violet on the right, injected into the standard material.
    rimU = { value: 0.8 };
    var made = makeMascot();
    made.root.traverse(function (o) {
      if (!o.isMesh) return;
      [].concat(o.material).forEach(function (m) {
        if (!m.isMeshStandardMaterial || m.userData.styled) return;
        m.userData.styled = true;
        m.onBeforeCompile = function (s) {
          s.uniforms.uRim = rimU;
          s.fragmentShader = "uniform float uRim;\n" + s.fragmentShader.replace("#include <emissivemap_fragment>",
            "#include <emissivemap_fragment>\n" +
            "float fr = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);\n" +
            "vec3 rc = mix(vec3(0.184, 0.482, 1.0), vec3(0.545, 0.235, 1.0), smoothstep(-0.4, 0.4, normal.x));\n" +
            "totalEmissiveRadiance += rc * fr * uRim;");
        };
      });
    });

    // Fit to the body only: dash streaks and glow sprites would skew the box.
    made.tick(0, 0, 0, 0, false, true);
    made.root.updateMatrixWorld(true);
    var box = new THREE.Box3(), one = new THREE.Box3();
    made.root.traverse(function (o) { if (o.isMesh && !o.userData.noFit) box.union(one.setFromObject(o)); });
    var size = box.getSize(new THREE.Vector3());
    var s = HEIGHT / (Math.max(size.y, size.x * 1.25) || 1);
    made.root.scale.setScalar(s);
    made.root.position.set(-(box.min.x + size.x / 2) * s, -box.min.y * s, -(box.min.z + size.z / 2) * s);
    scene.add(made.root);
    zeph = made;

    resize();
    return true;
  }

  function resize() {
    if (!renderer) return;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Fit HEIGHT plus headroom vertically, then pull back further if the canvas is narrow.
    var fitH = HEIGHT * 1.3, fitW = HEIGHT * 0.9;
    var tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    var dist = Math.max(fitH / 2 / tan, fitW / 2 / (tan * camera.aspect));
    camera.position.set(0, HEIGHT * 0.75, dist); // eye level-ish: from below, faces read as frowning
    camera.lookAt(0, HEIGHT * 0.5, 0);
    camera.updateProjectionMatrix();
    if (reduceMotion) render(0, 0);
  }

  /* --- Cursor → damped look angles + cursor speed ---------------------- */
  var noHover = window.matchMedia("(hover: none)").matches;
  var headPos = new THREE.Vector3();
  var px = null, py = null, lastPx = 0, lastMove = 0, rawVx = 0, vx = 0, yaw = 0, pitch = 0, near = false;

  window.addEventListener("pointermove", function (ev) {
    if (ev.pointerType === "touch") return;
    var now = performance.now();
    if (px !== null && now > lastMove) rawVx = (ev.clientX - lastPx) / (now - lastMove) * 1000;
    px = lastPx = ev.clientX;
    py = ev.clientY;
    lastMove = now;
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", function () { px = py = null; rawVx = 0; });

  function aim(t) {
    var ty = 0, tp = 0;
    near = false;
    if (noHover) {
      ty = Math.sin(t * 0.23) * 0.6 * LOOK.maxYaw;
      tp = Math.sin(t * 0.17 + 1) * 0.3 * LOOK.maxPitch;
    } else if (px !== null) {
      // Screen-space offset from the head, not a true 3D ray: a cursor anywhere over the copy should
      // read as "looking at it", which a physically correct ray at this camera distance under-sells.
      var r = canvas.getBoundingClientRect();
      zeph.head.getWorldPosition(headPos).project(camera);
      var hx = r.left + (headPos.x + 1) / 2 * r.width, hy = r.top + (1 - headPos.y) / 2 * r.height;
      near = Math.hypot(px - hx, py - hy) < 170;
      ty = LOOK.maxYaw * Math.tanh((px - hx) / (window.innerWidth * 0.35));
      tp = LOOK.maxPitch * Math.tanh((py - hy) / (window.innerHeight * 0.4));
    }
    return [ty, tp];
  }

  function render(dt, t) {
    if (!reduceMotion) {
      var aimed = aim(t);
      var k = 1 - Math.exp(-LOOK.damp * dt);
      yaw += (aimed[0] - yaw) * k;
      pitch += (aimed[1] - pitch) * k;
      if (performance.now() - lastMove > 80) rawVx = 0; // pointer stopped
      vx += (THREE.MathUtils.clamp(rawVx / 2500, -1, 1) - vx) * (1 - Math.exp(-8 * dt));
    }
    zeph.tick(dt, t, yaw, pitch, near, reduceMotion, vx);
    renderer.render(scene, camera);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
    last = now;
    render(dt, now / 1000);
  }

  function start() {
    if (raf || !wide.matches || document.hidden || !inView) return;
    if (!init()) return;
    if (reduceMotion) { render(0, 0); return; }
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      inView = entries[0].isIntersecting;
      if (inView) start(); else stop();
    }).observe(canvas);
  }

  document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });
  wide.addEventListener("change", function () { if (wide.matches) { start(); resize(); } else stop(); });
  window.addEventListener("resize", resize, { passive: true });
  canvas.addEventListener("webglcontextlost", function (e) { e.preventDefault(); stop(); canvas.hidden = true; });

  start();
  return { start: start, stop: stop };
}
