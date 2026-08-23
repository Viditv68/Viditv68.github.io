/* =========================================================================
   Scroll companion — a clothed rider on a bicycle, built procedurally.

   No external model file, no loader, no accounts: the whole rig is authored
   here out of low-poly primitives (~2.5k triangles) and animated in code.

   That choice buys one thing a downloaded motion-capture clip could not.
   Mixamo has no "riding a bike" animation, so the usual approach is to sit
   a character still and let the bike's own pedal animation spin underneath
   — the legs never actually match the cranks. Here the feet are SOLVED from
   the crank position every frame with two-bone IK, so the legs genuinely
   pump in sync with the pedals, and the knees bend the right way, always.

   Exposes the same small API the site wires into:
     ready / setState / notifyScroll / getState / resolveAmbient /
     isRunning / resize / dispose
   ========================================================================= */
import * as THREE from "three";

export const STATES = ["idle", "riding", "react"];

/* Electric blue / violet, to sit inside the site palette. */
/* Near-side limbs use the bright tone and far-side limbs a darker one. That
   single trick is what stops the two legs and two arms from collapsing into
   one unreadable silhouette at the small size this is actually displayed. */
export const PALETTE = {
  frame:     0x2f7bff,
  frameDeep: 0x1b2c4e,
  tire:      0x0d1424,
  rim:       0x8b3cff,
  spoke:     0x3a5f96,
  jacket:    0x2f7bff,
  jacketFar: 0x1d4fa6,
  hood:      0x1b3f8f,
  pants:     0x5a3fa8,
  pantsFar:  0x3a2870,
  shoe:      0x0e1729,
  skin:      0xd7a98a,
  skinFar:   0xa8836a,
  glass:     0x060a12,
  glow:      0x00e5ff
};

/* Rig proportions, in metres, measured in the XY plane (side-on view).
   The numbers matter: they are tuned so every IK chain stays reachable
   through a full crank revolution without the limbs ever snapping
   straight or the foot tearing off the pedal. */
const G = {
  bb:        [0.00, 0.30],   // bottom bracket / crank centre
  crankR:    0.15,
  rearAxle:  [-0.52, 0.34],
  frontAxle: [0.55, 0.34],
  saddle:    [-0.26, 0.86],
  headTube:  [0.46, 0.92],
  grip:      [0.50, 0.96],
  wheelR:    0.34,

  hip:       [-0.22, 0.94],
  torsoLen:  0.52,
  lean:      42 * Math.PI / 180,
  thigh:     0.42,
  shin:      0.44,
  upperArm:  0.27,
  forearm:   0.27,
  headR:     0.125,

  zNear:     0.10,           // near-side limbs (toward camera)
  zFar:     -0.10
};

const SCROLL_IDLE_MS = 180;  // no scroll event for this long => stopped
const REACT_MS       = 1550; // one-shot wave duration

/* ---------- small helpers ------------------------------------------------ */

function mat(color, opts) {
  opts = opts || {};
  return new THREE.MeshStandardMaterial({
    color: color,
    metalness: opts.metalness !== undefined ? opts.metalness : 0.25,
    roughness: opts.roughness !== undefined ? opts.roughness : 0.62,
    emissive: opts.emissive !== undefined ? opts.emissive : 0x000000,
    emissiveIntensity: opts.emissiveIntensity !== undefined ? opts.emissiveIntensity : 1
  });
}

/* A tube/limb of fixed length, origin at its CENTRE and axis along +Y.
   Everything in the rig is placed with place() below, so one orientation
   convention covers static frame tubes and animated limbs alike. */
function rod(length, radius, material, radialSegments) {
  var g = new THREE.CylinderGeometry(radius, radius, length, radialSegments || 8, 1);
  return new THREE.Mesh(g, material);
}

/* Same convention, but tapered: rTop is the end that place() aims at the
   target. Limbs that taper toward the joint read as anatomy rather than
   plumbing at this poly count. */
function taper(length, rBottom, rTop, material, radialSegments) {
  var g = new THREE.CylinderGeometry(rTop, rBottom, length, radialSegments || 8, 1);
  return new THREE.Mesh(g, material);
}

function ball(radius, material, seg) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, seg || 10, seg || 8), material);
}

