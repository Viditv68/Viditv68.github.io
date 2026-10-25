/* "Zeph": an original chibi cheetah-cub speedster, built from three.js primitives.
   Cheetah reads come from: the bold dark tear lines, a forward muzzle with a split lip and triangular nose,
   solid round spots, side-set triangular ears with pale "eye spots" on the back, almond amber eyes, and a long
   S-curved tail with dark rings toward a pale glowing tip.
   Kept off-limits: spikes/quills, blue body, red shoes, white gloves, green eyes, foxes.

   makeMascot() returns { root, head, tick(dt, t, yaw, pitch, near, still, vx) }.
   yaw/pitch arrive damped (radians, + = right / down); vx is the smoothed cursor speed, -1..1. */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const COL = {
  fur: 0x4a4268, furDark: 0x2a2440, ink: 0x120e1a, cream: 0xcfc8d9, muzzle: 0xe3dfea, scarf: 0x9a55ff,
  iris: 0xffb547, pupil: 0x07080f, stripe: 0x4f9bff, goggle: 0x8f96b3, lens: 0x63d0ff
};

function canvasTex(w, h, draw) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const glowTex = () => canvasTex(64, 64, (g) => {
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.35, "rgba(120,170,255,.55)"); r.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
});
// a tapered streak: hair-thin and transparent at the left, thick and bright at the right
const streakTex = () => canvasTex(256, 32, (g, w, h) => {
  const lg = g.createLinearGradient(0, 0, w, 0);
  lg.addColorStop(0, "rgba(255,255,255,0)"); lg.addColorStop(0.7, "rgba(255,255,255,.8)"); lg.addColorStop(1, "rgba(255,255,255,1)");
  g.fillStyle = lg; g.filter = "blur(1.5px)";
  g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w - 10, h / 2 - 9); g.quadraticCurveTo(w, h / 2, w - 10, h / 2 + 9); g.closePath(); g.fill();
});

/* Damped spring on one value: x chases target, v carries the overshoot. */
const spring = (s, target, dt, k = 90, d = 9) => { s.v += ((target - s.x) * k - s.v * d) * dt; s.x += s.v * dt; return s.x; };

/* Seeded PRNG so the spot pattern is the same on every load. */
function prng(seed) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

