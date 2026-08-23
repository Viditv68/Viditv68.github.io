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

  /* --- Hero background --------------------------------------------------
     Pure CSS now — see the `.hero-fx` block in site.css. The only thing left
     for JS is stopping the animations while the tab is in the background;
     browsers throttle rAF there but keep CSS animations running, and these
     are large blurred layers. */
  function initHeroBackground() {
    var hero = document.querySelector(".hero");
    if (!hero) return;

    document.addEventListener("visibilitychange", function () {
      hero.classList.toggle("is-paused", document.hidden);
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
    initHeroBackground();
    initYear();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