/* Span a mesh between two 2D points at depth z.
   A +Y-axis cylinder rotated by phi points along (-sin phi, cos phi), so
   aiming it at (dx, dy) means phi = atan2(-dx, dy). */
function place(mesh, ax, ay, bx, by, z) {
  var dx = bx - ax;
  var dy = by - ay;
  mesh.position.set((ax + bx) / 2, (ay + by) / 2, z || 0);
  mesh.rotation.z = Math.atan2(-dx, dy);
}

/* Two-bone IK in the XY plane.

   Returns the joint (knee/elbow) position for a chain of lengths l1, l2
   running from root to target. The bias vector picks which of the two
   mirrored solutions to use — knees forward, elbows down — by taking
   whichever bend direction points more along it. Without that the solver
   flips the joint inside-out as the chain crosses full extension. */
var _ik = { x: 0, y: 0 };
function solveIK(rx, ry, tx, ty, l1, l2, biasX, biasY) {
  var dx = tx - rx;
  var dy = ty - ry;
  var d = Math.sqrt(dx * dx + dy * dy);

  // Clamp just inside the reachable annulus so the sqrt below stays real
  // and the limb never locks dead straight.
  var min = Math.abs(l1 - l2) + 1e-4;
  var max = l1 + l2 - 1e-4;
  if (d > max) {
    var sOut = max / d;
    dx *= sOut; dy *= sOut; d = max;
  }
  if (d < min) {
    var sIn = min / (d || 1e-6);
    dx *= sIn; dy *= sIn; d = min;
  }

  var ux = dx / d;
  var uy = dy / d;

  var a = (d * d + l1 * l1 - l2 * l2) / (2 * d);
  var hSq = l1 * l1 - a * a;
  var h = hSq > 0 ? Math.sqrt(hSq) : 0;

  // The two perpendiculars to u; keep the one agreeing with the bias.
  var nx = uy;
  var ny = -ux;
  if (nx * biasX + ny * biasY < 0) { nx = -nx; ny = -ny; }

  _ik.x = rx + ux * a + nx * h;
  _ik.y = ry + uy * a + ny * h;
  return _ik;
}

function lerp(a, b, t) { return a + (b - a) * t; }

/* ---------- rig ---------------------------------------------------------- */

/* Builds the rig and returns every part the animator needs to move.
   Exported so the lab harness can inspect and screenshot it without
   starting a render loop. */
