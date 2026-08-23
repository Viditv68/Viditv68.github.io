/* =========================================================================
   Scroll companion — RobotExpressive walking along the bottom of the page.

   Model: RobotExpressive.glb (Tomás Laulhé, CC0 1.0; modifications by Don
   McCurdy). Served from assets/companion/robot.glb rather than hotlinked,
   so the site keeps working if three.js reshuffles its examples folder.
   Every clip we need already lives in that one file — no rigging step.

   Two ideas worth knowing before reading the rest.

   ONE — the route. The page is divided into panels, and each panel gets one
   complete edge-to-edge crossing. Direction alternates with the panel index,
   so panel N finishes exactly where panel N+1 begins and the whole route
   joins up end to end with no teleporting. His target X is a pure function
   of window.scrollY, not something accumulated from scroll deltas, so it
   cannot drift and scrolling back up retraces the path exactly.

   TWO — the stride. Playback rate is always ground speed / the clip's
   reference speed, so the feet match the ground at any pace. Crossing a
   whole lane while one panel scrolls past is about nine body-lengths, which
   is a run rather than a walk, so there are two locomotion clips with a
   hysteretic threshold between them.

   Public API:
     ready / setState / notifyScroll / setSections / getState /
     resolveAmbient / isRunning / resize / dispose / debug
   ========================================================================= */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/* Resolved against this module's own URL, so every page — root, /Projects,
   /program, /Contact — gets a correct path without passing one in. */
export const MODEL_URL = new URL("./companion/robot.glb", import.meta.url).href;

/* Clip names as they actually appear inside the .glb. Verified by parsing
   the file's JSON chunk; the full set is Dance, Death, Idle, Jump, No,
   Punch, Running, Sitting, Standing, ThumbsUp, Walking, WalkJump, Wave, Yes. */
export const CLIPS = {
  idle: "Idle",
  walk: "Walking",
  run: "Running",
  wave: "Wave",
  jump: "Jump"
};

export const STATES = ["wave", "idle", "walk", "run", "jump"];

/* Clips that move him along the ground, as opposed to poses and one-shots. */
function isLocomotion(name) { return name === "walk" || name === "run"; }

/* One-shots hold the floor until their clip finishes, then hand back to
   whichever ambient state the scroll situation calls for. */
const ONE_SHOT = { wave: true, jump: true };

