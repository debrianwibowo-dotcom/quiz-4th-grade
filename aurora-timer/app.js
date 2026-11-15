/* Aurora Focus — countdown timer UI, clock loop, wake lock, chime. */
(function () {
  'use strict';

  var TM = window.TimeMath;
  var MIN_MINUTES = 1;
  var MAX_MINUTES = 60;
  var PRESETS = [5, 15, 25, 30, 45, 60];
  var SETUP_AURORA_ALPHA = 0.35;
  /** Digit opacity while the background is black; rises to 1 with the aurora. */
  var DIGITS_DIM_OPACITY = 0.3;
  var LONG_PRESS_MS = 600;
  var START_HINT_MS = 4000;
  var STORAGE_KEY = 'auroraFocus.v1';

  function $(id) { return document.getElementById(id); }
  var els = {
    canvas: $('aurora'),
    setup: $('setup'),
    timer: $('timer'),
    wheel: $('wheel'),
    presets: $('presets'),
    start: $('start'),
    note: $('note'),
    digits: $('digits'),
    mm: $('mm'),
    ss: $('ss'),
    hint: $('hint'),
    confirm: $('confirm'),
    confirmStop: $('confirm-stop'),
    confirmKeep: $('confirm-keep'),
  };

  function clampMinutes(m) {
    m = Math.round(Number(m));
    if (!isFinite(m)) m = 25;
    return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, m));
  }

  // ---------------------------------------------------------------------------
  // State (+ localStorage so a reload keeps the running timer)
  // ---------------------------------------------------------------------------

  var state = { phase: 'setup', minutes: 25, endAt: 0, pausedRemaining: 0 };

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* storage unavailable: fine */ }
  }

  function restore() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { saved = null; }
    if (!saved || typeof saved !== 'object') return;
    state.minutes = clampMinutes(saved.minutes);
    if (saved.phase === 'running' && saved.endAt > 0) {
      state.endAt = saved.endAt;
      state.phase = saved.endAt > Date.now() ? 'running' : 'done';
    } else if (saved.phase === 'paused' && saved.pausedRemaining > 0) {
      state.phase = 'paused';
      state.pausedRemaining = saved.pausedRemaining;
    }
  }

  function remaining(now) {
    switch (state.phase) {
      case 'running': return Math.max(0, state.endAt - (now || Date.now()));
      case 'paused': return state.pausedRemaining;
      case 'done': return 0;
      default: return state.minutes * 60000;
    }
  }

  function isActive() { return state.phase !== 'setup'; }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  var finishTimer = 0;
  var startHintUntil = 0;

  function start() {
    unlockAudio();
    state.endAt = Date.now() + state.minutes * 60000;
    state.pausedRemaining = 0;
    state.phase = 'running';
    startHintUntil = Date.now() + START_HINT_MS;
    setTimeout(render, START_HINT_MS + 50);
    afterPhaseChange();
    scheduleFinish();
    requestWakeLock();
    enterFullscreen();
    try { history.pushState({ auroraTimer: true }, ''); } catch (e) { /* ignore */ }
  }

  function togglePause() {
    if (state.phase === 'running') {
      clearTimeout(finishTimer);
      state.pausedRemaining = remaining();
      state.phase = 'paused';
    } else if (state.phase === 'paused') {
      state.endAt = Date.now() + state.pausedRemaining;
      state.phase = 'running';
      scheduleFinish();
    }
    afterPhaseChange();
  }

  function finish() {
    if (state.phase !== 'running') return;
    clearTimeout(finishTimer);
    state.phase = 'done';
    afterPhaseChange();
    playChime();
    try { if (navigator.vibrate) navigator.vibrate([250, 180, 250, 180, 600]); } catch (e) { /* ignore */ }
  }

  function reset() {
    clearTimeout(finishTimer);
    closeConfirm();
    state.phase = 'setup';
    state.endAt = 0;
    state.pausedRemaining = 0;
    afterPhaseChange();
    releaseWakeLock();
    exitFullscreen();
    if (history.state && history.state.auroraTimer) {
      try { history.back(); } catch (e) { /* ignore */ }
    }
  }

  function scheduleFinish() {
    clearTimeout(finishTimer);
    finishTimer = setTimeout(finish, remaining() + 20);
  }

  function afterPhaseChange() {
    persist();
    render();
    kick();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  var lastShown = { mm: '', ss: '' };
  var shownPhase = null;

  function render() {
    var active = isActive();
    els.setup.hidden = active;
    els.timer.hidden = !active;
    document.body.dataset.phase = state.phase;

    if (!active && shownPhase !== 'setup') {
      // Wheel can only be measured once visible.
      requestAnimationFrame(syncWheel);
    }
    shownPhase = state.phase;

    els.digits.classList.toggle('is-paused', state.phase === 'paused');
    updateDigits(remaining());

    var hint = '';
    if (state.phase === 'paused') hint = 'PAUSED · tap to resume · hold to stop';
    else if (state.phase === 'done') hint = 'DONE · tap to dismiss';
    else if (state.phase === 'running' && Date.now() < startHintUntil) hint = 'tap to pause · hold to stop';
    if (hint) els.hint.textContent = hint;
    els.hint.classList.toggle('is-visible', !!hint);

    updatePresets();
  }

  function updateDigits(ms) {
    var c = TM.formatClock(ms);
    if (c.mm !== lastShown.mm) els.mm.textContent = lastShown.mm = c.mm;
    if (c.ss !== lastShown.ss) els.ss.textContent = lastShown.ss = c.ss;
  }

  function currentAlpha(ms) {
    if (state.phase === 'setup') return SETUP_AURORA_ALPHA;
    if (state.phase === 'done') return 1;
    return TM.auroraAlpha(ms);
  }

  // ---------------------------------------------------------------------------
  // Clock / animation loop.
  // Runs every frame while the aurora is visible; while it is hidden (:54 → :16)
  // it wakes only once per second to update the digits.
  // ---------------------------------------------------------------------------

  var aurora = new window.Aurora(els.canvas, { renderScale: 0.5 });
  var rafId = 0;
  var timeoutId = 0;
  var lastTs = 0;
  var auroraTime = 0;

  function kick() {
    cancelAnimationFrame(rafId);
    clearTimeout(timeoutId);
    rafId = requestAnimationFrame(frame);
  }

  function frame(ts) {
    rafId = 0;
    var ms = remaining();
    if (state.phase === 'running' && ms <= 0) {
      finish();
      return;
    }
    updateDigits(ms);

    var alpha = currentAlpha(ms);
    els.canvas.style.opacity = alpha.toFixed(3);
    if (state.phase !== 'setup') {
      els.digits.style.opacity = (DIGITS_DIM_OPACITY + (1 - DIGITS_DIM_OPACITY) * alpha).toFixed(3);
    }

    var dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0;
    lastTs = ts;
    if (alpha > 0) {
      auroraTime += dt;
      aurora.render(auroraTime);
    }

    if (document.hidden) {
      lastTs = 0;
      return;
    }
    if (alpha > 0) {
      rafId = requestAnimationFrame(frame);
    } else if (state.phase === 'running') {
      lastTs = 0;
      timeoutId = setTimeout(function () {
        rafId = requestAnimationFrame(frame);
      }, TM.msUntilNextSecond(ms));
    }
    // paused while hidden: nothing changes, so no loop.
  }

  function onResize() {
    aurora.resize();
    if (!isActive()) syncWheel();
    kick();
  }

  // ---------------------------------------------------------------------------
  // Minute wheel — custom spinner driven by touch / mouse drag (with fling),
  // mouse wheel, taps and keyboard.
  //
  // The position is kept in *item units* (0 = "1 min" centred), never derived
  // from scroll offsets or transformed (scaled) element sizes.
  // ---------------------------------------------------------------------------

  var MAX_INDEX = MAX_MINUTES - MIN_MINUTES;
  var wheelItems = [];
  var itemH = 0;            // layout height of one row, in px
  var wheelPos = 0;         // fractional index of the centred row
  var wheelTarget = 0;      // where the current animation is heading
  var wheelAnim = 0;
  var drag = null;
  var wheelAccum = 0;

  function clampIndex(i) {
    return Math.min(MAX_INDEX, Math.max(0, i));
  }

  function buildWheel() {
    var track = document.createElement('div');
    track.className = 'wheel__track';
    for (var m = MIN_MINUTES; m <= MAX_MINUTES; m++) {
      var el = document.createElement('div');
      el.className = 'wheel__item';
      el.id = 'wheel-m' + m;
      el.textContent = String(m);
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', m === state.minutes ? 'true' : 'false');
      wheelItems.push(el);
      track.appendChild(el);
    }
    els.wheel.appendChild(track);
    els.track = track;
    els.wheel.setAttribute('aria-activedescendant', 'wheel-m' + state.minutes);
    wheelPos = wheelTarget = state.minutes - MIN_MINUTES;
  }

  function measureWheel() {
    // The track is only translated (never scaled), so its height / row count is
    // the exact sub-pixel row height. (A row's own rect is shrunk by its scale(),
    // and offsetHeight is rounded — both drift over 60 rows.)
    if (!els.track || !wheelItems.length) return;
    var h = els.track.getBoundingClientRect().height / wheelItems.length;
    if (h) itemH = h;
  }

  /** Draw the wheel at wheelPos. `select` = also commit the centred value. */
  function renderWheel(select) {
    if (!itemH) measureWheel();
    if (!itemH) return;
    var centre = (els.wheel.clientHeight - itemH) / 2;
    els.track.style.transform = 'translate3d(0,' + (centre - wheelPos * itemH).toFixed(2) + 'px,0)';
    for (var i = 0; i < wheelItems.length; i++) {
      var el = wheelItems[i];
      var d = Math.abs(i - wheelPos);
      // Rows far from the centre are invisible (but keep their space in the track).
      if (d > 3.5) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        continue;
      }
      if (el.style.visibility) el.style.visibility = '';
      el.style.transform = 'scale(' + (1 - 0.22 * Math.min(d, 2)).toFixed(3) + ')';
      el.style.opacity = Math.max(0.12, 1 - 0.38 * d).toFixed(3);
    }
    if (select) selectMinutes(clampIndex(Math.round(wheelPos)) + MIN_MINUTES);
  }

  function selectMinutes(m) {
    if (m === state.minutes) return;
    var prev = document.getElementById('wheel-m' + state.minutes);
    if (prev) prev.setAttribute('aria-selected', 'false');
    state.minutes = m;
    var cur = document.getElementById('wheel-m' + m);
    if (cur) cur.setAttribute('aria-selected', 'true');
    els.wheel.setAttribute('aria-activedescendant', 'wheel-m' + m);
    persist();
    updatePresets();
  }

  function stopWheelAnim() {
    cancelAnimationFrame(wheelAnim);
    wheelAnim = 0;
  }

  /** Animate to a row (index). The value is committed immediately. */
  function wheelTo(index) {
    index = clampIndex(Math.round(index));
    stopWheelAnim();
    wheelTarget = index;
    selectMinutes(index + MIN_MINUTES);
    var from = wheelPos;
    var delta = index - from;
    if (Math.abs(delta) < 0.001 || !itemH) {
      wheelPos = index;
      renderWheel(false);
      return;
    }
    var duration = Math.min(900, 220 + Math.sqrt(Math.abs(delta)) * 130);
    var t0 = performance.now();
    function step(now) {
      var t = Math.min(1, (now - t0) / duration);
      wheelPos = from + delta * (1 - Math.pow(1 - t, 3)); // ease-out cubic
      renderWheel(false);
      wheelAnim = t < 1 ? requestAnimationFrame(step) : 0;
    }
    wheelAnim = requestAnimationFrame(step);
  }

  function currentWheelIndex() {
    return wheelAnim ? wheelTarget : clampIndex(Math.round(wheelPos));
  }

  /** Past either end the wheel stretches (rubber band) instead of moving freely. */
  function rubberBand(raw) {
    if (raw < 0) return raw * 0.3;
    if (raw > MAX_INDEX) return MAX_INDEX + (raw - MAX_INDEX) * 0.3;
    return raw;
  }

  function bindWheel() {
    var w = els.wheel;

    w.addEventListener('pointerdown', function (e) {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      stopWheelAnim();
      measureWheel();
      drag = { id: e.pointerId, startY: e.clientY, startPos: wheelPos, moved: false, samples: [{ t: e.timeStamp, y: e.clientY }] };
      try { w.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      w.classList.add('is-dragging');
      w.focus({ preventScroll: true });
    });

    w.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id || !itemH) return;
      var dy = e.clientY - drag.startY;
      if (Math.abs(dy) > 5) drag.moved = true;
      wheelPos = rubberBand(drag.startPos - dy / itemH);
      drag.samples.push({ t: e.timeStamp, y: e.clientY });
      if (drag.samples.length > 8) drag.samples.shift();
      renderWheel(true);
    });

    function endDrag(e, cancelled) {
      if (!drag || e.pointerId !== drag.id) return;
      var d = drag;
      drag = null;
      w.classList.remove('is-dragging');

      if (!d.moved && !cancelled) {
        // Tap: jump to the tapped row.
        var rect = w.getBoundingClientRect();
        var rows = Math.round((e.clientY - (rect.top + rect.height / 2)) / itemH);
        wheelTo(Math.round(wheelPos) + rows);
        return;
      }

      // Fling: velocity over the last ~100 ms, in rows per ms.
      var s = d.samples;
      var last = s[s.length - 1];
      var first = last;
      for (var i = s.length - 1; i >= 0 && last.t - s[i].t <= 100; i--) first = s[i];
      var dt = last.t - first.t;
      var v = dt > 0 ? -(last.y - first.y) / itemH / dt : 0;
      if (cancelled || e.timeStamp - last.t > 90) v = 0; // finger paused before lifting
      wheelTo(wheelPos + v * 280);
    }
    w.addEventListener('pointerup', function (e) { endDrag(e, false); });
    w.addEventListener('pointercancel', function (e) { endDrag(e, true); });

    // Mouse wheel / trackpad: one row per notch (~80–100 px of scroll).
    var WHEEL_STEP_PX = 80;
    var lastWheelAt = 0;
    w.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.timeStamp - lastWheelAt > 250) wheelAccum = 0; // new gesture
      lastWheelAt = e.timeStamp;
      wheelAccum += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      var steps = wheelAccum > 0 ? Math.floor(wheelAccum / WHEEL_STEP_PX) : Math.ceil(wheelAccum / WHEEL_STEP_PX);
      if (steps) {
        wheelAccum -= steps * WHEEL_STEP_PX;
        wheelTo(currentWheelIndex() + steps);
      }
    }, { passive: false });

    w.addEventListener('keydown', function (e) {
      var k = e.key;
      var delta = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : k === 'PageUp' ? -5 : k === 'PageDown' ? 5 : 0;
      if (delta) {
        e.preventDefault();
        wheelTo(currentWheelIndex() + delta);
      } else if (k === 'Home' || k === 'End') {
        e.preventDefault();
        wheelTo(k === 'Home' ? 0 : MAX_INDEX);
      } else if (k === 'Enter') {
        start();
      }
    });
  }

  /** Re-sync the wheel after layout changes (shown again, resize, rotation). */
  function syncWheel() {
    measureWheel();
    if (!drag && !wheelAnim) wheelPos = wheelTarget = state.minutes - MIN_MINUTES;
    renderWheel(false);
  }

  function buildPresets() {
    PRESETS.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.textContent = String(m);
      b.dataset.m = String(m);
      b.setAttribute('aria-label', m + ' minutes');
      b.addEventListener('click', function () { wheelTo(m - MIN_MINUTES); });
      els.presets.appendChild(b);
    });
  }

  function updatePresets() {
    var buttons = els.presets.children;
    for (var i = 0; i < buttons.length; i++) {
      var on = Number(buttons[i].dataset.m) === state.minutes;
      buttons[i].classList.toggle('is-selected', on);
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // ---------------------------------------------------------------------------
  // Timer-screen gestures: tap = pause/resume (or dismiss), long-press = stop
  // ---------------------------------------------------------------------------

  var press = { timer: 0, x: 0, y: 0 };

  function onTimerTap() {
    if (!els.confirm.hidden) return;
    if (state.phase === 'done') reset();
    else togglePause();
  }

  function cancelPress() {
    clearTimeout(press.timer);
    press.timer = 0;
  }

  function bindTimerGestures() {
    var t = els.timer;
    t.addEventListener('pointerdown', function (e) {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      press.x = e.clientX;
      press.y = e.clientY;
      cancelPress();
      press.timer = setTimeout(function () {
        press.timer = 0;
        if (state.phase === 'running' || state.phase === 'paused') {
          try { if (navigator.vibrate) navigator.vibrate(30); } catch (err) { /* ignore */ }
          openConfirm();
        }
      }, LONG_PRESS_MS);
    });
    t.addEventListener('pointermove', function (e) {
      if (press.timer && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 14) cancelPress();
    });
    t.addEventListener('pointerup', function () {
      if (press.timer) {
        cancelPress();
        onTimerTap();
      }
    });
    t.addEventListener('pointercancel', cancelPress);
    t.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  // ---------------------------------------------------------------------------
  // Stop confirmation
  // ---------------------------------------------------------------------------

  var confirmOpenedAt = 0;

  function openConfirm() {
    if (!els.confirm.hidden) return;
    confirmOpenedAt = Date.now();
    els.confirm.hidden = false;
    els.confirmKeep.focus({ preventScroll: true });
  }

  function closeConfirm() {
    els.confirm.hidden = true;
  }

  function bindConfirm() {
    els.confirmStop.addEventListener('click', reset);
    els.confirmKeep.addEventListener('click', closeConfirm);
    els.confirm.addEventListener('click', function (e) {
      // Ignore the click generated by releasing the long-press that opened it.
      if (e.target === els.confirm && Date.now() - confirmOpenedAt > 400) closeConfirm();
    });
  }

  // ---------------------------------------------------------------------------
  // Keep the screen awake (Screen Wake Lock API)
  // ---------------------------------------------------------------------------

  var wakeLock = null;
  var wakeLockSupported = 'wakeLock' in navigator;

  function requestWakeLock() {
    if (!wakeLockSupported || wakeLock || document.hidden) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      if (!isActive()) { lock.release(); return; }
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { /* denied (e.g. battery saver): ignore */ });
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(function () {});
      wakeLock = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Fullscreen (phones/tablets only; iPhone Safari doesn't support it — harmless)
  // ---------------------------------------------------------------------------

  var isTouchDevice = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  function enterFullscreen() {
    if (!isTouchDevice) return;
    var el = document.documentElement;
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req || document.fullscreenElement || document.webkitFullscreenElement) return;
    try {
      var p = req.call(el, { navigationUI: 'hide' });
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function exitFullscreen() {
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit && (document.fullscreenElement || document.webkitFullscreenElement)) {
      try {
        var p = exit.call(document);
        if (p && p.catch) p.catch(function () {});
      } catch (e) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Gentle end chime (Web Audio, synthesized — no audio files)
  // ---------------------------------------------------------------------------

  var audioCtx = null;

  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      // A silent blip inside the user gesture unlocks audio on iOS.
      var buf = audioCtx.createBuffer(1, 1, 22050);
      var src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.start(0);
    } catch (e) { /* ignore */ }
  }

  function playChime() {
    if (!audioCtx) return;
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var master = audioCtx.createGain();
      master.gain.value = 0.5;
      master.connect(audioCtx.destination);
      var t0 = audioCtx.currentTime + 0.05;
      // E5, G#5, B5, E6 — a soft major arpeggio.
      [[659.25, 0], [830.61, 0.18], [987.77, 0.36], [1318.51, 0.62]].forEach(function (n) {
        bell(master, n[0], t0 + n[1]);
      });
    } catch (e) { /* ignore */ }
  }

  function bell(out, freq, t) {
    [[1, 0.28], [2.01, 0.06]].forEach(function (partial) {
      var osc = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * partial[0];
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(partial[1], t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + 1.9);
    });
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function bindGlobal() {
    els.start.addEventListener('click', start);

    document.addEventListener('keydown', function (e) {
      if (!isActive()) return;
      if (e.key === 'Escape') {
        if (!els.confirm.hidden) closeConfirm();
        else if (state.phase === 'done') reset();
        else openConfirm();
      } else if ((e.key === ' ' || e.key === 'Enter') && els.confirm.hidden) {
        e.preventDefault();
        onTimerTap();
      }
    });

    // Android back button / gesture while a timer is on screen.
    window.addEventListener('popstate', function () {
      if (state.phase === 'running' || state.phase === 'paused') {
        try { history.pushState({ auroraTimer: true }, ''); } catch (e) { /* ignore */ }
        openConfirm();
      } else if (state.phase === 'done') {
        reset();
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (isActive()) requestWakeLock();
      kick();
    });

    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onResize);
  }

  function init() {
    restore();
    buildWheel();
    bindWheel();
    buildPresets();
    bindTimerGestures();
    bindConfirm();
    bindGlobal();

    if (!wakeLockSupported) {
      els.note.hidden = false;
      els.note.textContent = "This browser can't keep the screen awake. Set a longer screen timeout before starting.";
    }

    if (state.phase === 'running') {
      scheduleFinish();
      requestWakeLock();
    }
    if (isActive()) {
      try { history.pushState({ auroraTimer: true }, ''); } catch (e) { /* ignore */ }
    }

    render();
    kick();
  }

  init();
})();