export function buildRig() {
  var root = new THREE.Group();

  var mFrame  = mat(PALETTE.frame,     { metalness: 0.55, roughness: 0.35 });
  var mDeep   = mat(PALETTE.frameDeep, { metalness: 0.60, roughness: 0.40 });
  var mTire   = mat(PALETTE.tire,      { metalness: 0.10, roughness: 0.85 });
  var mRim    = mat(PALETTE.rim,       { metalness: 0.70, roughness: 0.28,
                                         emissive: PALETTE.rim, emissiveIntensity: 0.35 });
  var mSpoke  = mat(PALETTE.spoke,     { metalness: 0.60, roughness: 0.40 });
  var mJacket = mat(PALETTE.jacket,    { metalness: 0.05, roughness: 0.78 });
  var mHood   = mat(PALETTE.hood,      { metalness: 0.05, roughness: 0.80 });
  var mShoe   = mat(PALETTE.shoe,      { metalness: 0.15, roughness: 0.70 });
  var mSkin   = mat(PALETTE.skin,      { metalness: 0.00, roughness: 0.72 });
  var mGlass  = mat(PALETTE.glass,     { metalness: 0.85, roughness: 0.12,
                                         emissive: PALETTE.glow, emissiveIntensity: 0.22 });

  // One material bundle per side; the far side is uniformly darker so the
  // two legs and two arms stay legible as separate limbs.
  var SIDE = {
    near: {
      pants: mat(PALETTE.pants,    { metalness: 0.05, roughness: 0.85 }),
      arm:   mat(PALETTE.jacket,   { metalness: 0.05, roughness: 0.78 }),
      skin:  mSkin,
      shoe:  mShoe
    },
    far: {
      pants: mat(PALETTE.pantsFar, { metalness: 0.05, roughness: 0.85 }),
      arm:   mat(PALETTE.jacketFar,{ metalness: 0.05, roughness: 0.78 }),
      skin:  mat(PALETTE.skinFar,  { metalness: 0.00, roughness: 0.72 }),
      shoe:  mat(PALETTE.shoe,     { metalness: 0.15, roughness: 0.85 })
    }
  };

  /* --- bike: frame tubes ------------------------------------------------ */
  var bike = new THREE.Group();
  root.add(bike);

  function tube(a, b, r, m) {
    var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    var mesh = rod(len, r, m, 7);
    place(mesh, a[0], a[1], b[0], b[1], 0);
    bike.add(mesh);
    return mesh;
  }

  tube(G.rearAxle,  G.bb,        0.019, mFrame); // chainstay
  tube(G.rearAxle,  G.saddle,    0.017, mFrame); // seatstay
  tube(G.bb,        G.saddle,    0.021, mFrame); // seat tube
  tube(G.saddle,    G.headTube,  0.021, mFrame); // top tube
  tube(G.bb,        G.headTube,  0.023, mFrame); // down tube
  tube(G.headTube,  G.frontAxle, 0.018, mDeep);  // fork
  tube(G.headTube,  G.grip,      0.016, mDeep);  // stem to bar

  // saddle + handlebar crossbar (given depth in Z so they read as 3D)
  var seat = new THREE.Mesh(new THREE.BoxGeometry(0.155, 0.032, 0.085), mDeep);
  seat.position.set(G.saddle[0] - 0.005, G.saddle[1] + 0.032, 0);
  seat.rotation.z = -0.10;
  bike.add(seat);

  var bar = rod(0.30, 0.016, mDeep, 7);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(G.grip[0], G.grip[1], 0);
  bike.add(bar);

  /* --- bike: wheels ----------------------------------------------------- */
  function wheel(cx, cy) {
    var g = new THREE.Group();
    g.position.set(cx, cy, 0);

    g.add(new THREE.Mesh(new THREE.TorusGeometry(G.wheelR, 0.032, 6, 22), mTire));
    g.add(new THREE.Mesh(new THREE.TorusGeometry(G.wheelR - 0.045, 0.012, 5, 22), mRim));

    // A token set of spokes — enough to read as motion when it spins,
    // cheap enough not to matter.
    for (var i = 0; i < 6; i++) {
      var sp = rod((G.wheelR - 0.05) * 2, 0.005, mSpoke, 4);
      sp.rotation.z = (i / 6) * Math.PI;
      g.add(sp);
    }

    var hub = rod(0.06, 0.028, mDeep, 7);
    hub.rotation.x = Math.PI / 2;
    g.add(hub);

    bike.add(g);
    return g;
  }

  var wheelRear  = wheel(G.rearAxle[0], G.rearAxle[1]);
  var wheelFront = wheel(G.frontAxle[0], G.frontAxle[1]);

  /* --- bike: crank + pedals --------------------------------------------- */
  var chainring = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.010, 5, 18), mRim);
  chainring.position.set(G.bb[0], G.bb[1], 0);
  bike.add(chainring);

  var crank = new THREE.Group();
  crank.position.set(G.bb[0], G.bb[1], 0);
  bike.add(crank);

  var pedals = [];
  for (var s = 0; s < 2; s++) {
    var z = s === 0 ? G.zNear : G.zFar;

    // The arm runs outward along +Y in its own space; shifting it up by
    // half its length puts the pedal end at radius crankR.
    var arm = rod(G.crankR, 0.016, mDeep, 6);
    arm.position.set(0, G.crankR / 2, z);

    var armPivot = new THREE.Group();
    armPivot.add(arm);
    armPivot.rotation.z = s === 0 ? 0 : Math.PI; // 180 degrees out of phase
    crank.add(armPivot);

    var pedal = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.022, 0.055), mDeep);
    bike.add(pedal);
    pedals.push(pedal);
  }

  /* --- rider ------------------------------------------------------------- */
  var rider = new THREE.Group();
  root.add(rider);

  // Far limbs first, then the body, then near limbs — so the draw order
  // alone gives correct overlap without leaning on the depth buffer at
  // these near-coplanar depths.
  function limbSet(z, m) {
    var set = {
      z:        z,
      thigh:    taper(G.thigh,    0.072, 0.052, m.pants, 7),
      shin:     taper(G.shin,     0.050, 0.036, m.pants, 7),
      foot:     new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.048, 0.062), m.shoe),
      upperArm: taper(G.upperArm, 0.052, 0.040, m.arm, 7),
      forearm:  taper(G.forearm,  0.040, 0.030, m.arm, 7),
      hand:     ball(0.042, m.skin, 8),
      knee:     ball(0.050, m.pants, 8),
      elbow:    ball(0.040, m.arm, 8)
    };
    rider.add(set.thigh, set.knee, set.shin, set.foot,
              set.upperArm, set.elbow, set.forearm, set.hand);
    return set;
  }

  var far = limbSet(G.zFar, SIDE.far);

  // Pelvis anchors the hip end of the torso; without it the cylinder's flat
  // cap reads as a wedge sticking out behind the saddle.
  var pelvis = ball(0.088, SIDE.near.pants, 10);
  rider.add(pelvis);

  // Torso tapers out toward the shoulders.
  var torso = taper(G.torsoLen, 0.078, 0.100, mJacket, 10);
  rider.add(torso);

  // A hood bunched at the shoulders, so he reads as clothed from any angle.
  var hood = ball(0.104, mHood, 12);
  rider.add(hood);

  var neck = rod(0.09, 0.040, mSkin, 7);
  rider.add(neck);

  var head = ball(G.headR, mSkin, 14);
  rider.add(head);

  // Beanie: a cap over the top and back of the skull, leaving the face.
  var cap = new THREE.Mesh(
    new THREE.SphereGeometry(G.headR + 0.014, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.50),
    mHood);
  rider.add(cap);

  // Sunglasses: a wraparound lens bar across the face plus temple arms.
  var glasses = new THREE.Group();

  var lens = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.038, 0.168), mGlass);
  glasses.add(lens);

  // A slight wrap: two angled outer lenses so it is not a flat slab.
  [1, -1].forEach(function (s) {
    var wrap = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.036, 0.050), mGlass);
    wrap.position.set(-0.013, 0, s * 0.096);
    wrap.rotation.y = s * 0.55;
    glasses.add(wrap);
  });

  [1, -1].forEach(function (s) {
    var temple = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.012, 0.011), mGlass);
    temple.position.set(-0.075, 0.014, s * 0.098);
    glasses.add(temple);
  });

  rider.add(glasses);

  var near = limbSet(G.zNear, SIDE.near);

  return {
    root: root, bike: bike, rider: rider,
    wheelRear: wheelRear, wheelFront: wheelFront,
    crank: crank, pedals: pedals, chainring: chainring,
    pelvis: pelvis, torso: torso, hood: hood, neck: neck,
    head: head, cap: cap, glasses: glasses,
    near: near, far: far
  };
}

