/* Vidit Rawat portfolio behaviour: reel, slider, tabs, reveals, copy email. */
(function () {
  "use strict";
  var calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function play(v) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }

  /* Reel: crossfade through short clips, only while it is on screen. */
  var reel = $(".reel");
  if (reel && !calm) {
    var clips = JSON.parse(reel.dataset.clips), i = 0, timer = 0, yt = null;
    var pair = $$("video", reel), cap = $(".reel__cap", reel), bar = $(".reel__bar i", reel), DUR = 5500;
    var dropYt = function () { if (yt) { yt.remove(); yt = null; } };
    /* The official player, untouched: our caption and bar hide while it plays so
       nothing covers it, and the still behind it shows if autoplay is refused. */
    var showYt = function (c) {
      pair.forEach(function (v) { v.classList.remove("on"); v.pause(); });
      yt = document.createElement("iframe");
      yt.src = "https://www.youtube-nocookie.com/embed/" + c.yt + "?autoplay=1&mute=1&controls=0&playsinline=1&rel=0";
      yt.title = c.name;
      yt.allow = "autoplay; encrypted-media; picture-in-picture";
      yt.referrerPolicy = "strict-origin-when-cross-origin";
      reel.appendChild(yt);
      reel.classList.add("is-yt");
    };
    var showClip = function (c) {
      var next = pair[1], cur = pair[0];
      next.src = c.src;
      next.oncanplay = function () {
        next.oncanplay = null;
        next.classList.add("on");
        cur.classList.remove("on");
        dropYt();
      };
      play(next);
      pair.reverse();
      reel.classList.remove("is-yt");
      cap.textContent = c.name;
      if (bar.animate) bar.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: DUR, easing: "linear" });
    };
    var show = function () {
      var c = clips[i];
      if (c.yt) showYt(c); else showClip(c);
      i = (i + 1) % clips.length;
      timer = setTimeout(show, c.dur || DUR);
    };
    new IntersectionObserver(function (e) {
      clearTimeout(timer);
      if (e[0].isIntersecting) { i = 0; show(); }
      else { dropYt(); pair.forEach(function (v) { v.pause(); }); }
    }).observe(reel);
  }

  /* Slider: native scroll + snap; JS only tracks the active slide. */
  var track = $(".slider");
  if (track) {
    var slides = $$(".slide", track), out = $(".ctrl output"), live = $("#slide-live"), active = -1;
    var setActive = function (n) {
      if (n === active) return;
      active = n;
      slides.forEach(function (s, k) {
        s.classList.toggle("on", k === n);
        var v = $("video", s);
        if (!v || calm) return;
        if (k === n) {
          if (!v.getAttribute("src")) v.src = v.dataset.src;
          v.onplaying = function () { v.classList.add("on"); };
          play(v);
        } else v.pause();
      });
      out.textContent = "0" + (n + 1) + " / 0" + slides.length;
      live.textContent = "Project " + (n + 1) + " of " + slides.length + ": " + $("h3", slides[n]).textContent;
    };
    var go = function (n) {
      n = (n + slides.length) % slides.length;
      track.scrollTo({ left: slides[n].offsetLeft - track.offsetLeft, behavior: calm ? "auto" : "smooth" });
    };
    var seen = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) setActive(slides.indexOf(e.target)); });
    }, { root: track, threshold: 0.6 });
    slides.forEach(function (s) { seen.observe(s); });
    $("[data-prev]").onclick = function () { go(active - 1); };
    $("[data-next]").onclick = function () { go(active + 1); };
    track.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { e.preventDefault(); go(active - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); go(active + 1); }
    });
    setActive(0);
  }

  /* Tabs: ARIA pattern, indicator moved with transform only. */
  $$(".tabs").forEach(function (list) {
    var tabs = $$(".tab", list), ind = $(".tabs__ind", list), cards = $$("[data-tags]");
    function select(t, focus) {
      tabs.forEach(function (o) {
        o.setAttribute("aria-selected", o === t);
        o.tabIndex = o === t ? 0 : -1;
      });
      ind.style.width = t.offsetWidth + "px";
      ind.style.transform = "translateX(" + t.offsetLeft + "px)";
      var f = t.dataset.filter;
      cards.forEach(function (c) {
        c.hidden = f !== "all" && c.dataset.tags.indexOf(f) < 0;
        c.style.animation = "none";
        void c.offsetWidth; // restart the entrance animation
        c.style.animation = "";
      });
      if (focus) t.focus();
    }
    tabs.forEach(function (t, n) {
      t.onclick = function () { select(t); };
      t.onkeydown = function (e) {
        var to = { ArrowRight: n + 1, ArrowLeft: n - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        select(tabs[(to + tabs.length) % tabs.length], true);
      };
    });
    select(tabs[0]);
    addEventListener("resize", function () { select($('[aria-selected="true"]', list)); });
  });

  /* Card clips load on first hover or keyboard focus only. */
  $$("[data-video]").forEach(function (c) {
    var m = $(".card__m", c), v = null;
    function on() {
      if (calm) return;
      if (!v) {
        v = document.createElement("video");
        v.muted = v.loop = v.playsInline = true;
        v.setAttribute("aria-hidden", "true");
        v.src = c.dataset.video;
        v.onplaying = function () { v.classList.add("on"); };
        m.appendChild(v);
      }
      play(v);
    }
    function off() { if (v) { v.pause(); v.classList.remove("on"); } }
    c.addEventListener("mouseenter", on);
    c.addEventListener("mouseleave", off);
    c.addEventListener("focusin", on);
    c.addEventListener("focusout", off);
  });

  /* Only one case-study clip plays at a time. */
  var clipsOnPage = $$("video[controls]");
  clipsOnPage.forEach(function (v) {
    v.addEventListener("play", function () {
      clipsOnPage.forEach(function (o) { if (o !== v) o.pause(); });
    });
  });

  /* Reveal once. Without JS nothing is hidden, because only .js hides it. */
  var ups = $$("[data-up]");
  if (calm || !("IntersectionObserver" in window)) ups.forEach(function (u) { u.classList.add("in"); });
  else {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -6% 0px" });
    ups.forEach(function (u) { io.observe(u); });
  }

  /* Copy email with visible and announced feedback. */
  $$("[data-copy]").forEach(function (b) {
    b.onclick = function () {
      var label = b.querySelector("span");
      navigator.clipboard.writeText(b.dataset.copy).then(function () {
        label.textContent = "Copied";
        setTimeout(function () { label.textContent = "Copy"; }, 1800);
      });
    };
  });
})();