export function makeMascot() {
  const phys = (color, o = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.7, ...o });
  const fur = phys(COL.fur, { sheen: 1, sheenColor: new THREE.Color(0x9a8cff), sheenRoughness: 0.4 });
  const furDark = phys(COL.furDark, { sheen: 0.6, sheenColor: new THREE.Color(0x7d6cff) });
  // markings are unlit near-black so they read as solid pattern, not shaded bumps (and skip the rim glow)
  const ink = new THREE.MeshBasicMaterial({ color: COL.ink });
  const cream = phys(COL.cream, { sheen: 1, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.5 });
  const muzzleM = phys(COL.muzzle, { sheen: 1, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.5 });
  const scarf = phys(COL.scarf, { roughness: 0.55, sheen: 1, sheenColor: new THREE.Color(0xd9b8ff) });
  const sclera = phys(0xffffff, { roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 });
  const iris = phys(COL.iris, { roughness: 0.2, clearcoat: 1, emissive: 0x5a2c00, emissiveIntensity: 0.5 });
  const pupil = phys(COL.pupil, { roughness: 0.1, clearcoat: 1 });
  const noseM = phys(0x15101c, { roughness: 0.3, clearcoat: 1 });
  const metal = phys(COL.goggle, { metalness: 0.8, roughness: 0.3 });
  const lens = phys(COL.lens, { roughness: 0.05, clearcoat: 1, transparent: true, opacity: 0.55, emissive: 0x1b4cff, emissiveIntensity: 0.4 });
  // glow lines are unlit and skip tone mapping so they stay bright against the dark fur
  const stripe = new THREE.MeshBasicMaterial({ color: COL.stripe, toneMapped: false });
  const glint = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const tex = glowTex();

  const sphere = new THREE.SphereGeometry(1, 36, 24);
  const spotGeo = new THREE.SphereGeometry(1, 14, 8);
  const cap = new THREE.CapsuleGeometry(1, 2, 6, 16);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const mesh = (mat, parent, x, y, z, sx, sy = sx, sz = sx, geo = sphere) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.scale.set(sx, sy, sz);
    parent.add(m);
    return m;
  };
  const group = (parent, x = 0, y = 0, z = 0) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };

  /* Spots: flattened discs laid on an ellipsoid along its surface normal, then merged into one mesh per
     parent so ~70 spots cost one draw call per moving part. */
  const Z = new THREE.Vector3(0, 0, 1), spotBuckets = new Map();
  function spot(parent, c, sc, dir, r) {
    dir = dir.clone().normalize();
    const n = new THREE.Vector3(dir.x / sc.x, dir.y / sc.y, dir.z / sc.z).normalize();
    const p = new THREE.Vector3(c[0] + sc.x * dir.x, c[1] + sc.y * dir.y, c[2] + sc.z * dir.z).addScaledVector(n, r * 0.12);
    const m = new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromUnitVectors(Z, n), new THREE.Vector3(r, r * 0.9, r * 0.28));
    if (!spotBuckets.has(parent)) spotBuckets.set(parent, []);
    spotBuckets.get(parent).push(spotGeo.clone().applyMatrix4(m));
  }
  const rnd = prng(7);
  const scatter = (count, accept, cb) => { for (let k = 0, tries = 0; k < count && tries < 2000; tries++) {
    const d = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (d.lengthSq() > 1 || d.lengthSq() < 0.05) continue;
    d.normalize(); if (!accept(d)) continue; cb(d, 0.6 + rnd() * 0.8); k++; } };

  const root = new THREE.Group();
  const lean = group(root);                 // pivots at the feet: leans into the cursor's motion
  const hop = group(lean);                  // hop height + squash
  const torso = group(hop, 0, 0.5, 0);

  // legs: slimmer and longer than before, cream-grey feet, a few spots
  for (const s of [-1, 1]) {
    const leg = group(hop, s * 0.1, 0.24, 0);
    mesh(fur, leg, 0, 0, 0, 0.062, 0.07, 0.062, cap);
    for (const [a, y, r] of [[0.6, 0.05, 0.022], [2.2, -0.03, 0.019], [-0.9, -0.07, 0.02], [3.6, 0.08, 0.018], [1.4, -0.1, 0.017]])
      spot(leg, [0, y, 0], new THREE.Vector3(0.062, 0.2, 0.062), new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), r);
    mesh(cream, hop, s * 0.105, 0.045, 0.04, 0.075, 0.05, 0.115);
    mesh(stripe, hop, s * 0.105, 0.085, 0.085, 0.01, 0.01, 0.04, cap).rotation.x = 1.25;
  }

  // body: slimmer and a touch longer, cream-grey chest and belly, spots on back and flanks
  const bodyS = new THREE.Vector3(0.22, 0.29, 0.2);
  const body = mesh(fur, torso, 0, 0, 0, bodyS.x, bodyS.y, bodyS.z);
  mesh(cream, torso, 0, -0.02, 0.095, 0.13, 0.23, 0.12);
  scatter(22, (d) => d.z < 0.45 && d.y < 0.85, (d, k) => spot(torso, [0, 0, 0], bodyS, d, 0.032 * k));
  const arms = [];
  for (const s of [-1, 1]) {
    const sh = group(torso, s * 0.18, 0.13, 0.02); sh.rotation.z = s * 0.35;
    mesh(fur, sh, 0, -0.11, 0, 0.048, 0.06, 0.048, cap);
    mesh(cream, sh, 0, -0.21, 0.01, 0.052);
    spot(sh, [0, -0.08, 0], new THREE.Vector3(0.048, 0.18, 0.048), new THREE.Vector3(s, 0, 0.5), 0.014);
    arms.push(sh);
  }

  /* tail: N spring-driven joints (just numbers, no meshes) define a Catmull-Rom spine; one tapered tube is
     swept along it every frame into preallocated buffers. Rings, base spots and the pale tip are baked into
     vertex colours, so the pattern bends with the tube. */
  const N = 13, SEG = 0.068, TS = 64, TR = 14;                  // joints, joint spacing, tube rings, sides
  const tailBase = group(torso, 0, -0.18, -0.16);
  tailBase.rotation.set(-0.7, 0.7, 0);
  const tailRot = new Float32Array(N * 2);                      // per-joint pitch / yaw
  const joints = Array.from({ length: N + 1 }, () => new THREE.Vector3());
  const spine = new THREE.CatmullRomCurve3(joints, false, "centripetal");
  const tailGeo = new THREE.BufferGeometry();
  const tPos = new Float32Array(TS * TR * 3), tNor = new Float32Array(TS * TR * 3), tCol = new Float32Array(TS * TR * 3);
  tailGeo.setAttribute("position", new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage));
  tailGeo.setAttribute("normal", new THREE.BufferAttribute(tNor, 3).setUsage(THREE.DynamicDrawUsage));
  tailGeo.setAttribute("color", new THREE.BufferAttribute(tCol, 3));
  const tIdx = [];
  for (let i = 0; i < TS - 1; i++) for (let j = 0; j < TR; j++) {
    const a = i * TR + j, b = i * TR + (j + 1) % TR, c = a + TR, d = b + TR;
    tIdx.push(a, b, c, b, d, c);
  }
  tailGeo.setIndex(tIdx);
  {
    const cFur = new THREE.Color(COL.fur), cInk = new THREE.Color(COL.ink), cTip = new THREE.Color(COL.cream), c = new THREE.Color();
    const rings = [[0.56, 0.61], [0.67, 0.72], [0.77, 0.815], [0.855, 0.89]];
    const baseSpots = [[0.12, 0.6], [0.2, 2.9], [0.27, 4.6], [0.34, 1.7], [0.42, 3.8], [0.48, 0.2], [0.16, 5.6]];
    for (let i = 0; i < TS; i++) for (let j = 0; j < TR; j++) {
      const u = i / (TS - 1), th = j / TR * Math.PI * 2;
      c.copy(cFur);
      if (u > 0.92) c.copy(cTip);
      else if (rings.some(([a, b]) => u > a && u < b)) c.copy(cInk);
      else for (const [su, sth] of baseSpots) {
        const dth = Math.atan2(Math.sin(th - sth), Math.cos(th - sth));
        if (Math.hypot((u - su) * 9, dth * 0.9) < 0.42) { c.copy(cInk); break; }
      }
      c.toArray(tCol, (i * TR + j) * 3);
    }
  }
  const tailMat = phys(0xffffff, { vertexColors: true, sheen: 1, sheenColor: new THREE.Color(0x9a8cff), sheenRoughness: 0.4 });
  const tailMesh = new THREE.Mesh(tailGeo, tailMat); tailBase.add(tailMesh);
  const tipGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0x6aa8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  tipGlow.userData.noFit = true; tipGlow.scale.setScalar(0.24); tailBase.add(tipGlow);
  // the S: curl up near the base, then sweep back near the tip
  const tailCurve = (i) => (i === 0 ? 0 : i < 6 ? 0.26 : -0.1);
  const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _e = new THREE.Euler(), _off = new THREE.Vector3();
  const _pn = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3(1, 0, 0), _b = new THREE.Vector3();
  const samples = Array.from({ length: TS }, () => new THREE.Vector3());
  function updateTail() {
    // forward kinematics of the joint chain in tailBase space
    _q.identity(); joints[0].set(0, 0, 0);
    for (let i = 0; i < N; i++) {
      _qi.setFromEuler(_e.set(tailRot[i * 2], tailRot[i * 2 + 1], 0)); _q.multiply(_qi);
      _off.set(0, 0, -SEG).applyQuaternion(_q);
      joints[i + 1].copy(joints[i]).add(_off);
    }
    for (let i = 0; i < TS; i++) spine.getPoint(i / (TS - 1), samples[i]);
    // sweep: projection-transported frame (no twist flips), radius tapers to a rounded tip
    _n.set(1, 0, 0);
    for (let i = 0; i < TS; i++) {
      const u = i / (TS - 1);
      _t.subVectors(samples[Math.min(i + 1, TS - 1)], samples[Math.max(i - 1, 0)]).normalize();
      _n.addScaledVector(_t, -_n.dot(_t)).normalize(); _b.crossVectors(_t, _n);
      let r = 0.052 * Math.pow(1 - u, 0.55) + 0.016;
      if (u > 0.9) r *= Math.sqrt(Math.max(0, 1 - ((u - 0.9) / 0.1) ** 2));          // round off the tip
      for (let j = 0; j < TR; j++) {
        const th = j / TR * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th), k = (i * TR + j) * 3;
        _pn.set(_n.x * cs + _b.x * sn, _n.y * cs + _b.y * sn, _n.z * cs + _b.z * sn);
        tNor[k] = _pn.x; tNor[k + 1] = _pn.y; tNor[k + 2] = _pn.z;
        tPos[k] = samples[i].x + _pn.x * r; tPos[k + 1] = samples[i].y + _pn.y * r; tPos[k + 2] = samples[i].z + _pn.z * r;
      }
    }
    tailGeo.attributes.position.needsUpdate = true; tailGeo.attributes.normal.needsUpdate = true;
    tipGlow.position.copy(samples[TS - 1]);
  }

  // head: wider cheeks, flatter crown, tapered jaw; pivots at the neck
  const neck = group(torso, 0, 0.27, 0);
  mesh(fur, neck, 0, 0.03, 0, 0.12, 0.055, 0.11, cap);           // short neck: fills any gap under the chin when it looks up
  const head = group(neck, 0, -0.02, 0);                        // lowered so the jaw sits in the scarf
  const hc = 0.38;
  const cranC = [0, hc + 0.03, 0], cranS = new THREE.Vector3(0.44, 0.36, 0.4);
  mesh(fur, head, ...cranC, cranS.x, cranS.y, cranS.z);
  const cheekS = new THREE.Vector3(0.24, 0.2, 0.26);
  for (const s of [-1, 1]) {
    mesh(fur, head, s * 0.2, hc - 0.07, 0.08, cheekS.x, cheekS.y, cheekS.z);
    const tuft = mesh(cream, head, s * 0.4, hc - 0.12, 0.06, 0.08, 0.05, 0.07);                  // cheek ruff
    tuft.rotation.z = s * 0.5;
    scatter(5, (d) => d.x * s > 0.45 && d.y > -0.5 && d.z > -0.3, (d, k) => spot(head, [s * 0.2, hc - 0.07, 0.08], cheekS, d, 0.022 * k));
  }
  mesh(fur, head, 0, hc - 0.19, 0.1, 0.2, 0.13, 0.22);                                             // tapered jaw
  // crown spots: avoid the face and the goggles band
  scatter(22, (d) => d.y > 0.2 && !(d.z > 0.5 && d.y < 0.75) || (d.z < -0.1 && d.y > -0.4),
    (d, k) => spot(head, cranC, cranS, d, 0.032 * k));

  // muzzle: slim, forward, pale; split upper lip, small chin, triangular nose, cat mouth
  mesh(muzzleM, head, 0, hc - 0.1, 0.33, 0.13, 0.1, 0.13);
  for (const s of [-1, 1]) mesh(muzzleM, head, s * 0.05, hc - 0.145, 0.42, 0.065, 0.055, 0.06);   // upper lip lobes
  mesh(muzzleM, head, 0, hc - 0.215, 0.39, 0.06, 0.04, 0.055);                                    // chin
  const tri = new THREE.Shape();
  tri.moveTo(0, -0.6); tri.quadraticCurveTo(0.08, -0.55, 0.8, 0.35); tri.quadraticCurveTo(0, 0.62, -0.8, 0.35); tri.quadraticCurveTo(-0.08, -0.55, 0, -0.6);
  const noseGeo = new THREE.ExtrudeGeometry(tri, { depth: 0.3, bevelEnabled: true, bevelSize: 0.18, bevelThickness: 0.2, bevelSegments: 3 });
  const nose = mesh(noseM, head, 0, hc - 0.075, 0.445, 0.05, 0.05, 0.05, noseGeo);
  nose.rotation.x = -0.25;
  mesh(noseM, head, 0, hc - 0.125, 0.468, 0.005, 0.03, 0.005, cap);                               // philtrum
  const arc = new THREE.TorusGeometry(0.03, 0.0065, 6, 16, Math.PI);
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(arc, noseM);
    m.position.set(s * 0.03, hc - 0.16, 0.457); m.rotation.set(-0.3, 0, Math.PI + s * 0.12); head.add(m);
  }

  // tear lines: bold ink stripes from the inner eye corner, down beside the muzzle, to the mouth corner,
  // each with a thin glow core
  for (const s of [-1, 1]) {
    const tl = group(head, s * 0.125, hc - 0.09, 0.4);
    tl.rotation.set(-0.5, s * 0.4, s * 0.2);
    mesh(ink, tl, 0, 0, 0, 0.032, 0.085, 0.03, cap);
    mesh(stripe, tl, 0, 0, 0.026, 0.008, 0.07, 0.006, cap);
  }

  // eyes: large and glossy, almond with the outer corner lifted, dark rims (another cheetah cue)
  const EYE_D = 0.06, EYE_A = 0.158, EYE_B = 0.128;            // lens depth and half-size
  // keep the pupil on the lens: offset clamped inside the ellipse, z read off the lens surface
  const placePupil = (pv, x, y) => {
    const k = Math.hypot(x / (EYE_A - 0.085), y / (EYE_B - 0.095));
    if (k > 1) { x /= k; y /= k; }
    pv.position.set(x, y, EYE_D * Math.sqrt(Math.max(0, 1 - (x / EYE_A) ** 2 - (y / EYE_B) ** 2)) - 0.006);
  };
  const eyes = [];
  for (const s of [-1, 1]) {
    // seated lens: centre just under the skull, turned to follow its curvature, so only a front cap shows
    // and the outer rim meets the surface instead of overhanging it in 3/4 view
    const eye = group(head, s * 0.158, hc + 0.04, 0.334);
    eye.rotation.set(0, s * 0.4, s * 0.2);
    mesh(ink, eye, 0, 0, -0.006, 0.172, 0.142, 0.052);
    mesh(sclera, eye, 0, 0, 0, EYE_A, EYE_B, EYE_D);
    const pivot = group(eye);                                  // slides across the lens, see placePupil()
    mesh(iris, pivot, 0, 0, 0, 0.085, 0.095, 0.014);
    mesh(pupil, pivot, 0, 0, 0.008, 0.036, 0.058, 0.008);
    mesh(glint, eye, 0.045, 0.045, 0.062, 0.025);
    mesh(glint, eye, -0.04, -0.035, 0.064, 0.011);
    const brow = mesh(ink, head, s * 0.165, hc + 0.18, 0.37, 0.013, 0.06, 0.013, cap);
    brow.rotation.set(-0.45, 0, -s * (Math.PI / 2 - 0.42));                                        // sharp, confident
    eyes.push({ eye, pivot });
  }

  // goggles pushed up on the forehead, strap around the head
  const gog = group(head, 0, hc + 0.25, 0.235); gog.rotation.x = -0.55;
  const frame = new THREE.TorusGeometry(0.095, 0.024, 10, 28);
  for (const s of [-1, 1]) {
    const f = new THREE.Mesh(frame, metal); f.position.set(s * 0.115, 0, 0.1); gog.add(f);
    mesh(lens, gog, s * 0.115, 0, 0.1, 0.09, 0.09, 0.028);
    mesh(glint, gog, s * 0.115 + 0.033, 0.033, 0.128, 0.015);
  }
  mesh(metal, gog, 0, 0, 0.1, 0.05, 0.02, 0.02, box);
  const strap = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 8, 40), furDark);
  strap.position.set(0, hc + 0.24, -0.02); strap.rotation.x = Math.PI / 2 - 0.35; strap.scale.set(0.395, 0.36, 0.4); head.add(strap);

  // ears: small, side-set, rounded triangles; dark backs with a pale eye-spot, fuzzy cream tufts inside
  const earShape = new THREE.Shape();
  earShape.moveTo(-0.5, 0); earShape.quadraticCurveTo(-0.3, 0.6, -0.08, 0.95); earShape.quadraticCurveTo(0, 1.05, 0.08, 0.95);
  earShape.quadraticCurveTo(0.3, 0.6, 0.5, 0); earShape.quadraticCurveTo(0, -0.1, -0.5, 0);
  const earGeo = new THREE.ExtrudeGeometry(earShape, { depth: 0.12, bevelEnabled: true, bevelSize: 0.1, bevelThickness: 0.1, bevelSegments: 3 });
  earGeo.translate(0, 0, -0.06);
  const ears = [];
  for (const s of [-1, 1]) {
    const e = group(head, s * 0.31, hc + 0.24, -0.04); e.rotation.set(-0.1, s * 0.35, -s * 0.75);
    mesh(furDark, e, 0, 0, 0, 0.15, 0.17, 0.2, earGeo);
    mesh(cream, e, 0, 0.03, 0.035, 0.09, 0.11, 0.1, earGeo);
    for (const [x, y, r] of [[-0.025, 0.04, 0.022], [0.02, 0.05, 0.02], [0, 0.085, 0.017], [-0.01, 0.025, 0.02]]) mesh(cream, e, x, y, 0.05, r, r * 1.3, r * 0.7);
    mesh(cream, e, 0, 0.065, -0.045, 0.032, 0.035, 0.012);                                           // back eye-spot
    ears.push({ s, e, rz: -s * 0.75, x: { x: 0, v: 0 }, z: { x: 0, v: 0 } });
  }

  // scarf: a wrap at the neck and two tails that flutter on springs
  // soft wrapped scarf: a fat torus drooping slightly at the front, a second thinner turn, and a knot at the back
  const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.065, 14, 40), scarf);
  wrap.rotation.x = Math.PI / 2 + 0.14; wrap.position.set(0, 0.02, 0.005); wrap.scale.set(1.05, 1, 0.9); neck.add(wrap);
  const wrap2 = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.04, 10, 36), scarf);
  wrap2.rotation.x = Math.PI / 2 - 0.08; wrap2.position.y = 0.075; neck.add(wrap2);
  mesh(scarf, neck, 0, 0.03, -0.17, 0.065, 0.055, 0.05);
  const scarfTails = [];
  for (const s of [-1, 1]) {
    const a = group(neck, s * 0.05, 0.02, -0.15);
    mesh(scarf, a, 0, 0, -0.08, 0.075, 0.024, 0.17, box);
    const b = group(a, 0, 0, -0.16);
    mesh(scarf, b, 0, 0, -0.07, 0.065, 0.021, 0.15, box);
    scarfTails.push({ s, a, b, p: { x: 0, v: 0 }, y: { x: 0, v: 0 } });
  }

  for (const [p, list] of spotBuckets) { const m = new THREE.Mesh(mergeGeometries(list), ink); p.add(m); }

  /* --- dash FX: tapered streaks, after-image ghosts, foot sparks (all excluded from fitting) ---- */
  const fx = (o) => { o.userData.noFit = true; o.frustumCulled = false; root.add(o); return o; };
  const sTex = streakTex(), streaks = [];
  const quad = new THREE.PlaneGeometry(1, 1);
  [[0.32, 0.6, 0x4f9bff], [0.55, 0.85, 0x8b3cff], [0.78, 0.7, 0x6aa8ff], [1.0, 0.55, 0x2f7bff], [1.2, 0.75, 0xa070ff], [0.44, 0.5, 0x4f9bff]]
    .forEach(([y, len, color], i) => {
      const m = fx(new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ map: sTex, color, blending: THREE.AdditiveBlending, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })));
      m.position.set(0, y, -0.05 - i * 0.02); streaks.push({ m, len, y, delay: i * 0.025 });
    });
  // ghosts: a cheap silhouette (head, body, ears) in additive violet that trails the dash and fades
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x6f5cff, blending: THREE.AdditiveBlending, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  const ghosts = [];
  for (let i = 0; i < 3; i++) {
    const g = fx(new THREE.Group());
    mesh(ghostMat.clone(), g, 0, 1.24, -0.1, 0.46, 0.4, 0.2);
    mesh(g.children[0].material, g, 0, 0.55, -0.1, 0.23, 0.36, 0.15);
    g.traverse((c) => { c.userData.noFit = true; });
    ghosts.push(g);
  }
  // sparks: a short-lived particle burst at the feet
  const NS = 22, sparkPos = new Float32Array(NS * 3), sparkVel = new Float32Array(NS * 3);
  const sparkGeo = new THREE.BufferGeometry(); sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  const sparks = fx(new THREE.Points(sparkGeo, new THREE.PointsMaterial({ map: tex, color: 0x9cc4ff, size: 0.07, blending: THREE.AdditiveBlending, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })));
  let sparkT = -1;
  function burst(dir) {
    for (let i = 0; i < NS; i++) {
      sparkPos.set([(Math.random() - 0.5) * 0.25, 0.06 + Math.random() * 0.1, (Math.random() - 0.5) * 0.15], i * 3);
      sparkVel.set([-dir * (0.6 + Math.random() * 1.4), 0.3 + Math.random() * 1.1, (Math.random() - 0.5) * 0.6], i * 3);
    }
    sparkT = 0;
  }

  root.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });

  const S = { lean: { x: 0, v: 0 }, tail: { x: 0, v: 0 }, hist: new Float32Array(64), hi: 0 };
  let lastT = 0, lastYaw = 0, lastPitch = 0, nextBlink = 1.5, blinkT = -1, hopT = -1, dashT = -1, dashDir = 1, wasNear = false, nextFlick = 4;
  const rand = (a, b) => a + Math.random() * (b - a);

  function tick(dt, t, yaw, pitch, near, still, vx = 0) {
    if (still) { dt = 0; yaw = pitch = vx = 0; near = false; }
    const br = Math.sin(t * 2.3);
    body.scale.y = bodyS.y * (1 + 0.025 * br);
    neck.position.y = 0.27 + 0.008 * br;
    for (const [i, a] of arms.entries()) a.rotation.x = 0.08 * Math.sin(t * 2.3 + i);

    // look
    torso.rotation.y = yaw * 0.22;
    head.rotation.set(pitch * 0.7, yaw * 0.62, -yaw * 0.06);
    for (const { pivot } of eyes) placePupil(pivot, yaw * 0.06, -pitch * 0.07);   // modest travel: the head does most of the turning

    // blink
    if (t - lastT > 0.5) nextBlink = t + rand(1, 3);              // resumed after a pause: don't blink on arrival
    lastT = t;
    if (!still && t > nextBlink) { blinkT = 0; nextBlink = t + (Math.random() < 0.2 ? 0.3 : rand(2.2, 5)); }
    let lid = 1;
    if (blinkT >= 0) { blinkT += dt; const k = blinkT / 0.15; lid = k >= 1 ? 1 : 1 - Math.sin(k * Math.PI) * 0.92; if (k >= 1) blinkT = -1; }
    for (const { eye } of eyes) eye.scale.y = lid;

    // cursor arrives: crouch-hop plus a dash toward it; leaves: springs settle it back
    if (near && !wasNear) { hopT = 0; dashT = 0; dashDir = Math.sign(yaw) || 1; burst(dashDir); }
    wasNear = near;
    let hy = 0, sq = 1, kick = 0;
    if (hopT >= 0) {
      hopT += dt;
      const k = hopT / 0.45;
      if (k < 0.18) sq = 1 - 0.14 * Math.sin(k / 0.18 * Math.PI);
      else if (k < 1) { const u = (k - 0.18) / 0.82; hy = Math.sin(u * Math.PI) * 0.14; sq = 1 + 0.07 * Math.sin(u * Math.PI); }
      else { hopT = -1; kick = 1; }
    }
    hop.position.y = hy;
    hop.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));

    let dash = 0;
    if (dashT >= 0) { dashT += dt; dash = Math.max(0, 1 - dashT / 0.7); if (dash === 0) dashT = -1; }
    const leanTarget = THREE.MathUtils.clamp(vx, -1, 1) * 0.14 + dashDir * dash * 0.17;   // capped near 0.3 rad so the head stays inside the canvas
    const ln = dt ? spring(S.lean, leanTarget, dt, 60, 10) : 0;
    lean.rotation.z = -ln;
    torso.rotation.x = Math.min(Math.abs(ln) * 0.9, 0.35);       // hunch forward, ready to run

    // streaks: snap out along the dash, stretch and fade over ~250 ms
    const dT = dashT < 0 ? 9 : dashT;
    for (const st of streaks) {
      const u = (dT - st.delay) / 0.28, a = u < 0 || u > 1 ? 0 : 1 - u * u;
      st.m.material.opacity = a;
      const len = st.len * (0.6 + u * 0.8);
      st.m.scale.set(dashDir * len, 0.05 * (1 - u * 0.6), 1);                  // thick end toward the body
      st.m.position.x = -dashDir * (0.18 + len / 2 + u * 0.25);
      st.m.position.y = st.y + hy;
    }
    // ghosts: 2-3 after-images trailing behind, each fainter and further back
    ghosts.forEach((g, i) => {
      const u = (dT - i * 0.03) / 0.3, a = u < 0 || u > 1 ? 0 : (1 - u) * (0.22 - i * 0.06);
      g.children[0].material.opacity = a;
      g.position.set(-dashDir * (0.2 + i * 0.16) * (0.6 + u * 0.6), hy, 0);
      g.rotation.z = -ln;
    });
    // sparks
    if (sparkT >= 0 && dt > 0) {
      sparkT += dt;
      for (let i = 0; i < NS; i++) {
        sparkVel[i * 3 + 1] -= 4 * dt;
        for (let k = 0; k < 3; k++) sparkPos[i * 3 + k] += sparkVel[i * 3 + k] * dt;
        if (sparkPos[i * 3 + 1] < 0.01) { sparkPos[i * 3 + 1] = 0.01; sparkVel[i * 3 + 1] *= -0.3; }
      }
      sparkGeo.attributes.position.needsUpdate = true;
      sparks.material.opacity = Math.max(0, 1 - sparkT / 0.45);
      if (sparkT > 0.45) sparkT = -1;
    } else if (sparkT < 0) sparks.material.opacity = 0;
    stripe.color.setHex(COL.stripe).multiplyScalar(1 + 0.15 * Math.sin(t * 3) + dash * 0.8);

    if (dt > 0) {
      const dy = (yaw - lastYaw) / dt, dp = (pitch - lastPitch) / dt;
      // ears: springs pushed by head motion and hops, plus an occasional flick
      const flick = t > nextFlick ? (nextFlick = t + rand(3, 7), ears[Math.random() < 0.5 ? 0 : 1]) : null;
      for (const ear of ears) {
        if (ear === flick) ear.z.v += ear.s * 10;
        ear.x.v += (-dp * 4 + kick * 10) * dt * 10; ear.z.v += dy * 3 * dt * 10;
        ear.e.rotation.x = -0.1 + spring(ear.x, 0, dt, 120, 10);
        ear.e.rotation.z = ear.rz + spring(ear.z, 0, dt, 120, 10);
      }
      // scarf tails: hang back and down, stream out when leaning or dashing
      for (const st of scarfTails) {
        const stream = Math.min(Math.abs(ln) * 2 + dash, 1);
        const p = spring(st.p, -0.9 + stream * 0.8 + 0.06 * Math.sin(t * 5 + st.s), dt, 50, 6);
        const y = spring(st.y, ln * 1.8 - dy * 0.15 + st.s * 0.12, dt, 50, 6);
        st.a.rotation.set(p, y, 0);
        st.b.rotation.set(p * 0.4 + 0.05 * Math.sin(t * 7 + st.s), y * 0.6, 0);
      }
      // tail: one spring, replayed down the chain with a delay so it whips
      const tv = spring(S.tail, 0.35 * Math.sin(t * 1.4) - dy * 0.25 + ln * 1.5, dt, 40, 5);
      S.hist[S.hi = (S.hi + 1) % 64] = tv;
      for (let i = 0; i < N; i++) { tailRot[i * 2] = tailCurve(i); tailRot[i * 2 + 1] = S.hist[(S.hi - i * 2 + 64) % 64] * 0.3; }
    } else {
      for (let i = 0; i < N; i++) { tailRot[i * 2] = tailCurve(i); tailRot[i * 2 + 1] = 0; }
      for (const st of scarfTails) { st.a.rotation.x = -0.9; st.b.rotation.x = -0.35; }
    }
    updateTail();
    lastYaw = yaw; lastPitch = pitch;
  }

  return { root, head, tick };
}