/* ---------- animation ---------------------------------------------------- */

/* Poses the whole rig for a given crank angle and blend weights. A pure
   function of its inputs — no easing state — so the caller owns timing and
   this can be driven to an exact frame for tests or screenshots. */
export function poseRig(rig, opts) {
  var crankAngle = opts.crankAngle || 0;
  var speed      = opts.speed || 0;   // 0 idle .. 1 riding
  var wave       = opts.wave || 0;    // 0 hands on bars .. 1 waving
  var waveT      = opts.waveT || 0;
  var breath     = opts.breath || 0;

  /* --- bike ------------------------------------------------------------- */
  rig.crank.rotation.z = crankAngle;
  // Wheels turn faster than the cranks, as a real drivetrain would.
  rig.wheelRear.rotation.z  = -crankAngle * 2.2;
  rig.wheelFront.rotation.z = -crankAngle * 2.2;

  // Pedal bodies orbit the bottom bracket but stay level, like real pedals.
  for (var s = 0; s < 2; s++) {
    var a = crankAngle + (s === 0 ? 0 : Math.PI);
    rig.pedals[s].position.set(
      G.bb[0] - Math.sin(a) * G.crankR,
      G.bb[1] + Math.cos(a) * G.crankR,
      s === 0 ? G.zNear : G.zFar
    );
    rig.pedals[s].rotation.z = 0;
  }

  /* --- body ------------------------------------------------------------- */
  // The rider rocks very slightly with each pedal stroke, and tucks lower
  // the faster he goes.
  var bob  = Math.sin(crankAngle * 2) * 0.014 * speed;
  var lean = G.lean + speed * 0.09 + breath * 0.012;

  var hipX = G.hip[0];
  var hipY = G.hip[1] + bob;

  var shX = hipX + Math.sin(lean) * G.torsoLen;
  var shY = hipY + Math.cos(lean) * G.torsoLen;

  rig.pelvis.position.set(hipX, hipY, 0);
  place(rig.torso, hipX, hipY, shX, shY, 0);
  rig.hood.position.set(shX, shY, 0);

  // Head sits forward of the shoulders, looking up the road.
  var headX = shX + 0.072;
  var headY = shY + 0.190;
  place(rig.neck, shX, shY, headX, headY, 0);
  rig.head.position.set(headX, headY, 0);

  // Tip the beanie back off the brow rather than sitting it level.
  rig.cap.position.set(headX - 0.026, headY + 0.002, 0);
  rig.cap.rotation.z = 0.66;

  rig.glasses.position.set(headX + 0.100, headY + 0.004, 0);
  rig.glasses.rotation.z = -0.10;

  /* --- legs: the feet are driven BY the cranks --------------------------- */
  var sides = [rig.near, rig.far];
  for (var i = 0; i < 2; i++) {
    var side = sides[i];
    var ang = crankAngle + (i === 0 ? 0 : Math.PI);
    var fx = G.bb[0] - Math.sin(ang) * G.crankR;
    var fy = G.bb[1] + Math.cos(ang) * G.crankR;

    var ay = fy + 0.055; // ankle rides just above the pedal spindle

    var knee = solveIK(hipX, hipY, fx, ay, G.thigh, G.shin, 1, 0);
    var kx = knee.x, ky = knee.y;

    place(side.thigh, hipX, hipY, kx, ky, side.z);
    place(side.shin,  kx, ky, fx, ay, side.z);
    side.knee.position.set(kx, ky, side.z);
    side.foot.position.set(fx + 0.012, ay - 0.015, side.z);
    side.foot.rotation.z = -0.08;
  }

  /* --- arms: near arm lifts to wave, far arm stays on the bar ------------ */
  for (var j = 0; j < 2; j++) {
    var sd = sides[j];

    var hx = G.grip[0];
    var hy = G.grip[1];

    if (j === 0 && wave > 0) {
      // Raised, with a small oscillation so it actually reads as a wave.
      var swing = Math.sin(waveT * 13) * 0.085;
      hx = lerp(G.grip[0], shX + 0.20 + swing, wave);
      hy = lerp(G.grip[1], shY + 0.40, wave);
    }

    var elbow = solveIK(shX, shY, hx, hy, G.upperArm, G.forearm, 0, -1);
    var ex = elbow.x, ey = elbow.y;

    place(sd.upperArm, shX, shY, ex, ey, sd.z);
    place(sd.forearm,  ex, ey, hx, hy, sd.z);
    sd.elbow.position.set(ex, ey, sd.z);
    sd.hand.position.set(hx, hy, sd.z);
  }
}

