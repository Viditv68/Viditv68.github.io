/* =========================================================================
   Vidit Rawat — interactive background
   GPU fluid: Jos Stam's "Stable Fluids" (SIGGRAPH 1999) on the GPU, as in
   GPU Gems ch. 38 — semi-Lagrangian advection, vorticity confinement and a
   Jacobi pressure solve. Written fresh for this site; the pass layout follows
   the well-known PavelDoGreat/WebGL-Fluid-Simulation (MIT, (c) 2017 Pavel
   Dobryakov) but no code is copied from it.

   The cursor stirs blue/violet smoke, scrolling drags it along the screen
   edges, and a soft puff drifts in every few seconds on its own.

   Needs WebGL2 and renderable half-float targets. Anything less, a failed
   shader or a lost context → no canvas, and the body's CSS gradient stays.
   Reduced motion → the sim is run ahead off-screen and one still frame shown.
   ========================================================================= */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var canvas = document.createElement("canvas");
  var gl = canvas.getContext && canvas.getContext("webgl2", {
    alpha: false, depth: false, stencil: false, antialias: false,
    // the companion already holds a WebGL context; don't wake the big GPU for this one
    powerPreference: "low-power"
  });
  if (!gl) return;
  if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return;

  var VS = "#version 300 es\nin vec2 a; uniform vec2 uTexel; out vec2 vUv, vL, vR, vT, vB;\n" +
    "void main(){ vUv=a*.5+.5; vL=vUv-vec2(uTexel.x,0.); vR=vUv+vec2(uTexel.x,0.); vT=vUv+vec2(0.,uTexel.y); vB=vUv-vec2(0.,uTexel.y); gl_Position=vec4(a,0.,1.); }";
  var HEAD = "#version 300 es\nprecision highp float; precision highp sampler2D;\nin vec2 vUv, vL, vR, vT, vB; out vec4 o;\n";
  var FS = {
    splat: "uniform sampler2D uT; uniform vec3 uColor; uniform vec2 uPoint; uniform float uRadius, uAspect;" +
      "void main(){ vec2 d=vUv-uPoint; d.x*=uAspect; o=vec4(texture(uT,vUv).rgb+uColor*exp(-dot(d,d)/uRadius),1.); }",
    curl: "uniform sampler2D uV;" +
      "void main(){ o=vec4(.5*(texture(uV,vR).y-texture(uV,vL).y-texture(uV,vT).x+texture(uV,vB).x),0.,0.,1.); }",
    vort: "uniform sampler2D uV, uC; uniform float uCurl, uDt;" +
      "void main(){ float L=texture(uC,vL).x,R=texture(uC,vR).x,T=texture(uC,vT).x,B=texture(uC,vB).x,C=texture(uC,vUv).x;" +
      " vec2 f=.5*vec2(abs(T)-abs(B),abs(R)-abs(L)); f/=length(f)+1e-4; f*=uCurl*C; f.y=-f.y;" +
      " o=vec4(clamp(texture(uV,vUv).xy+f*uDt,-1000.,1000.),0.,1.); }",
    div: "uniform sampler2D uV;" +
      "void main(){ vec2 C=texture(uV,vUv).xy; float L=texture(uV,vL).x,R=texture(uV,vR).x,T=texture(uV,vT).y,B=texture(uV,vB).y;" +
      " if(vL.x<0.)L=-C.x; if(vR.x>1.)R=-C.x; if(vT.y>1.)T=-C.y; if(vB.y<0.)B=-C.y;" + // walls reflect
      " o=vec4(.5*(R-L+T-B),0.,0.,1.); }",
    scale: "uniform sampler2D uT; uniform float uS; void main(){ o=uS*texture(uT,vUv); }",
    jacobi: "uniform sampler2D uP, uD;" +
      "void main(){ o=vec4((texture(uP,vL).x+texture(uP,vR).x+texture(uP,vT).x+texture(uP,vB).x-texture(uD,vUv).x)*.25,0.,0.,1.); }",
    grad: "uniform sampler2D uP, uV;" +
      "void main(){ vec2 g=.5*vec2(texture(uP,vR).x-texture(uP,vL).x,texture(uP,vT).x-texture(uP,vB).x); o=vec4(texture(uV,vUv).xy-g,0.,1.); }",
    advect: "uniform sampler2D uV, uS; uniform vec2 uSim; uniform float uDt, uDiss;" +
      "void main(){ vec2 c=vUv-uDt*texture(uV,vUv).xy*uSim; o=texture(uS,c)/(1.+uDiss*uDt); }",
    // Dye shown as light: a brightness-gradient normal gives the smoke some relief,
    // then an exponential tonemap keeps overlapping splats from clipping to white.
    show: "uniform sampler2D uT;" +
      "void main(){ vec3 c=texture(uT,vUv).rgb;" +
      " float l=length(texture(uT,vL).rgb),r=length(texture(uT,vR).rgb),t=length(texture(uT,vT).rgb),b=length(texture(uT,vB).rgb);" +
      " vec3 n=normalize(vec3(l-r,b-t,.3)); float lit=.55+.6*clamp(dot(n,normalize(vec3(-.4,.5,1.))),0.,1.);" +
      " c=(1.-exp(-c*lit*1.5))*.78;" + // never reaches white: the copy has to stay the brightest thing
      " float mask=mix(.55,1.,smoothstep(.1,.7,vUv.x));" + // calmer behind the copy column
      " o=vec4(vec3(.031,.043,.078)+c*mask,1.); }"
  };

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  var P = {};
  try {
    var vs = compile(gl.VERTEX_SHADER, VS);
    Object.keys(FS).forEach(function (k) {
      var p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, HEAD + FS[k]));
      gl.bindAttribLocation(p, 0, "a");
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < n; i++) {
        var name = gl.getActiveUniform(p, i).name;
        u[name] = gl.getUniformLocation(p, name);
      }
      P[k] = { p: p, u: u };
    });
  } catch (e) {
    if (window.console) console.warn("[bg] shader failed, keeping the CSS background", e);
    return;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  // one oversized triangle covers the screen with no diagonal seam
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  /* --- Render targets -------------------------------------------------- */
  function target(w, h) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("half-float target not renderable");
    }
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex: tex, fb: fb, w: w, h: h };
  }

  function pingpong(w, h) {
    var o = { read: target(w, h), write: target(w, h) };
    o.swap = function () { var t = o.read; o.read = o.write; o.write = t; };
    return o;
  }

  function free(t) {
    if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
  }

  var vel, dye, pres, divT, curlT, simW, simH, cssW = 0;
  var mobile = window.innerWidth < 700;
  var ITER = mobile ? 10 : 16;

  function fit(short) {
    var a = window.innerWidth / window.innerHeight;
    return a > 1 ? [Math.round(short * a), short] : [short, Math.round(short / a)];
  }

  function build() {
    [vel && vel.read, vel && vel.write, dye && dye.read, dye && dye.write,
     pres && pres.read, pres && pres.write, divT, curlT].forEach(free);
    var s = fit(mobile ? 96 : 128), d = fit(mobile ? 256 : 512);
    simW = s[0];
    simH = s[1];
    vel = pingpong(simW, simH);
    pres = pingpong(simW, simH);
    divT = target(simW, simH);
    curlT = target(simW, simH);
    dye = pingpong(d[0], d[1]);
  }

  function resize() {
    // Display buffer at 0.6x of the (1.5-capped) device resolution: smoke is soft anyway.
    var s = Math.min(window.devicePixelRatio || 1, 1.5) * 0.6;
    canvas.width = Math.round(window.innerWidth * s);
    canvas.height = Math.round(window.innerHeight * s);
    // Phones fire resize as the URL bar slides; only a width change rebuilds (and clears) the sim.
    if (window.innerWidth !== cssW) {
      cssW = window.innerWidth;
      mobile = cssW < 700;
      ITER = mobile ? 10 : 16;
      build();
    }
  }

  /* --- Passes ---------------------------------------------------------- */
  function tex(unit, t) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    return unit;
  }

  function use(k, texelW, texelH) {
    var q = P[k];
    gl.useProgram(q.p);
    gl.uniform2f(q.u.uTexel, 1 / texelW, 1 / texelH);
    return q.u;
  }

  function blit(t) {
    if (t) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.viewport(0, 0, t.w, t.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function splat(x, y, fx, fy, col, rScale) {
    var aspect = window.innerWidth / window.innerHeight;
    var r = 0.0022 * (rScale || 1) * Math.max(aspect, 1);
    var u = use("splat", vel.read.w, vel.read.h);
    gl.uniform1i(u.uT, tex(0, vel.read));
    gl.uniform1f(u.uAspect, aspect);
    gl.uniform2f(u.uPoint, x, y);
    gl.uniform3f(u.uColor, fx, fy, 0);
    gl.uniform1f(u.uRadius, r);
    blit(vel.write);
    vel.swap();
    if (!col) return;
    gl.uniform1i(u.uT, tex(0, dye.read));
    gl.uniform3f(u.uColor, col[0], col[1], col[2]);
    blit(dye.write);
    dye.swap();
  }

  function step(dt) {
    var u;
    u = use("curl", simW, simH);
    gl.uniform1i(u.uV, tex(0, vel.read));
    blit(curlT);

    u = use("vort", simW, simH);
    gl.uniform1i(u.uV, tex(0, vel.read));
    gl.uniform1i(u.uC, tex(1, curlT));
    gl.uniform1f(u.uCurl, 24);
    gl.uniform1f(u.uDt, dt);
    blit(vel.write);
    vel.swap();

    u = use("div", simW, simH);
    gl.uniform1i(u.uV, tex(0, vel.read));
    blit(divT);

    // Warm-start the pressure solve from last frame's field, slightly decayed.
    u = use("scale", simW, simH);
    gl.uniform1i(u.uT, tex(0, pres.read));
    gl.uniform1f(u.uS, 0.8);
    blit(pres.write);
    pres.swap();

    u = use("jacobi", simW, simH);
    gl.uniform1i(u.uD, tex(1, divT));
    for (var i = 0; i < ITER; i++) {
      gl.uniform1i(u.uP, tex(0, pres.read));
      blit(pres.write);
      pres.swap();
    }

    u = use("grad", simW, simH);
    gl.uniform1i(u.uP, tex(0, pres.read));
    gl.uniform1i(u.uV, tex(1, vel.read));
    blit(vel.write);
    vel.swap();

    u = use("advect", simW, simH);
    gl.uniform2f(u.uSim, 1 / simW, 1 / simH);
    gl.uniform1f(u.uDt, dt);
    gl.uniform1i(u.uV, tex(0, vel.read));
    gl.uniform1i(u.uS, tex(0, vel.read));
    gl.uniform1f(u.uDiss, 0.25);
    blit(vel.write);
    vel.swap();

    use("advect", dye.read.w, dye.read.h);
    gl.uniform1i(u.uV, tex(0, vel.read));
    gl.uniform1i(u.uS, tex(1, dye.read));
    gl.uniform1f(u.uDiss, 1.2);
    blit(dye.write);
    dye.swap();
  }

  function show() {
    var u = use("show", dye.read.w, dye.read.h);
    gl.uniform1i(u.uT, tex(0, dye.read));
    blit(null);
  }

  /* --- Input ----------------------------------------------------------- */
  var PAL = [[0.184, 0.482, 1.0], [0.545, 0.235, 1.0], [0.42, 0.64, 1.0]];
  function colour(k) {
    var c = PAL[Math.floor(Math.random() * PAL.length)];
    return [c[0] * k, c[1] * k, c[2] * k];
  }

  function ambient() {
    // Puffs start right of the copy column so the hero text keeps its contrast.
    var a = Math.random() * Math.PI * 2, s = 260 + Math.random() * 320;
    splat(0.45 + Math.random() * 0.5, 0.2 + Math.random() * 0.7,
      Math.cos(a) * s, Math.sin(a) * s, colour(0.22), 1.6);
  }

  try {
    resize();
  } catch (e) {
    if (window.console) console.warn("[bg] no float targets, keeping the CSS background", e);
    return;
  }

  canvas.className = "bg-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.insertBefore(canvas, document.body.firstChild);

  function settle() {
    for (var k = 0; k < 4; k++) ambient();
    for (var s = 0; s < 90; s++) step(1 / 60);
    show();
  }

  if (reduceMotion) {
    settle();
    window.addEventListener("resize", function () { resize(); settle(); });
    return;
  }

  var raf = 0, last = 0, nextPuff = 0;
  var mx = 0, my = 0, pdx = 0, pdy = 0, moved = false, hue = colour(0.09), hueT = 0;
  var scroll = window.scrollY || 0, lastScroll = scroll;

  function frame(now) {
    var dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    if (now > nextPuff) { ambient(); nextPuff = now + 2200 + Math.random() * 1800; }
    if (now > hueT) { hue = colour(0.09); hueT = now + 900; }
    if (moved) { splat(mx, my, pdx * 5000, pdy * 5000, hue); pdx = pdy = 0; moved = false; }

    var dy = scroll - lastScroll;
    lastScroll = scroll;
    if (Math.abs(dy) > 0.5) {
      // The page slides up, so drag the fluid up with it at the two edges.
      var f = Math.max(-1, Math.min(1, dy / 80)) * 600;
      splat(0.06 + Math.random() * 0.1, Math.random(), 0, f, null, 4);
      splat(0.84 + Math.random() * 0.1, Math.random(), 0, f, colour(0.05), 4);
    }

    step(dt);
    show();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!raf && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); }
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

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("scroll", function () {
    scroll = window.scrollY || 0;
  }, { passive: true });

  var lx = -1, ly = -1;
  window.addEventListener("pointermove", function (e) {
    if (e.pointerType === "touch") return; // touch scrolls the page; scroll drives the fluid instead
    var x = e.clientX / window.innerWidth, y = 1 - e.clientY / window.innerHeight;
    if (lx >= 0) { pdx += x - lx; pdy += y - ly; moved = true; }
    lx = mx = x;
    ly = my = y;
  }, { passive: true });

  document.documentElement.addEventListener("pointerleave", function () { lx = -1; });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else start();
  });

  for (var i = 0; i < 3; i++) ambient();
  start();
})();
