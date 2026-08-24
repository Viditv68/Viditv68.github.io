/* =========================================================================
   Scroll companion — RobotExpressive walking along the bottom of the page.

   Model: RobotExpressive.glb (Tomás Laulhé, CC0 1.0; modifications by Don
   McCurdy). Served from assets/companion/robot.glb rather than hotlinked,
   so the site keeps working if three.js reshuffles its examples folder.
   Every clip we need already lives in that one file — no rigging step.

   He is autonomous: nothing about him is tied to scrolling. He picks a
   random spot along the bottom edge, walks or runs there, turns to face the
   viewer and mulls it over, waits a beat, then picks somewhere new.

   Two details worth knowing before reading the rest.

   ONE — he faces the viewer whenever he is not travelling. Idle, the
   greeting wave and every gesture all square up to camera; only walking and
   running turn him side-on, in the direction he is actually going.

   TWO — the stride is always ground speed over the clip's own reference
   speed, so the feet match the ground at every point of the accelerate /
   cruise / decelerate curve rather than only at full pelt.

   Public API:
     ready / setState / getState / isRunning / resize / dispose / debug
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
  jump: "Jump",
  /* RobotExpressive ships no "Think" clip. Yes and No are a nod and a head
     shake, which are the closest thing in the file to visible deliberation,
     so those two stand in for thinking. */
  yes: "Yes",
  no: "No",
  thumbsUp: "ThumbsUp"
};

export const STATES = ["wave", "idle", "walk", "run", "jump", "yes", "no", "thumbsUp"];

/* Played once on arrival, then he goes back to idling. */
const THINKING = ["yes", "no"];

/* Clips that move him along the ground, as opposed to poses and one-shots. */
function isLocomotion(name) { return name === "walk" || name === "run"; }

/* One-shots hold the floor until their clip finishes, at which point the
   wander loop takes over again. Anything listed here MUST be here — a clip
   played on LoopRepeat never fires "finished", so the loop would stall. */
const ONE_SHOT = {
  wave: true, jump: true, yes: true, no: true, thumbsUp: true
};

const TUNING = {
  viewHeight: 3.2,     // world units visible top-to-bottom in the canvas
  groundPad: 0.14,     // world units of canvas below the robot's feet
  robotHeight: 2.25,   // world units the robot is scaled to occupy
  edgeGap: 0.18,       // clear space between his silhouette and the viewport
  bodyHalfGuess: 0.8,  // stands in for his half-width until the model loads

  /* --- wandering ---------------------------------------------------------
     A trip has to be long enough to be worth watching and short enough not
     to become the main event, so targets are drawn from a band of the lane
     rather than anywhere in it. */
  minTravel: 0.22,     // fraction of the lane, shortest trip he will bother with
  maxTravel: 0.78,     // ...and the longest
  runAbove: 0.46,      // trips longer than this fraction of the lane get a run

  dwellMin: 2600,      // ms of standing about after a gesture, before moving on
  dwellMax: 6200,

  /* What he does on arrival. Weighted by repetition rather than by numbers:
     mostly thinking, with the occasional friendlier beat so he does not read
     as a two-frame loop. Every entry must be a key of CLIPS. */
  gestures: ["yes", "no", "yes", "no", "yes", "no", "thumbsUp", "wave"],

  accelTime: 0.35,     // seconds to reach cruising speed
  easeDist: 1.1,       // world units out from the target that he starts slowing
  arriveEps: 0.05,     // close enough to call it arrived
  crawlFactor: 0.3,    // floor on the deceleration ramp, or he never lands

  /* He squares up before setting off and again before gesturing; movement
     waits until he is roughly pointed the right way. */
  turnedEnough: 0.1,   // radians — squared up to within ~6 degrees

  /* Ground speed, in world units/second, at which each locomotion clip plays
     at rate 1.0. The stride is *always* set to speed / refSpeed, which is
     what keeps the feet matched to the ground. */
  refSpeedWalk: 2.0,
  refSpeedRun: 5.2,

  walkRateRange: [0.3, 1.6],
  runRateRange: [0.6, 1.8],

  fade: 0.25,          // cross-fade seconds between looping clips
  fadeFast: 0.15,      // cross-fade into short one-shots (Jump is 0.71s)
  turnRate: 7,         // radians/second the model swings around

  /* Fallback if measuring the posed model ever returns nonsense. This is the
     assembled height of RobotExpressive in its own units. */
  fallbackHeight: 4.8
};