/* ---------- public factory ----------------------------------------------- */

export function createCompanion(options) {
  var mount = options.mount;
  var onState = options.onState || function () {};
  var reduceMotion = !!options.reduceMotion;

  /* All timing goes through this one function so tests can supply a fake
     clock and drive the state machine deterministically, instead of
     sleeping and hoping. */
  var now = options.now || function () { return performance.now(); };

  var renderer, scene, camera, clock, rig;
  var current = null;
  var raf = 0;
  var running = false;
  var disposed = false;

  // animation state
  var crankAngle = 0;
  var speed = 0;
  var wave = 0;
  var waveUntil = 0;
  var waveT = 0;
  var lastScrollAt = 0;

  renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "low-power"
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  mount.appendChild(renderer.domElement);
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);

  // Cool key, violet rim, soft sky fill — the same lighting language as
  // the page background.
  var key = new THREE.DirectionalLight(0xbfe9ff, 2.5);
  key.position.set(2.2, 3.4, 3.2);
  scene.add(key);

  var rim = new THREE.DirectionalLight(0xa06bff, 2.4);
  rim.position.set(-2.8, 1.8, -2.4);
  scene.add(rim);

  scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x0b1020, 1.6));

  rig = buildRig();
  scene.add(rig.root);

  // Frame the rig: it spans roughly x -0.9..0.95, y 0..1.75.
  rig.root.position.set(-0.06, -0.86, 0);
  camera.position.set(0.05, 0.06, 3.15);
  camera.lookAt(0.02, -0.02, 0);

  clock = new THREE.Clock();

  function resize() {
    var w = mount.clientWidth || 1;
    var h = mount.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function setCurrent(name) {
    if (current === name) return;
    current = name;
    onState(name);
  }

  function resolveAmbient() {
    return now() - lastScrollAt < SCROLL_IDLE_MS ? "riding" : "idle";
  }

  function api_setState(name) {
    if (reduceMotion) return;
    if (name === "react") {
      waveUntil = now() + REACT_MS;
      waveT = 0;
      setCurrent("react");
    } else if (name === "riding") {
      lastScrollAt = now();
      if (current !== "react") setCurrent("riding");
    } else if (current !== "react") {
      setCurrent("idle");
    }
  }

  function notifyScroll() {
    lastScrollAt = now();
    if (reduceMotion) return;
    if (current !== "react") setCurrent("riding");
  }

  /* One frame of simulation. Split out of the rAF callback so it can be
     stepped by hand with an explicit dt. */
  function step(dt) {
    dt = Math.min(dt, 0.05); // clamp after a stall
    var t = now();

    // The wave is a one-shot overlay: it plays over whatever the scroll
    // state says, then hands control straight back to it.
    var waving = t < waveUntil;
    if (waving) waveT += dt;
    wave += ((waving ? 1 : 0) - wave) * Math.min(1, dt * 7);

    var wantRiding = resolveAmbient() === "riding";
    if (!waving && wave < 0.02) setCurrent(wantRiding ? "riding" : "idle");

    // Ease the road speed rather than snapping, so the legs spin up and
    // coast down instead of stuttering on every scroll event.
    speed += ((wantRiding ? 1 : 0) - speed) * Math.min(1, dt * 3.2);

    // Idle still turns the cranks over very slowly, so he never looks dead.
    crankAngle += dt * (1.15 + speed * 6.2);

    poseRig(rig, {
      crankAngle: crankAngle,
      speed: speed,
      wave: wave,
      waveT: waveT,
      breath: Math.sin(t / 900) * (1 - speed)
    });

    renderer.render(scene, camera);
  }

  function tick() {
    step(clock.getDelta());
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (running || disposed || reduceMotion) return;
    running = true;
    clock.getDelta(); // discard the gap accumulated while paused
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
  }

  function onVisibility() {
    if (document.hidden) stop();
    else start();
  }

  resize();
  poseRig(rig, { crankAngle: 0.9, speed: 0, wave: 0, waveT: 0, breath: 0 });
  renderer.render(scene, camera);
  setCurrent("idle");

  if (!reduceMotion) start();

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);

  // A dropped context must not leave a dead canvas pinned to the viewport.
  renderer.domElement.addEventListener("webglcontextlost", function (e) {
    e.preventDefault();
    stop();
    mount.style.display = "none";
  });

  var ready = Promise.resolve({
    triangles: renderer.info.render.triangles,
    drawCalls: renderer.info.render.calls,
    states: STATES.slice()
  });

  return {
    ready: ready,
    setState: api_setState,
    notifyScroll: notifyScroll,
    getState: function () { return current; },
    resolveAmbient: resolveAmbient,
    isRunning: function () { return running; },
    resize: resize,
    step: step,
    debug: function () {
      return {
        scene: scene, camera: camera, rig: rig, renderer: renderer,
        poseRig: poseRig, G: G,
        read: function () {
          return { speed: speed, wave: wave, crankAngle: crankAngle };
        }
      };
    },
    dispose: function () {
      disposed = true;
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    }
  };
}
