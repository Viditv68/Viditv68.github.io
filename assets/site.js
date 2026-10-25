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
    window.matchMedia("(min-width: 1081px)").addEventListener("change", close);
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

  /* --- Nav: solid backdrop once the page scrolls under it ---------------
     The hero runs up beneath the nav, so over the hero the bar is fully
     transparent and the background art shows through. */
  function initNavState() {
    var nav = document.querySelector(".hud-nav");
    if (!nav || nav.classList.contains("hud-nav--solid")) return;

    var ticking = false;
    function apply() {
      ticking = false;
      nav.classList.toggle("is-stuck", (window.scrollY || window.pageYOffset || 0) > 24);
    }

    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(apply);
    }, { passive: true });

    apply();
  }

  /* --- Card spotlight ----------------------------------------------------
     Hover a project card: it lifts out of the grid, the still cross-fades to
     the clip, the rest of the page blurs behind a scrim, and the companion
     is told to bounce. Pointer devices only — see the media query in the CSS
     and the guard below. */
  function initSpotlight() {
    var cards = Array.prototype.slice.call(document.querySelectorAll(".card[data-video]"));
    if (!cards.length || reduceMotion) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    var scrim = document.createElement("div");
    scrim.className = "spotlight-scrim";
    scrim.setAttribute("aria-hidden", "true");
    document.body.appendChild(scrim);

    var active = null;
    var openTimer = 0;

    /* Nudge the card back inside the viewport if scaling it would push it
       off the edge — the outer column of a three-up grid otherwise grows
       straight past the right-hand side. */
    function positionFor(card, scale) {
      var r = card.getBoundingClientRect();
      var grow = (r.width * (scale - 1)) / 2;
      var pad = 16;
      var overLeft = pad - (r.left - grow);
      var overRight = (r.right + grow) - (window.innerWidth - pad);
      var dx = 0;
      if (overLeft > 0) dx = overLeft;
      else if (overRight > 0) dx = -overRight;
      card.style.setProperty("--sx", dx.toFixed(1) + "px");
      card.style.setProperty("--scale", String(scale));
    }

    /* The clip is only fetched the first time a card is actually hovered, so
       a page of cards costs nothing until someone shows interest. */
    function videoFor(card) {
      var existing = card.querySelector(".card__video");
      if (existing) return existing;

      var src = card.getAttribute("data-video");
      if (!src) return null;

      var v = document.createElement("video");
      v.className = "card__video";
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = "none";
      v.setAttribute("aria-hidden", "true");
      v.tabIndex = -1;
      v.src = src;
      v.addEventListener("playing", function () { v.classList.add("is-ready"); });
      card.querySelector(".card__media").appendChild(v);
      return v;
    }

    function open(card) {
      if (active === card) return;
      if (active) close(active);
      active = card;

      positionFor(card, 1.28);
      card.classList.add("is-spotlit");
      scrim.classList.add("is-on");

      var v = videoFor(card);
      if (v) {
        var p = v.play();
        if (p && p.catch) p.catch(function () { /* autoplay refused: keep the still */ });
      }
      if (window.__companion && window.__companion.setExcited) {
        window.__companion.setExcited(true);
      }
    }

    function close(card) {
      card.classList.remove("is-spotlit");
      card.style.removeProperty("--sx");
      card.style.removeProperty("--scale");

      var v = card.querySelector(".card__video");
      if (v) {
        v.classList.remove("is-ready");
        v.pause();
        v.currentTime = 0;
      }
      if (active === card) active = null;
      if (!active) {
        scrim.classList.remove("is-on");
        if (window.__companion && window.__companion.setExcited) {
          window.__companion.setExcited(false);
        }
      }
    }

    cards.forEach(function (card) {
      card.addEventListener("mouseenter", function () {
        clearTimeout(openTimer);
        /* Short intent delay so sweeping the cursor across the grid doesn't
           strobe every card on the way past. */
        openTimer = setTimeout(function () { open(card); }, 140);
      });

      card.addEventListener("mouseleave", function () {
        clearTimeout(openTimer);
        if (card.classList.contains("is-spotlit")) close(card);
      });
    });

    /* The card sits in normal flow, so vertical scrolling carries it along
       and nothing goes stale — only a width change invalidates the edge
       compensation, and by then the grid has reflowed anyway. */
    window.addEventListener("resize", function () {
      if (active) close(active);
    }, { passive: true });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && active) close(active);
    });
  }

  /* --- Shared: one rAF-throttled handler for scroll + resize ------------ */
  function onScrollFrame(fn) {
    var ticking = false;
    function request() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        fn();
      });
    }
    window.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request, { passive: true });
    // Web fonts change link and tab widths after first paint.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(request);
    fn();
  }

  /* --- XP bar: scroll progress ------------------------------------------ */
  function initXpBar() {
    var bar = document.createElement("div");
    bar.className = "xp-bar";
    bar.setAttribute("aria-hidden", "true");
    var fill = document.createElement("span");
    fill.className = "xp-bar__fill";
    bar.appendChild(fill);
    document.body.appendChild(bar);

    onScrollFrame(function () {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var p = max > 0 ? (window.scrollY || window.pageYOffset || 0) / max : 0;
      fill.style.setProperty("--p", Math.min(Math.max(p, 0), 1).toFixed(4));
    });
  }

  /* --- Scroll-spy: highlight the section in view ------------------------- */
  function initScrollSpy() {
    var links = Array.prototype.slice.call(document.querySelectorAll(".hud-nav__link[data-spy]"));
    if (!links.length) return;

    var indicator = document.querySelector(".hud-nav__indicator");
    var sections = links.map(function (l) {
      return document.querySelector(l.getAttribute("href"));
    });

    onScrollFrame(function () {
      var line = window.innerHeight * 0.35;
      var active = -1;
      sections.forEach(function (sec, i) {
        if (sec && sec.getBoundingClientRect().top <= line) active = i;
      });
      // The contact block is shorter than a screen, so it would never reach
      // the line on its own: at the very bottom, it wins.
      var doc = document.documentElement;
      if (window.innerHeight + (window.scrollY || 0) >= doc.scrollHeight - 4) {
        active = links.length - 1;
      }

      links.forEach(function (l, i) {
        l.classList.toggle("is-active", i === active);
        if (i === active) l.setAttribute("aria-current", "location");
        else l.removeAttribute("aria-current");
      });

      if (!indicator) return;
      if (active < 0) {
        indicator.classList.remove("is-on");
        return;
      }
      var a = links[active];
      indicator.style.setProperty("--x", (a.offsetLeft + 12) + "px");
      indicator.style.setProperty("--w", ((a.offsetWidth - 24) / 100).toFixed(3));
      indicator.classList.add("is-on");
    });
  }

  /* --- Hero name: per-letter entrance ------------------------------------ */
  function initSplitName() {
    var el = document.querySelector("[data-split]");
    if (!el || reduceMotion) return;

    var text = el.textContent.trim();
    // The spans are presentational; the heading keeps one readable name.
    el.setAttribute("aria-label", text);
    el.textContent = "";
    text.split("").forEach(function (ch, i) {
      if (ch === " ") {
        el.appendChild(document.createTextNode(" "));
        return;
      }
      var span = document.createElement("span");
      span.className = "ch";
      span.setAttribute("aria-hidden", "true");
      span.style.setProperty("--c", String(i));
      span.textContent = ch;
      el.appendChild(span);
    });
  }

  /* --- Featured slider ---------------------------------------------------
     Manual only (no autoplay): buttons, numbered rail, ←/→ while focus is
     inside, and touch swipe. Inactive slides are inert, so Tab never lands
     on a link nobody can see. The active slide's preview clip plays only
     while the slider is on screen. */
  function initSlider() {
    var root = document.querySelector("[data-slider]");
    if (!root) return;

    var slides = Array.prototype.slice.call(root.querySelectorAll(".slide"));
    var thumbs = Array.prototype.slice.call(root.querySelectorAll("[data-slide-to]"));
    var stage = root.querySelector(".slider__stage");
    var counter = root.querySelector("[data-slider-current]");
    var marker = root.querySelector(".slider__marker");
    var status = root.querySelector("[data-slider-status]");
    var count = slides.length;
    if (!count) return;

    var index = 0;
    var inView = false;
    var settleTimer = 0;

    function pad(n) {
      return (n < 10 ? "0" : "") + n;
    }

    function setInert(slide, on) {
      slide.inert = on;
      if (on) slide.setAttribute("aria-hidden", "true");
      else slide.removeAttribute("aria-hidden");
    }

    function videoFor(slide) {
      var media = slide.querySelector("[data-video]");
      if (!media) return null;
      var v = media.querySelector(".slide__video");
      if (v) return v;

      v = document.createElement("video");
      v.className = "slide__video";
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = "none";
      v.setAttribute("aria-hidden", "true");
      v.tabIndex = -1;
      v.src = media.getAttribute("data-video");
      v.addEventListener("playing", function () { v.classList.add("is-ready"); });
      media.appendChild(v);
      return v;
    }

    function syncVideo() {
      slides.forEach(function (slide, i) {
        var live = i === index && inView && !reduceMotion && !document.hidden;
        var v = live ? videoFor(slide) : slide.querySelector(".slide__video");
        if (!v) return;
        if (live) {
          var p = v.play();
          if (p && p.catch) p.catch(function () { /* autoplay refused: keep the still */ });
        } else if (!v.paused) {
          v.pause();
        }
      });
    }

    function updateUi() {
      thumbs.forEach(function (t, i) {
        if (i === index) t.setAttribute("aria-current", "true");
        else t.removeAttribute("aria-current");
      });
      if (counter) counter.textContent = pad(index + 1);
      if (marker) marker.style.setProperty("--i", String(index));
    }

    function go(n, dir, announce) {
      n = (n + count) % count;
      if (n === index) return;
      dir = dir || (n > index ? "next" : "prev");

      var from = slides[index];
      var to = slides[n];
      var hadFocus = from.contains(document.activeElement);

      from.classList.remove("is-active", "is-entering");
      from.classList.add("is-leaving");
      from.setAttribute("data-dir", dir);
      setInert(from, true);

      to.setAttribute("data-dir", dir);
      to.classList.remove("is-leaving", "is-entering");
      to.classList.add("is-active");
      setInert(to, false);
      if (!reduceMotion) {
        void to.offsetWidth; // restart the entrance if it was mid-flight
        to.classList.add("is-entering");
      }

      clearTimeout(settleTimer);
      settleTimer = setTimeout(function () {
        slides.forEach(function (s) {
          s.classList.remove("is-leaving", "is-entering");
        });
      }, reduceMotion ? 0 : 800);

      index = n;
      updateUi();
      syncVideo();

      // Focus was on a link in the slide that just went inert.
      if (hadFocus) to.focus({ preventScroll: true });

      if (announce && status) {
        var title = to.querySelector(".slide__title");
        status.textContent = "Project " + (n + 1) + " of " + count +
          (title ? ": " + title.textContent : "");
      }
    }

    slides.forEach(function (slide, i) {
      slide.tabIndex = -1;
      if (i === 0) slide.classList.add("is-active");
      else setInert(slide, true);
    });
    updateUi();

    root.querySelector("[data-slider-prev]").addEventListener("click", function () {
      go(index - 1, "prev", true);
    });
    root.querySelector("[data-slider-next]").addEventListener("click", function () {
      go(index + 1, "next", true);
    });
    thumbs.forEach(function (t) {
      t.addEventListener("click", function () {
        go(parseInt(t.getAttribute("data-slide-to"), 10), null, true);
      });
    });

    root.addEventListener("keydown", function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(index - 1, "prev", true);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(index + 1, "next", true);
      }
    });

    // Swipe. Horizontal intent only — vertical drags stay page scrolls
    // (touch-action: pan-y on the stage). A swipe that started on a link
    // must not also follow it.
    var sx = 0, sy = 0, tracking = false, swallowClick = false;
    stage.style.touchAction = "pan-y";
    stage.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse") return;
      tracking = true;
      sx = e.clientX;
      sy = e.clientY;
    });
    stage.addEventListener("pointerup", function (e) {
      if (!tracking) return;
      tracking = false;
      var dx = e.clientX - sx;
      var dy = e.clientY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        swallowClick = true;
        setTimeout(function () { swallowClick = false; }, 400);
        go(index + (dx < 0 ? 1 : -1), dx < 0 ? "next" : "prev", true);
      }
    });
    stage.addEventListener("pointercancel", function () { tracking = false; });
    stage.addEventListener("click", function (e) {
      if (swallowClick) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        inView = entries[0].isIntersecting;
        syncVideo();
      }, { threshold: 0.35 }).observe(stage);
    }
    document.addEventListener("visibilitychange", syncVideo);
  }

  /* --- Project tabs (ARIA tabs, automatic activation) ------------------- */
  function initTabs() {
    var root = document.querySelector("[data-tabs]");
    if (!root) return;

    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    var panel = root.querySelector('[role="tabpanel"]');
    var indicator = root.querySelector(".tabs__indicator");
    var cards = Array.prototype.slice.call(panel.querySelectorAll("[data-cat]"));
    var active = tabs[0];

    function place() {
      if (!indicator || !active) return;
      indicator.style.setProperty("--x", active.offsetLeft + "px");
      indicator.style.setProperty("--w", (active.offsetWidth / 100).toFixed(3));
    }

    function select(tab, opts) {
      opts = opts || {};
      active = tab;
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
      });
      panel.setAttribute("aria-labelledby", tab.id);

      var filter = tab.getAttribute("data-filter");
      var n = 0;
      cards.forEach(function (card) {
        var show = card.getAttribute("data-cat").split(" ").indexOf(filter) !== -1;
        card.hidden = !show;
        if (show) card.style.setProperty("--n", String(Math.min(n++, 8)));
      });

      if (opts.animate && !reduceMotion) {
        panel.classList.remove("is-switching");
        void panel.offsetWidth;
        panel.classList.add("is-switching");
      }
      place();
      if (opts.focus) {
        tab.focus();
        // The bar scrolls sideways on phones; keep the focused tab in it.
        if (tab.scrollIntoView) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }

    panel.addEventListener("animationend", function (e) {
      if (e.target === panel) panel.classList.remove("is-switching");
    });

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () {
        if (tab !== active) select(tab, { animate: true });
      });

      tab.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") next = tabs[0];
        else if (e.key === "End") next = tabs[tabs.length - 1];
        if (!next) return;
        e.preventDefault();
        select(next, { animate: true, focus: true });
      });
    });

    select(active);
    onScrollFrame(place);
  }

  /* --- Experience timeline: line draws with scroll ------------------------ */
  function initTimeline() {
    var root = document.querySelector("[data-timeline]");
    if (!root) return;

    var track = root.querySelector(".quest__track");
    var fill = root.querySelector(".quest__fill");
    var items = Array.prototype.slice.call(root.querySelectorAll(".quest__item"));

    if (reduceMotion) {
      fill.style.setProperty("--p", "1");
      items.forEach(function (it) { it.classList.add("is-lit"); });
      return;
    }

    onScrollFrame(function () {
      var r = track.getBoundingClientRect();
      // The pen sits 60% of the way down the viewport.
      var pen = window.innerHeight * 0.6;
      var p = Math.min(Math.max((pen - r.top) / (r.height || 1), 0), 1);
      fill.style.setProperty("--p", p.toFixed(4));

      var tip = r.top + p * r.height;
      items.forEach(function (it) {
        var node = it.querySelector(".quest__node").getBoundingClientRect();
        it.classList.toggle("is-lit", node.top + node.height / 2 <= tip + 1);
      });
    });
  }

  /* --- Copy email to clipboard ------------------------------------------- */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  // Plain-http preview, older browser, or a refused permission: the
  // textarea route still works in most of them.
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function initCopyEmail() {
    document.querySelectorAll("[data-copy]").forEach(function (btn) {
      var label = btn.querySelector("[data-copy-label]");
      var status = btn.parentNode.querySelector("[data-copy-status]");
      var timer = 0;

      btn.addEventListener("click", function () {
        copyText(btn.getAttribute("data-copy")).then(function (ok) {
          btn.classList.toggle("is-copied", ok);
          if (label) label.textContent = ok ? "Copied" : "Copy failed";
          if (status) {
            status.textContent = ok
              ? "Email address copied to clipboard."
              : "Copy failed. The address is selected; press Ctrl+C to copy it.";
          }
          // Last resort: leave the address selected for a manual copy.
          var addr = btn.parentNode.querySelector("a[href^='mailto:']");
          if (!ok && addr && window.getSelection) {
            var range = document.createRange();
            range.selectNodeContents(addr);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
          }
          clearTimeout(timer);
          timer = setTimeout(function () {
            btn.classList.remove("is-copied");
            if (label) label.textContent = "Copy";
            if (status) status.textContent = "";
          }, 2400);
        });
      });
    });
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
    initNavState();
    initXpBar();
    initScrollSpy();
    initSplitName();
    initSlider();
    initTabs();
    initTimeline();
    initCopyEmail();
    initSpotlight();
    initYear();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