const TUNING = {
  viewHeight: 3.2,     // world units visible top-to-bottom in the canvas
  groundPad: 0.14,     // world units of canvas below the robot's feet
  robotHeight: 2.25,   // world units the robot is scaled to occupy
  edgeGap: 0.18,       // clear space between his silhouette and the viewport
  bodyHalfGuess: 0.8,  // stands in for his half-width until the model loads

  /* How hard he chases the position the scroll asks for. Higher is tighter;
     lower lets him lag and glide. Capped by refSpeed * maxRate regardless. */
  followRate: 9,

  /* Chase harder once the user stops, so he settles rather than creeping. */
  followRateSettling: 14,

  /* How close to a panel edge he has to be, when the panel changes, for the
     boundary to be worth a hop-turn rather than a plain about-face. */
  turnWindow: 1.8,

  /* The Jump clip takes 0.71s, during which he cannot travel. Only spend
     that if the panel lasts long enough to afford it — at the current scroll
     velocity the hop must fit inside this fraction of the panel. Otherwise
     he just turns and keeps running, which is what someone moving that fast
     would do anyway. */
  hopBudget: 0.45,

  /* Fraction of a panel over which the crossing is spread. The target sits
     on the far edge for the remainder, which gives the chase time to
     actually arrive — an exponential follow only ever approaches its target,
     so without this margin he would hand over to the next panel a little
     short of the edge every single time, and the hop-turn would never fire. */
  arriveAt: 0.82,

  /* Ground speed, in world units/second, at which each locomotion clip plays
     at rate 1.0. The stride is *always* set to speed / refSpeed, which is
     what keeps the feet matched to the ground — the rate clamps below are a
     cosmetic guard for extreme scrolling, not the mechanism.

     A panel's worth of scrolling has to carry him the full width of the
     lane, which is around nine body-lengths. That is a run, not a walk, at
     any normal scroll pace — hence two clips with a threshold between. */
  refSpeedWalk: 2.0,
  refSpeedRun: 5.2,
  runEnter: 3.6,       // ground speed at which he breaks into a run
  runExit: 2.9,        // and drops back to a walk (hysteresis, avoids flapping)

  walkRateRange: [0.35, 1.9],
  runRateRange: [0.7, 3.4],

  /* Ceiling on ground speed. High enough that an unhurried scroll completes
     a panel's crossing, low enough that a violent flick reads as running
     rather than teleporting. */
  maxSpeed: 30,

  /* The Jump clip lifts him about 19% of his height but has no root motion,
     so on its own the edge turnaround is a spin on the spot. Carrying him
     this far back off the wall turns it into a bounce. */
  hopDistance: 0.95,

  /* Window after landing during which the new panel's target cannot pull him
     back toward the edge he just bounced off. */
  hopGuardMs: 600,

  fade: 0.25,          // cross-fade seconds between looping clips
  fadeFast: 0.15,      // cross-fade into short one-shots (Jump is 0.71s)
  scrollIdleMs: 150,   // "still scrolling" debounce from the brief
  turnRate: 9,         // radians/second the model swings around

  /* Fallback if measuring the posed model ever returns nonsense. This is the
     assembled height of RobotExpressive in its own units. */
  fallbackHeight: 4.8
};

const HALF_PI = Math.PI / 2;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function smoothstep(u) { return u * u * (3 - 2 * u); }

