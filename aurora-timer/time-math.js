/*
 * Pure timing rules (no DOM). Shared by the page and the Node tests.
 *
 *  Seconds on screen   Aurora
 *  :59 → :54           fades out over 5 s
 *  :54 → :16           hidden (focus time)
 *  :15                 quick fade-in (~0.8 s)
 *  :15 → :00           fully visible
 */
(function (root) {
  'use strict';

  /** How long the aurora takes to appear when the seconds reach :15. */
  var FADE_IN_SECONDS = 0.8;

  /**
   * Fade-out begins the moment :59 appears (r = 60) and reaches zero the moment
   * :54 appears (r = 55) — 5 seconds.
   */
  var FADE_OUT_END = 55;

  /**
   * Whole seconds shown on screen. A 60-minute timer shows 59:59 the instant it
   * starts (never 60:00) and shows 00:00 during its final second.
   */
  function displaySeconds(remainingMs) {
    return remainingMs <= 0 ? 0 : Math.floor((remainingMs - 1) / 1000);
  }

  /** Position inside the current minute, in seconds: 59.999… → 0 (matches the seconds digits). */
  function secondsIntoMinute(remainingMs) {
    if (remainingMs <= 0) return 0;
    return (((remainingMs - 1) % 60000) + 1) / 1000 - 0.001;
  }

  function smooth(x) {
    var t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
  }

  /** Aurora opacity (0..1) for the given remaining time. */
  function auroraAlpha(remainingMs) {
    if (remainingMs <= 0) return 1;
    var r = secondsIntoMinute(remainingMs); // 0 ≤ r < 60
    if (r < 15) return 1;
    if (r < 16) return smooth((16 - r) / FADE_IN_SECONDS);
    if (r < FADE_OUT_END) return 0;
    return smooth((r - FADE_OUT_END) / (60 - FADE_OUT_END));
  }

  /** Milliseconds until the displayed seconds change. */
  function msUntilNextSecond(remainingMs) {
    return remainingMs <= 0 ? 0 : ((remainingMs - 1) % 1000) + 1;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** { mm: "59", ss: "59" } */
  function formatClock(remainingMs) {
    var s = displaySeconds(remainingMs);
    return { mm: pad2(Math.floor(s / 60)), ss: pad2(s % 60) };
  }

  var api = {
    FADE_IN_SECONDS: FADE_IN_SECONDS,
    FADE_OUT_END: FADE_OUT_END,
    displaySeconds: displaySeconds,
    auroraAlpha: auroraAlpha,
    msUntilNextSecond: msUntilNextSecond,
    formatClock: formatClock,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TimeMath = api;
})(this);
