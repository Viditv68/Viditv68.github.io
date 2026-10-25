/* =========================================================================
   Vidit Rawat — interactive background
   Dither nebula: a domain-warped fBm field (f(p + 3·fbm(p + 3.5·fbm(p))))
   shaded through a 9-colour palette with 4×4 ordered (Bayer) dithering,
   rendered at a third of CSS resolution and upscaled with nearest filtering
   so it reads as pixel art. One full-screen pass, no textures, no
   framebuffers — about 0.3 ms a frame on a desktop GPU.

   The cursor twists the field around itself; scrolling drifts it and steps
   it back so body copy owns the foreground.

   No WebGL, a failed shader or a lost context → no canvas, and the body's
   CSS gradient stays. Reduced motion → one still frame, no loop.
   ========================================================================= */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var canvas = document.createElement("canvas");
  var gl = canvas.getContext && canvas.getContext("webgl", {
    alpha: false, antialias: false, depth: false, stencil: false,
    // the companion already holds a WebGL context; don't wake the big GPU for this one
    powerPreference: "low-power"
  });
  if (!gl) return;

  var VS = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";
  var FS = [
    "#ifdef GL_FRAGMENT_PRECISION_HIGH",
    "precision highp float;",
    "#else",
    "precision mediump float;",
    "#endif",
    "uniform vec2 uRes; uniform float uTime, uScroll, uAmt, uCalm; uniform vec2 uMouse;",
    "float hash(vec2 p){ p=fract(p*vec2(127.31,311.73)); p+=dot(p,p+34.23); return fract(p.x*p.y); }",
    "float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);",
    "  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }",
    "const mat2 R = mat2(1.6,1.2,-1.2,1.6);", // rotate+scale between octaves hides the lattice
    "float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*noise(p); p=R*p; a*=.5; } return s; }",
    // 4x4 Bayer threshold in [0,1) from two nested 2x2 patterns
    "float bayer2(vec2 a){ a=floor(a); return fract(dot(a, vec2(.5, a.y*.75))); }",
    "float bayer4(vec2 a){ return bayer2(.5*a)*.25 + bayer2(a); }",
    "vec3 ramp(float l, float h){", // l in {0,.25,.5,.75,1}, h in {0,1}: blue or violet family
    "  vec3 c0=vec3(.031,.043,.078);",
    "  vec3 c1=mix(vec3(.055,.090,.200), vec3(.090,.055,.200), h);",
    "  vec3 c2=mix(vec3(.106,.310,.741), vec3(.300,.140,.620), h);",
    "  vec3 c3=mix(vec3(.184,.482,1.00), vec3(.545,.235,1.00), h);",
    "  vec3 c4=mix(vec3(.667,.816,1.00), vec3(.800,.700,1.00), h);",
    "  return l<.125?c0: l<.375?c1: l<.625?c2: l<.875?c3: c4; }",
    "void main(){",
    "  vec2 fc=gl_FragCoord.xy, uv=fc/uRes;",
    "  float k=2.4/uRes.y;",
    "  vec2 p=(fc-.5*uRes)*k; p.y-=uScroll*.8;",
    "  vec2 m=(uMouse-.5*uRes)*k; m.y-=uScroll*.8;",
    "  vec2 d=p-m; float g=exp(-dot(d,d)*2.5)*uAmt;", // gaussian falloff round the cursor
    "  float an=g*2.2; p=m+mat2(cos(an),-sin(an),sin(an),cos(an))*d;", // twist the domain, not the colours
    "  float t=uTime*.045;",
    "  vec2 q=vec2(fbm(p+vec2(0.,t)), fbm(p+vec2(5.2,1.3)-t));",
    "  vec2 r=vec2(fbm(p+3.5*q+vec2(1.7,9.2)+1.3*t), fbm(p+3.5*q+vec2(8.3,2.8)-t));",
    "  float f=fbm(p+3.*r);",
    "  float v=smoothstep(.32,.92,f*f*1.55+.12*length(q)) + g*.25;",
    // keep the copy column and the lower page calm; step back as the page scrolls
    "  float mask=mix(.38,1.,smoothstep(.18,.78,uv.x)) * mix(.55,1.,uv.y) * (1.-.45*clamp(uScroll,0.,1.));",
    "  v*=mask*uCalm;",
    "  float b=bayer4(fc);",
    "  float l=clamp(floor(v*4.+b),0.,4.)/4.;",
    "  float h=step(bayer4(fc+vec2(2.,1.)), smoothstep(.35,.75,r.x));",
    "  gl_FragColor=vec4(ramp(l,h),1.);",
    "}"
  ].join("\n");

  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  var prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, "a");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) {
    if (window.console) console.warn("[bg] shader failed, keeping the CSS background", e);
    return;
  }

  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  // one oversized triangle covers the screen with no diagonal seam
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  var U = {};
  ["uRes", "uTime", "uScroll", "uAmt", "uCalm", "uMouse"].forEach(function (n) {
    U[n] = gl.getUniformLocation(prog, n);
  });

  canvas.className = "bg-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.insertBefore(canvas, document.body.firstChild);

  /* The art pixel is 2–4 CSS px, so devicePixelRatio never enters: the
     buffer stays far below 1x and the dither stays crisp. */
  var pix = 3, W = 1, H = 1, calm = 1;
  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    pix = w < 700 ? 2 : w > 1800 ? 4 : 3;
    // On phones the copy spans the full width, so the whole field is toned down.
    calm = w < 700 ? 0.62 : 1;
    W = Math.ceil(w / pix);
    H = Math.ceil(h / pix);
    canvas.width = W;
    canvas.height = H;
    gl.viewport(0, 0, W, H);
  }

  // Eased copies of the cursor and scroll, so the swirl trails a little.
  var mx = -1e4, my = -1e4, smx = 0, smy = 0, amt = 0, amtTarget = 0;
  var scroll = 0, scrollS = 0;
  var raf = 0, t0 = performance.now();

  function draw(now) {
    amt += (amtTarget - amt) * 0.06;
    smx += (mx - smx) * 0.12;
    smy += (my - smy) * 0.12;
    scrollS += (scroll - scrollS) * 0.1;
    gl.uniform2f(U.uRes, W, H);
    gl.uniform1f(U.uTime, (now - t0) / 1000 + 40); // +40 s skips the plain opening frames of the warp
    gl.uniform1f(U.uScroll, scrollS);
    gl.uniform1f(U.uAmt, amt);
    gl.uniform1f(U.uCalm, calm);
    gl.uniform2f(U.uMouse, smx / pix, H - smy / pix);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function frame(now) {
    draw(now);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  canvas.addEventListener("webglcontextlost", function (e) {
    e.preventDefault();
    stop();
    canvas.remove();
  });

  scroll = (window.scrollY || 0) / (window.innerHeight || 1);
  scrollS = scroll;
  resize();

  if (reduceMotion) {
    draw(t0);
    window.addEventListener("resize", function () { resize(); draw(t0); });
    return;
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("scroll", function () {
    scroll = (window.scrollY || 0) / (window.innerHeight || 1);
  }, { passive: true });

  window.addEventListener("pointermove", function (e) {
    // A lifted finger would leave the swirl stuck where it lifted.
    if (e.pointerType === "touch") return;
    if (amtTarget === 0) { smx = e.clientX; smy = e.clientY; }
    mx = e.clientX;
    my = e.clientY;
    amtTarget = 1;
  }, { passive: true });

  document.documentElement.addEventListener("pointerleave", function () {
    amtTarget = 0;
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else start();
  });

  start();
})();