/* Shortest-path angle step, so a 180 degree turn never takes the long way. */
function angleTowards(from, to, maxStep) {
  var d = ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

/* Measure the robot as it is actually drawn.

   Box3.setFromObject() on this file's root is not usable: FBX2glTF exports a
   bind pose in which the parts sit scattered across a volume roughly thirty
   times the assembled robot, and the skinning bounds never move with the
   animation. Normalising against that shrinks him to a four-pixel speck.
   Unioning the individual mesh boxes *after* a pose has been applied
   measures the shape on screen instead. */
function measurePosed(obj) {
  var box = new THREE.Box3();
  var one = new THREE.Box3();
  box.makeEmpty();
  obj.traverse(function (o) {
    if (o.isMesh) box.union(one.setFromObject(o));
  });
  return box;
}

/* A soft blue pool under the feet. Grounds the robot against the page —
   without it he reads as floating over the content rather than standing on
   the bottom edge. Drawn once into a 128px canvas, then reused. */
function contactGlowTexture() {
  var c = document.createElement("canvas");
  c.width = c.height = 128;
  var g = c.getContext("2d");
  var grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.0, "rgba(120,175,255,0.55)");
  grad.addColorStop(0.35, "rgba(70,120,255,0.22)");
  grad.addColorStop(1.0, "rgba(70,120,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  var tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* A dead stub with the same shape as a live companion, so callers never
   need to null-check the thing they got back. */
function unavailableCompanion(err) {
  var p = Promise.reject(err);
  p.catch(function () {});
  return {
    ready: p,
    unavailable: true,
    setState: function () {},
    notifyScroll: function () {},
    resolveAmbient: function () { return null; },
    getState: function () { return null; },
    isRunning: function () { return false; },
    resize: function () {},
    dispose: function () {},
    debug: function () {
      return { unavailable: true, reason: String((err && err.message) || err) };
    }
  };
}

export function createCompanion(options) {
  options = options || {};

  var mount = options.mount || document.body;
  var reduceMotion = !!options.reduceMotion;
  var onState = options.onState || function () {};
  var modelUrl = options.modelUrl || MODEL_URL;
  var T = Object.assign({}, TUNING, options.tuning || {});

  /* Every timestamp goes through this so a test can inject a fake clock. */
  var now = options.now || function () { return performance.now(); };

  function baseHeight() {
    return options.canvasHeight || (window.innerWidth < 900 ? 150 : 190);
  }
  var canvasHeight = baseHeight();

  /* --- canvas + renderer ------------------------------------------------ */
  var canvas = document.createElement("canvas");
  canvas.className = "companion-canvas";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    left: "0",
    bottom: "0",
    width: "100%",
    height: canvasHeight + "px",
    display: "block",
    pointerEvents: "none",
    zIndex: "60"
  });

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      alpha: true,
      antialias: window.innerWidth >= 900,
      powerPreference: "low-power"
    });
  } catch (err) {
    return unavailableCompanion(err);
  }
  if (!renderer.getContext()) return unavailableCompanion(new Error("no webgl context"));

  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  mount.appendChild(canvas);

  var scene = new THREE.Scene();
  var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(0, 0, 12);

  /* --- lighting ---------------------------------------------------------
     A neutral key so the robot's own white plastic still reads as white,
     plus two saturated rims — blue from behind-left, violet from
     behind-right — that trace his silhouette in the site's palette. */
  scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x080c16, 1.15));

  var key = new THREE.DirectionalLight(0xffffff, 1.55);
  key.position.set(2.2, 4.2, 3.4);
  scene.add(key);

  var rimBlue = new THREE.DirectionalLight(0x2f7bff, 2.3);
  rimBlue.position.set(-3.4, 2.0, -2.2);
  scene.add(rimBlue);

  var rimViolet = new THREE.DirectionalLight(0x8b3cff, 1.9);
  rimViolet.position.set(3.2, 1.4, -2.6);
  scene.add(rimViolet);

  /* --- contact glow ------------------------------------------------------ */
  var glowTex = contactGlowTexture();
  var glow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 0.9),
    new THREE.MeshBasicMaterial({
      map: glowTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  glow.position.set(0, 0.06, -0.4);
  scene.add(glow);

  /* --- state ------------------------------------------------------------- */
  var root = null;          // the loaded model, re-parented into the pivot
  var pivot = new THREE.Group();
  scene.add(pivot);

  var mixer = null;
  var actions = {};
  var current = null;

  var x = 0;                // world X of the pivot
  var minX = -1, maxX = 1;
  var facing = 0;           // current rotation.y
  var facingTarget = 0;
  var speed = 0;            // world units/second, this frame
  var lastScrollAt = -1e9;
  var turning = false;      // an edge Jump is in flight
  var turnT = 0;            // seconds into the hop
  var turnDur = 0.7;        // length of the Jump clip
  var turnFromX = 0, turnToX = 0;
  var turnFromFacing = 0, turnToFacing = 0;
  var bodyHalf = T.bodyHalfGuess;   // half his on-screen width, measured at load

  /* --- the route -----------------------------------------------------------
     One complete edge-to-edge walk per panel. `bounds[i]` is the scroll
     position at which panel i takes over; direction alternates with the
     panel index, so panel 0 walks him left-to-right, panel 1 right-to-left,
     and so on. Because consecutive panels start where the previous one
     finished, the whole route is continuous — he never teleports. */
  var sectionEls = [];
  var bounds = [];
  var maxScrollY = 1;
  var sectionIndex = 0;
  var hopGuardUntil = 0;    // see the note in follow()
  var scrollVel = 0;        // px/second, smoothed — decides if a hop is affordable
  var lastYSeen = null;

  var running = false;
  var rafId = 0;
  var lastFrame = 0;
  var disposed = false;
  var idleFrameToggle = false;

  var resolveReady, rejectReady;
  var ready = new Promise(function (res, rej) { resolveReady = res; rejectReady = rej; });

  /* --- layout ------------------------------------------------------------ */
  function layout() {
    /* The canvas is width:100% of the viewport, which excludes the classic
       scrollbar — window.innerWidth includes it. Using innerWidth here would
       stretch the render by the scrollbar's width and put the world-to-screen
       mapping out by the same amount. */
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvasHeight;
    var aspect = w / h;
    var halfW = (T.viewHeight * aspect) / 2;

    camera.left = -halfW;
    camera.right = halfW;
    camera.top = T.viewHeight - T.groundPad;
    camera.bottom = -T.groundPad;
    camera.updateProjectionMatrix();

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, w < 1024 ? 1.5 : 2));
    renderer.setSize(w, h, false);

    /* Clamp on his silhouette, not his origin: an origin-only clamp lets half
       the robot hang off the edge of the screen. */
    var margin = bodyHalf + T.edgeGap;
    minX = -halfW + margin;
    maxX = halfW - margin;
    if (minX > maxX) minX = maxX = 0;
    x = clamp(x, minX, maxX);

    measureRoute();
  }

  /* Panel i owns the scroll from the moment its top crosses the middle of the
     viewport until the next panel's top does. That makes the ranges
     contiguous and non-overlapping — every scroll position belongs to exactly
     one panel, which is what lets the target be a pure function of scrollY
     rather than something accumulated (and therefore driftable). */
  function measureRoute() {
    var vh = window.innerHeight;
    maxScrollY = Math.max(
      (document.documentElement.scrollHeight || 0) - vh, 1
    );

    bounds = [];
    for (var i = 0; i < sectionEls.length; i++) {
      var el = sectionEls[i];
      if (!el || !el.getBoundingClientRect) continue;
      var top = el.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0);
      var b = clamp(top - vh / 2, 0, maxScrollY);
      /* Keep it strictly increasing: panels shorter than half a viewport
         would otherwise produce a zero-width range and a divide-by-zero. */
      if (bounds.length && b <= bounds[bounds.length - 1]) continue;
      bounds.push(b);
    }

    /* No panels supplied (or none usable): treat the whole document as one
       panel, which degrades to a single traversal across the page. */
    if (!bounds.length) bounds = [0];
  }

  function setSections(list) {
    if (typeof list === "string") {
      list = Array.prototype.slice.call(document.querySelectorAll(list));
    }
    sectionEls = list && list.length ? Array.prototype.slice.call(list) : [];
    measureRoute();
  }

  /* Which panel owns this scroll position, and how far through it we are. */
  function routeAt(y) {
    var i = 0;
    while (i + 1 < bounds.length && y >= bounds[i + 1]) i++;
    var start = bounds[i];
    var end = (i + 1 < bounds.length) ? bounds[i + 1] : maxScrollY;
    var p = end > start ? clamp((y - start) / (end - start), 0, 1) : 0;
    return { index: i, p: p };
  }

  /* The X the scroll position asks for. Alternating direction means panel
     boundaries line up end-to-end, so there is never a jump between them. */
  function routeTarget(r) {
    var span = maxX - minX;
    var p = clamp(r.p / T.arriveAt, 0, 1);
    return (r.index % 2 === 0) ? minX + p * span : maxX - p * span;
  }

  function resize() {
    if (disposed) return;
    canvasHeight = baseHeight();
    canvas.style.height = canvasHeight + "px";
    layout();
    if (!running) renderer.render(scene, camera);
  }

  /* --- animation state machine ------------------------------------------- */
  function play(name, opts) {
    opts = opts || {};
    if (!mixer || !actions[name]) return;
    if (current === name && !opts.force) return;

    var next = actions[name];
    var prev = current ? actions[current] : null;

    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);

    if (ONE_SHOT[name]) {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
    }

    if (prev && prev !== next) {
      next.crossFadeFrom(prev, ONE_SHOT[name] ? T.fadeFast : T.fade, true);
    }
    next.play();

    current = name;
    onState(name);
  }

  /* Walk or run, with hysteresis so a speed hovering on the threshold does
     not flicker between the two clips. */
  function gaitFor(v) {
    if (current === "run") return v > T.runExit ? "run" : "walk";
    return v > T.runEnter ? "run" : "walk";
  }

  function resolveAmbient() {
    return (now() - lastScrollAt) < T.scrollIdleMs ? gaitFor(speed) : "idle";
  }

  function apiSetState(name) {
    if (STATES.indexOf(name) === -1) return;
    play(name, { force: true });
  }

  /* The position itself is read from window.scrollY inside follow(); this
     only marks that the user is still actively scrolling. */
  function notifyScroll() {
    if (reduceMotion || disposed) return;
    lastScrollAt = now();
    if (!turning && current !== "wave" && !isLocomotion(current)) play("walk");
    if (!running) start();
  }

  function onClipFinished(e) {
    if (disposed) return;

    if (turning && e.action === actions.jump) {
      /* The hop itself is driven by turnT in step(); this just lands him
         cleanly on the exact target angle and hands control back. */
      turning = false;
      facing = facingTarget = Math.atan2(Math.sin(turnToFacing), Math.cos(turnToFacing));
      hopGuardUntil = now() + T.hopGuardMs;
      play(resolveAmbient(), { force: true });
      return;
    }

    /* Wave, or a manually-triggered one-shot: settle into the ambient state. */
    play(resolveAmbient(), { force: true });
  }

  function triggerEdgeTurn() {
    if (turning) return;
    turning = true;
    speed = 0;

    turnT = 0;
    turnDur = actions.jump ? actions.jump.getClip().duration : 0.7;

    /* Bounce back off the wall rather than landing on the same spot. */
    var inward = x >= 0 ? -1 : 1;
    turnFromX = x;
    turnToX = clamp(x + inward * T.hopDistance, minX, maxX);

    /* Half a turn, taken in the direction that sweeps him through facing the
       camera — mid-hop you see his face, not his back. The route's own
       parity supplies the new walking direction once he lands. */
    turnFromFacing = facing;
    turnToFacing = facing - Math.sign(facing || 1) * Math.PI;
    facingTarget = turnToFacing;

    play("jump", { force: true });
  }

  /* Would the Jump clip fit inside a sensible slice of this panel, at the
     rate the user is currently scrolling? */
  function canAffordHop(index) {
    if (!actions.jump) return false;
    if (scrollVel < 1) return true;          // barely moving: all the time in the world
    var from = bounds[index];
    var to = (index + 1 < bounds.length) ? bounds[index + 1] : maxScrollY;
    var panelSeconds = Math.abs(to - from) / scrollVel;
    return actions.jump.getClip().duration < panelSeconds * T.hopBudget;
  }

  /* Walk toward the X the current panel's scroll progress asks for. */
  function follow(dt) {
    var y = window.scrollY || window.pageYOffset || 0;
    var r = routeAt(y);
    var target = routeTarget(r);

    if (lastYSeen === null) lastYSeen = y;
    var instVel = dt > 0 ? Math.abs(y - lastYSeen) / dt : 0;
    lastYSeen = y;
    scrollVel += (instVel - scrollVel) * clamp(dt * 6, 0, 1);

    /* A panel change at an edge is the moment to hop and turn around —
       provided this panel is going by slowly enough to spare the time. */
    if (r.index !== sectionIndex) {
      var atEdge = (x - minX) < T.turnWindow || (maxX - x) < T.turnWindow;
      sectionIndex = r.index;
      if (atEdge && actions.jump && canAffordHop(r.index)) {
        triggerEdgeTurn();
        return;
      }
    }

    var scrolling = (now() - lastScrollAt) < T.scrollIdleMs;
    var dx = target - x;

    /* Just after a hop he stands a little inside the edge while the new
       panel's target still sits on it. Without this the target would walk
       him briefly backwards into the wall he just bounced off. */
    if (now() < hopGuardUntil) {
      var inward = x >= 0 ? -1 : 1;
      if (dx * inward < 0) dx = 0;
    }

    var chase = scrolling ? T.followRate : T.followRateSettling;
    var move = dx * (1 - Math.exp(-dt * chase));

    var maxStep = T.maxSpeed * dt;
    if (Math.abs(move) > maxStep) move = Math.sign(move) * maxStep;

    var eps = (maxX - minX) * 1e-3;

    if (Math.abs(move) > 1e-5) {
      x = clamp(x + move, minX, maxX);
      facingTarget = move > 0 ? HALF_PI : -HALF_PI;
    }

    speed = dt > 0 ? Math.abs(move) / dt : 0;

    /* Rule (d): stopped scrolling and standing where he was asked to be. */
    if (!scrolling && Math.abs(dx) < eps) {
      speed = 0;
      if (current !== "idle") play("idle");
    } else {
      var gait = gaitFor(speed);
      if (current !== gait) play(gait);
    }
  }

  function setStride(name, ref, range) {
    var a = actions[name];
    if (!a) return;
    a.setEffectiveTimeScale(
      current === name ? clamp(speed / ref, range[0], range[1]) : 1
    );
  }

  /* --- per-frame --------------------------------------------------------- */
  function step(dt) {
    if (!mixer) return;

    if (!turning && current !== "wave") {
      follow(dt);
    } else if (turning) {
      /* The Jump clip has no root motion, so the travel and the spin are
         scripted here against the clip's own duration. */
      turnT += dt;
      var u = clamp(turnT / turnDur, 0, 1);
      x = turnFromX + (turnToX - turnFromX) * smoothstep(u);

      /* Spin only across the airborne stretch of the clip — he crouches
         first and lands square, so rotating through the whole thing would
         have him pirouetting on the floor. */
      facing = turnFromFacing +
        (turnToFacing - turnFromFacing) * smoothstep(clamp((u - 0.2) / 0.55, 0, 1));

      speed = 0;
    } else {
      speed = 0;
    }

    /* Stride follows velocity, so the feet stay planted at any speed. */
    setStride("walk", T.refSpeedWalk, T.walkRateRange);
    setStride("run", T.refSpeedRun, T.runRateRange);

    if (!turning) {
      facing = angleTowards(facing, facingTarget, T.turnRate * dt);

      /* Fold the angle back into (-pi, pi] once a turn completes, so repeated
         turnarounds don't wind the number up indefinitely. Doing it only on
         completion keeps the in-flight rotation from jumping. */
      if (facing === facingTarget) {
        facing = facingTarget = Math.atan2(Math.sin(facing), Math.cos(facing));
      }
    }

    pivot.position.x = x;
    pivot.rotation.y = facing;
    glow.position.x = x;

    mixer.update(dt);
  }

  function tick() {
    if (!running) return;
    rafId = requestAnimationFrame(tick);

    var t = now();
    var dt = Math.min((t - lastFrame) / 1000, 0.05);
    if (dt <= 0) return;

    /* Standing idle is visually near-static, so halve its frame rate. That
       gives back roughly half the GPU time during the long stretches where
       the user is reading rather than scrolling. */
    if (current === "idle" && !turning) {
      idleFrameToggle = !idleFrameToggle;
      if (idleFrameToggle) return;
    }

    lastFrame = t;
    step(dt);
    renderer.render(scene, camera);
  }

  function start() {
    if (running || disposed || reduceMotion || !mixer) return;
    /* A page can *load* into a background tab, in which case no
       visibilitychange ever fires — check the flag directly too. */
    if (document.hidden) return;
    running = true;
    lastFrame = now();
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function onVisibility() {
    if (document.hidden) stop();
    else if (!reduceMotion) start();
  }
  document.addEventListener("visibilitychange", onVisibility);

  function onResize() { resize(); }
  window.addEventListener("resize", onResize, { passive: true });

  /* A lost context is recoverable in principle, but a silently black canvas
     is worse than no canvas — stop the loop and let the page carry on. */
  canvas.addEventListener("webglcontextlost", function (e) {
    e.preventDefault();
    stop();
  });

  /* --- load -------------------------------------------------------------- */
  if (options.sections) setSections(options.sections);
  layout();

  new GLTFLoader().load(
    modelUrl,
    function (gltf) {
      if (disposed) return;

      root = gltf.scene;

      root.traverse(function (o) {
        if (o.isMesh) {
          o.castShadow = false;
          o.receiveShadow = false;
          o.frustumCulled = false;
        }
      });

      pivot.add(root);

      mixer = new THREE.AnimationMixer(root);
      mixer.addEventListener("finished", onClipFinished);

      var available = gltf.animations.map(function (c) { return c.name; });
      Object.keys(CLIPS).forEach(function (key) {
        var clip = THREE.AnimationClip.findByName(gltf.animations, CLIPS[key]);
        if (clip) actions[key] = mixer.clipAction(clip);
      });
      if (!actions.idle) {
        rejectReady(new Error("Idle clip missing from " + modelUrl));
        return;
      }

      /* Pose him before measuring — see measurePosed() for why the rest pose
         is useless here. Idle is settled a fraction of a second in. */
      actions.idle.reset().play();
      mixer.update(0.4);
      scene.updateMatrixWorld(true);

      var box = measurePosed(root);
      var height = box.max.y - box.min.y;
      if (!(height > 0.5 && height < 200)) height = T.fallbackHeight;
      root.scale.setScalar(T.robotHeight / height);

      /* Re-measure at the new scale, then drop him so his feet sit on y = 0
         and his mass is centred on the pivot's X. */
      scene.updateMatrixWorld(true);
      box = measurePosed(root);
      root.position.x -= (box.min.x + box.max.x) / 2;
      root.position.z -= (box.min.z + box.max.z) / 2;
      root.position.y -= box.min.y;

      /* He turns side-on to walk, so his on-screen width is his X extent
         facing the viewer and his Z extent in profile. Clamp against the
         larger of the two and the silhouette never crosses the edge. */
      bodyHalf = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
      layout();

      /* Rewind the measuring pose so the greeting starts from a clean slate. */
      actions.idle.stop();
      current = null;

      /* Park at the left edge, facing the viewer for the greeting wave. */
      x = minX;
      facing = facingTarget = 0;
      pivot.position.x = x;
      glow.position.x = x;

      if (reduceMotion) {
        /* Standing idle, one frame, no loop, no scroll response. */
        play("idle", { force: true });
        mixer.update(0.4);
        pivot.rotation.y = 0;
        renderer.render(scene, camera);
      } else {
        play("wave", { force: true });
        start();
      }

      resolveReady({
        clips: available,
        wired: Object.keys(actions),
        modelUrl: modelUrl,
        triangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.calls,
        reduceMotion: reduceMotion
      });
    },
    undefined,
    function (err) {
      rejectReady(err instanceof Error ? err : new Error("failed to load " + modelUrl));
    }
  );

  /* --- public ------------------------------------------------------------ */
  return {
    ready: ready,
    canvas: canvas,
    setState: apiSetState,
    notifyScroll: notifyScroll,
    resolveAmbient: resolveAmbient,
    getState: function () { return current; },
    isRunning: function () { return running; },
    resize: resize,

    setSections: setSections,

    debug: function () {
      var r = routeAt(window.scrollY || window.pageYOffset || 0);
      return {
        state: current,
        x: x, minX: minX, maxX: maxX,
        halfW: camera.right, bodyHalf: bodyHalf,
        panel: r.index,
        panels: bounds.length,
        panelProgress: r.p,
        target: routeTarget(r),
        facing: facing,
        facingTarget: facingTarget,
        speed: speed,
        turning: turning,
        gait: isLocomotion(current) ? current : null,
        stride: (isLocomotion(current) && actions[current])
          ? actions[current].getEffectiveTimeScale() : 0,
        running: running,
        scrolling: (now() - lastScrollAt) < T.scrollIdleMs,
        triangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.calls
      };
    },

    /* Test seams for the isolation lab: drive position and scroll budget
       directly, without having to fake a real scroll event. */
    _place: function (worldX, dir) {
      x = clamp(worldX, minX, maxX);
      if (typeof dir === "number") facing = facingTarget = dir;
      pivot.position.x = x;
      glow.position.x = x;
    },
    /* Pretend the user just scrolled, without needing a real scroll event —
       the lab drives the route from here. */
    _markScrolling: function () {
      lastScrollAt = now();
      if (!turning && current !== "wave" && !isLocomotion(current)) play("walk");
      if (!running) start();
    },
    _route: function (y) { var r = routeAt(y); return { index: r.index, p: r.p, target: routeTarget(r) }; },
    _bounds: function () { return bounds.slice(); },

    /* Advance one frame by hand, independent of requestAnimationFrame. The
       isolation lab uses this to step the whole state machine on a fake
       clock — deterministic, and it still works in a background tab where
       rAF is suspended. `capture` reads the framebuffer back as a PNG,
       which has to happen in this same task, before the buffer is cleared. */
    _advance: function (dt, opts) {
      if (!mixer || disposed) return null;
      step(dt);
      renderer.render(scene, camera);
      return opts && opts.capture ? canvas.toDataURL("image/png") : null;
    },

    dispose: function () {
      disposed = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      if (mixer) {
        mixer.removeEventListener("finished", onClipFinished);
        mixer.stopAllAction();
      }
      scene.traverse(function (o) {
        if (o.isMesh) {
          if (o.geometry) o.geometry.dispose();
          var m = o.material;
          (Array.isArray(m) ? m : [m]).forEach(function (mm) {
            if (mm && mm.dispose) mm.dispose();
          });
        }
      });
      glowTex.dispose();
      renderer.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }
  };
}