const HALF_PI = Math.PI / 2;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* Signed shortest-path difference between two angles, in (-pi, pi]. */
function angleDelta(from, to) {
  return ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

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
    setExcited: function () {},
    getPhase: function () { return null; },
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
    /* Above the card spotlight's blur scrim (70) and the spotlit card (80).
       backdrop-filter only blurs what is painted below it, so sitting above
       the scrim is what keeps the robot sharp while the page goes soft. */
    zIndex: "90"
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
  var bodyHalf = T.bodyHalfGuess;   // half his on-screen width, measured at load

  /* --- wandering ----------------------------------------------------------
     phase is the whole behaviour: he squares up, walks somewhere, squares up
     again, thinks about it, stands around, repeats. */
  var phase = "greet";      // greet | turnOut | travel | turnIn | gesture | dwell
  var phaseUntil = 0;       // wall-clock ms, for the timed phases
  var destX = 0;
  var travelGait = "walk";
  var travelT = 0;          // seconds into the current trip, for the accel ramp
  var finishCount = 0;      // one-shots completed; surfaced for diagnostics

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
    destX = clamp(destX, minX, maxX);
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

    /* `loop` deliberately overrides ONE_SHOT: the excited state runs Jump on
       repeat, which is the same clip that is normally fired once. */
    if (ONE_SHOT[name] && !opts.loop) {
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

  /* Manual override, used by the lab. A one-shot hands back to the wander
     loop when it finishes; a looping clip just stays until the loop moves on. */
  function apiSetState(name) {
    if (STATES.indexOf(name) === -1) return;
    if (ONE_SHOT[name]) phase = "gesture";
    play(name, { force: true });
  }

  function pickGesture() {
    var pool = T.gestures || THINKING;
    for (var tries = 0; tries < 6; tries++) {
      var name = pool[(Math.random() * pool.length) | 0];
      if (actions[name]) return name;
    }
    return actions.idle ? "idle" : null;
  }

  /* Choose somewhere new along the bottom edge. Drawn from a band so the trip
     is never a pointless shuffle nor a full-width march every time, and
     mirrored back into the lane when the roll would overshoot. */
  function pickDestination() {
    var span = maxX - minX;
    if (span <= 0.01) return x;

    var dist = span * (T.minTravel + Math.random() * (T.maxTravel - T.minTravel));
    var dir = Math.random() < 0.5 ? -1 : 1;
    var candidate = x + dir * dist;

    if (candidate < minX || candidate > maxX) candidate = x - dir * dist;
    if (candidate < minX || candidate > maxX) {
      /* Both ways overshoot: aim at the roomier side instead. */
      candidate = (x - minX > maxX - x) ? minX : maxX;
    }
    return clamp(candidate, minX, maxX);
  }

  function beginTrip() {
    destX = pickDestination();
    var dist = Math.abs(destX - x);
    travelGait = (dist > (maxX - minX) * T.runAbove && actions.run) ? "run" : "walk";
    travelT = 0;
    facingTarget = (destX > x) ? HALF_PI : -HALF_PI;
    phase = "turnOut";
  }

  function beginDwell() {
    phase = "dwell";
    phaseUntil = now() + T.dwellMin + Math.random() * (T.dwellMax - T.dwellMin);
    facingTarget = 0;
    play("idle");
  }

  /* Both the greeting wave and every arrival gesture are one-shots; whichever
     just ended, he now has nothing to do, so stand about and then move on. */
  function onClipFinished() {
    finishCount++;
    if (disposed) return;
    /* A gesture interrupted by setExcited() keeps playing at falling weight
       and still reports finished. Ignore it, or he would bounce once and
       then wander off mid-spotlight. */
    if (phase === "excited") return;
    beginDwell();
  }

  function facingSettled() {
    return Math.abs(angleDelta(facing, facingTarget)) < T.turnedEnough;
  }

  /* The whole behaviour loop. Nothing here reads scroll position. */
  function wander(dt) {
    switch (phase) {

      case "greet":
        /* Held by the Wave one-shot; onClipFinished moves us on. */
        facingTarget = 0;
        speed = 0;
        break;

      case "dwell":
        facingTarget = 0;
        speed = 0;
        if (current !== "idle") play("idle");
        if (now() >= phaseUntil) beginTrip();
        break;

      case "turnOut":
        /* Step into the turn rather than idling side-on: he is already in
           the locomotion clip, marking time, so setting off is continuous.
           Ground speed stays 0, so the stride ticks over at its slowest. */
        speed = 0;
        if (current !== travelGait) play(travelGait);
        if (facingSettled()) {
          phase = "travel";
          travelT = 0;
        }
        break;

      case "travel":
        travel(dt);
        break;

      case "turnIn":
        /* Back to camera before he says anything. */
        speed = 0;
        facingTarget = 0;
        if (current !== "idle") play("idle");
        if (facingSettled()) {
          var g = pickGesture();
          phase = "gesture";
          if (g && g !== "idle") play(g, { force: true });
          else beginDwell();
        }
        break;

      case "gesture":
        /* Held by the one-shot; onClipFinished moves us on. */
        facingTarget = 0;
        speed = 0;
        break;

      case "excited":
        /* Held until the page lets go of him. Faces the viewer and bounces. */
        facingTarget = 0;
        speed = 0;
        break;
    }
  }

  function travel(dt) {
    var remaining = Math.abs(destX - x);
    if (remaining <= T.arriveEps) {
      x = destX;
      speed = 0;
      phase = "turnIn";
      facingTarget = 0;
      return;
    }

    var dir = destX > x ? 1 : -1;
    var cruise = travelGait === "run" ? T.refSpeedRun : T.refSpeedWalk;

    /* Ease in off the mark and ease out into the destination. Both ramps are
       floored so the tail of the deceleration still actually converges. */
    travelT += dt;
    var accel = clamp(travelT / T.accelTime, T.crawlFactor, 1);
    var decel = clamp(remaining / T.easeDist, T.crawlFactor, 1);
    var v = cruise * Math.min(accel, decel);

    var move = dir * v * dt;
    if (Math.abs(move) >= remaining) {
      x = destX;
    } else {
      x += move;
    }
    x = clamp(x, minX, maxX);

    speed = v;
    facingTarget = dir > 0 ? HALF_PI : -HALF_PI;
    if (current !== travelGait) play(travelGait);
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

    wander(dt);

    /* Stride follows velocity, so the feet stay planted at any speed. */
    setStride("walk", T.refSpeedWalk, T.walkRateRange);
    setStride("run", T.refSpeedRun, T.runRateRange);

    facing = angleTowards(facing, facingTarget, T.turnRate * dt);

    /* Fold the angle back into (-pi, pi] once a turn completes, so repeated
       turns don't wind the number up indefinitely. Doing it only on
       completion keeps the in-flight rotation from jumping. */
    if (facing === facingTarget) {
      facing = facingTarget = Math.atan2(Math.sin(facing), Math.cos(facing));
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
       he is standing about rather than moving. */
    if (current === "idle") {
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
        /* Standing idle, facing the viewer: one frame, no loop, no wandering. */
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

    /* Bounce on the spot, facing the viewer, until told to stop. The page
       uses this while a project card is spotlit. */
    setExcited: function (on) {
      if (reduceMotion || disposed || !mixer) return;
      if (on) {
        if (phase === "excited") return;
        phase = "excited";
        facingTarget = 0;
        play("jump", { force: true, loop: true });
        if (!running) start();
      } else if (phase === "excited") {
        beginDwell();
      }
    },

    getState: function () { return current; },
    getPhase: function () { return phase; },
    isRunning: function () { return running; },
    resize: resize,

    debug: function () {
      return {
        state: current,
        phase: phase,
        x: x, minX: minX, maxX: maxX,
        destX: destX,
        halfW: camera.right, bodyHalf: bodyHalf,
        facing: facing,
        facingTarget: facingTarget,
        facesViewer: Math.abs(angleDelta(facing, 0)) < 0.02,
        speed: speed,
        gait: isLocomotion(current) ? current : null,
        stride: (isLocomotion(current) && actions[current])
          ? actions[current].getEffectiveTimeScale() : 0,
        running: running,
        finishCount: finishCount,
        triangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.calls
      };
    },

    /* Test seams for the isolation lab. */
    _place: function (worldX, dir) {
      x = clamp(worldX, minX, maxX);
      if (typeof dir === "number") facing = facingTarget = dir;
      pivot.position.x = x;
      glow.position.x = x;
    },
    /* Send him somewhere specific instead of waiting for the dice. */
    _goTo: function (worldX) {
      destX = clamp(worldX, minX, maxX);
      var dist = Math.abs(destX - x);
      travelGait = (dist > (maxX - minX) * T.runAbove && actions.run) ? "run" : "walk";
      travelT = 0;
      facingTarget = destX > x ? HALF_PI : -HALF_PI;
      phase = "turnOut";
      if (!running) start();
    },

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

  /* Small screens: the canvas is a full-width GPU surface composited over
     every frame of the page, which is exactly where a mid-range phone can
     least afford it. Below this width we don't create it at all. */
  var minWidth = opts.minWidth || 700;
  if (window.innerWidth < minWidth) {
    warn("viewport is " + window.innerWidth + "px, below the " + minWidth +
         "px threshold (disabled on small screens to protect scrolling).");
    return null;
  }

  var companion = createCompanion({
    reduceMotion: reduceMotion,
    onState: opts.onState
  });

  companion.ready.catch(function (err) {
    if (window.console) console.warn("[companion] unavailable:", err.message);
    companion.dispose();
  });

  /* Deliberately no scroll wiring: he wanders on his own schedule, and the
     page's scroll position is nothing to do with him. */

  return companion;
}