/* -------------------------------------------------------------------------
   Page wiring. Kept here rather than in site.js so the whole companion is
   one import: a page adds a single module script and gets the behaviour.
   ------------------------------------------------------------------------- */
export function mountCompanion(opts) {
  opts = opts || {};

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var warn = function (why) {
    if (window.console) console.warn("[companion] not mounted — " + why);
  };

  /* Opened straight off disk: ES modules and the .glb fetch are both blocked
     by the file:// origin, so fail with an explanation rather than a wall of
     CORS errors. */
  if (location.protocol === "file:") {
    warn("the page is open over file://. Serve it over http (any static " +
         "server will do) — modules and the model cannot load from disk.");
    return null;
  }

  /* Small screens: the canvas is a full-width GPU surface composited on every
     scroll frame, which is exactly where a mid-range phone can least afford
     it. Below this width we don't create it at all. */
  var minWidth = opts.minWidth || 700;
  if (window.innerWidth < minWidth) {
    warn("viewport is " + window.innerWidth + "px, below the " + minWidth +
         "px threshold (disabled on small screens for scroll performance).");
    return null;
  }

  var companion = createCompanion({
    reduceMotion: reduceMotion,
    onState: opts.onState,
    /* Each of these gets one complete edge-to-edge walk. */
    sections: opts.sections || "main > section"
  });

  companion.ready.catch(function (err) {
    if (window.console) console.warn("[companion] unavailable:", err.message);
    companion.dispose();
  });

  if (!reduceMotion) {
    window.addEventListener("scroll", function () {
      companion.notifyScroll();
    }, { passive: true });

    /* Images and fonts landing after load change where the panels sit, and
       the route is measured from their offsets. */
    window.addEventListener("load", function () { companion.setSections(opts.sections || "main > section"); });
  }

  return companion;
}
