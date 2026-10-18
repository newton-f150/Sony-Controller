/* PlayStation Controller Monitoring Dashboard — frontend only.
 *
 * No backend, no network calls. Everything runs in the browser:
 *   - Gamepad API polling (USB and Bluetooth both feed the same path)
 *   - Local event log (in-memory, capped)
 *   - Stats, activity chart, per-button ranking
 *   - CSV / JSON export via Blob download
 *   - Settings persisted in localStorage
 *
 * Every UI command (Start, Stop, Clear, Refresh, Export, Filters, Settings)
 * works without any server. The controller keeps being monitored while the
 * page is open.
 */
(function () {
  'use strict';

  /* =========================================================
   * 1. SETTINGS (localStorage-backed)
   * ========================================================= */
  const Settings = (() => {
    const DEFAULTS = {
      deadZone: 0.15,
      axisThreshold: 0.2,
      axisInterval: 100,
      pressThreshold: 0.5,
      releaseThreshold: 0.35,
      debounceMs: 30,
      maxLogs: 500,
      utcTimestamps: false,
    };
    const KEY = 'ps-controller-dashboard.settings.v2';
    const listeners = new Set();
    let current;

    function clamp(n, min, max, fb) {
      if (!isFinite(n)) return fb;
      return Math.min(max, Math.max(min, n));
    }
    function validate(s) {
      const o = { ...DEFAULTS, ...s };
      o.deadZone = clamp(Number(o.deadZone), 0, 0.5, DEFAULTS.deadZone);
      o.axisThreshold = clamp(Number(o.axisThreshold), 0, 1, DEFAULTS.axisThreshold);
      o.axisInterval = clamp(Number(o.axisInterval), 16, 2000, DEFAULTS.axisInterval);
      o.pressThreshold = clamp(Number(o.pressThreshold), 0, 1, DEFAULTS.pressThreshold);
      o.releaseThreshold = clamp(Number(o.releaseThreshold), 0, 1, DEFAULTS.releaseThreshold);
      o.debounceMs = clamp(Number(o.debounceMs), 0, 250, DEFAULTS.debounceMs);
      o.maxLogs = Math.round(clamp(Number(o.maxLogs), 50, 5000, DEFAULTS.maxLogs));
      o.utcTimestamps = !!o.utcTimestamps;
      return o;
    }
    function load() {
      try {
        const raw = localStorage.getItem(KEY);
        return validate(raw ? JSON.parse(raw) : {});
      } catch (e) {
        return validate({});
      }
    }
    function notify() {
      const snap = { ...current };
      listeners.forEach((fn) => { try { fn(snap); } catch (e) { console.error(e); } });
    }
    current = load();
    return {
      get: () => ({ ...current }),
      set(patch) {
        current = validate({ ...current, ...patch });
        try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (e) { /* ignore */ }
        notify();
        return { ...current };
      },
      reset() {
        current = validate({});
        try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
        notify();
        return { ...current };
      },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      DEFAULTS,
    };
  })();

  /* =========================================================
   * 2. EVENT LOGGER (in-memory, no server)
   * ========================================================= */
  const EventLogger = (() => {
    const MAX_EVENTS = 5000;
    let settings = Settings.get();
    const events = [];
    let paused = false;
    let sortDesc = true;
    let searchTerm = '';
    let typeFilter = '';
    let controllerFilter = '';
    let timeFilterMs = 0;
    const listeners = new Set();

    function notify() {
      const snap = snapshot();
      listeners.forEach((fn) => { try { fn(snap); } catch (e) { console.error(e); } });
    }
    function snapshot() {
      return {
        total: events.length, paused, sortDesc,
        presses: events.filter((e) => e.eventType === 'buttondown').length,
        releases: events.filter((e) => e.eventType === 'buttonup').length,
      };
    }
    function add(event) {
      if (events.length >= MAX_EVENTS) events.shift();
      events.push(event);
      notify();
    }
    function filtered() {
      const now = Date.now();
      return events.filter((e) => {
        if (typeFilter && e.eventType !== typeFilter) return false;
        if (controllerFilter !== '' && String(e.controllerIndex) !== String(controllerFilter)) return false;
        if (timeFilterMs > 0) {
          const t = new Date(e.clientTimestamp).getTime();
          if (now - t > timeFilterMs) return false;
        }
        if (searchTerm) {
          const q = searchTerm.toLowerCase();
          const hay = `${e.controlName || ''} ${e.eventType || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }
    function toCSV(list) {
      const headers = ['eventId','sessionId','controllerId','controllerIndex','transport','eventType','controlName','controlIndex','prevValue','newValue','state','clientTimestamp'];
      const rows = [headers.join(',')];
      for (const e of list) {
        rows.push(headers.map((h) => '"' + String(e[h] == null ? '' : e[h]).replace(/"/g, '""') + '"').join(','));
      }
      return rows.join('\n');
    }
    function toJSON(list) { return JSON.stringify(list, null, 2); }
    function formatTime(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (settings.utcTimestamps) return d.toISOString().replace('T', ' ').replace('Z', ' UTC');
      return d.toLocaleTimeString();
    }
    function applySettings(next) { settings = { ...settings, ...next }; notify(); }

    return {
      add, snapshot, filtered, toCSV, toJSON, formatTime, applySettings, events,
      setPaused(v) { paused = !!v; notify(); },
      setSort(desc) { sortDesc = !!desc; notify(); },
      setSearch(s) { searchTerm = String(s || ''); notify(); },
      setTypeFilter(t) { typeFilter = String(t || ''); notify(); },
      setControllerFilter(c) { controllerFilter = String(c || ''); notify(); },
      setTimeFilter(ms) { timeFilterMs = Number(ms) || 0; notify(); },
      clear() { events.length = 0; notify(); },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
  })();

  /* =========================================================
   * 3. DASHBOARD STATS
   * ========================================================= */
  const DashboardStats = (() => {
    let startTime = Date.now();
    let presses = 0, releases = 0;
    const perButton = new Map();
    const buckets = new Array(60).fill(0);
    let bucketSec = Math.floor(Date.now() / 1000);

    function rollBuckets() {
      const nowSec = Math.floor(Date.now() / 1000);
      while (bucketSec < nowSec) {
        bucketSec += 1;
        buckets.shift(); buckets.push(0);
      }
    }
    function record(eventType, controlName) {
      rollBuckets();
      buckets[buckets.length - 1] += 1;
      if (eventType === 'buttondown') presses += 1;
      else if (eventType === 'buttonup') releases += 1;
      if (controlName) {
        const entry = perButton.get(controlName) || { presses: 0, releases: 0 };
        if (eventType === 'buttondown') entry.presses += 1;
        else if (eventType === 'buttonup') entry.releases += 1;
        perButton.set(controlName, entry);
      }
    }
    function sessionDuration() {
      const s = Math.floor((Date.now() - startTime) / 1000);
      const hh = String(Math.floor(s / 3600)).padStart(2, '0');
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    }
    function ranking() {
      return [...perButton.entries()]
        .map(([name, v]) => ({ name, total: v.presses + v.releases }))
        .sort((a, b) => b.total - a.total).slice(0, 8);
    }
    return {
      record, rollBuckets, sessionDuration, ranking, buckets,
      getPresses: () => presses, getReleases: () => releases,
      reset() {
        startTime = Date.now();
        presses = 0; releases = 0;
        perButton.clear();
        for (let i = 0; i < buckets.length; i++) buckets[i] = 0;
        bucketSec = Math.floor(Date.now() / 1000);
      },
    };
  })();

  /* =========================================================
   * 4. CONTROLLER RENDERER (SVG)
   * ========================================================= */
  const ControllerRenderer = (() => {
    const STANDARD_NAMES = [
      'Cross', 'Circle', 'Square', 'Triangle',
      'L1', 'R1', 'L2', 'R2',
      'Create', 'Options', 'L3', 'R3',
      'D-Pad Up', 'D-Pad Down', 'D-Pad Left', 'D-Pad Right',
      'PS/Home', 'Touchpad',
    ];

    function buildSVG() {
      return `
<svg viewBox="0 0 640 380" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="PlayStation controller">
  <path d="M180 60 Q320 30 460 60 Q540 75 555 130 L585 220 Q600 290 540 320 Q480 345 430 300 L400 260 Q360 235 320 235 Q280 235 240 260 L210 300 Q160 345 100 320 Q40 290 55 220 L85 130 Q100 75 180 60 Z" fill="#1a1f27" stroke="#394655" stroke-width="3"/>
  <g class="ctrl-shoulder" data-idx="4"><rect class="btn-body" x="105" y="38" width="130" height="34" rx="12"/><text class="btn-label" x="170" y="55">L1</text></g>
  <g class="ctrl-shoulder" data-idx="5"><rect class="btn-body" x="405" y="38" width="130" height="34" rx="12"/><text class="btn-label" x="470" y="55">R1</text></g>
  <g class="ctrl-shoulder" data-idx="6"><rect class="btn-body" x="105" y="6" width="130" height="26" rx="10"/><text class="btn-label" x="170" y="20">L2</text></g>
  <g class="ctrl-shoulder" data-idx="7"><rect class="btn-body" x="405" y="6" width="130" height="26" rx="10"/><text class="btn-label" x="470" y="20">R2</text></g>
  <g class="ctrl-btn" data-idx="12"><rect class="btn-body" x="235" y="130" width="34" height="34" rx="6"/><text class="btn-label" x="252" y="147">▲</text></g>
  <g class="ctrl-btn" data-idx="13"><rect class="btn-body" x="235" y="200" width="34" height="34" rx="6"/><text class="btn-label" x="252" y="217">▼</text></g>
  <g class="ctrl-btn" data-idx="14"><rect class="btn-body" x="200" y="165" width="34" height="34" rx="6"/><text class="btn-label" x="217" y="182">◀</text></g>
  <g class="ctrl-btn" data-idx="15"><rect class="btn-body" x="270" y="165" width="34" height="34" rx="6"/><text class="btn-label" x="287" y="182">▶</text></g>
  <g class="ctrl-btn" data-idx="3"><circle class="btn-body" cx="405" cy="130" r="22"/><text class="btn-label" x="405" y="130">△</text></g>
  <g class="ctrl-btn" data-idx="1"><circle class="btn-body" cx="450" cy="175" r="22"/><text class="btn-label" x="450" y="175">○</text></g>
  <g class="ctrl-btn" data-idx="0"><circle class="btn-body" cx="405" cy="220" r="22"/><text class="btn-label" x="405" y="220">✕</text></g>
  <g class="ctrl-btn" data-idx="2"><circle class="btn-body" cx="360" cy="175" r="22"/><text class="btn-label" x="360" y="175">□</text></g>
  <g class="ctrl-btn" data-idx="8"><rect class="btn-body" x="285" y="90" width="30" height="20" rx="5"/><text class="btn-label" x="300" y="102">SH</text></g>
  <g class="ctrl-btn" data-idx="9"><rect class="btn-body" x="325" y="90" width="30" height="20" rx="5"/><text class="btn-label" x="340" y="102">OP</text></g>
  <g class="ctrl-btn" data-idx="16"><rect class="btn-body" x="300" y="145" width="40" height="20" rx="5"/><text class="btn-label" x="320" y="157">PS</text></g>
  <g class="ctrl-btn" data-idx="17"><rect class="btn-body" x="295" y="175" width="50" height="24" rx="6"/><text class="btn-label" x="320" y="190">TP</text></g>
  <g class="ctrl-stick" data-idx="10"><circle class="stick-base" cx="200" cy="275" r="40"/><circle class="stick-knob" cx="200" cy="275" r="26"/><text class="btn-label" x="200" y="332" style="fill:#8b98a8">L3</text></g>
  <g class="ctrl-stick" data-idx="11"><circle class="stick-base" cx="440" cy="275" r="40"/><circle class="stick-knob" cx="440" cy="275" r="26"/><text class="btn-label" x="440" y="332" style="fill:#8b98a8">R3</text></g>
</svg>`;
    }

    let pressedMap = new Map();

    function mount(container) {
      container.innerHTML = buildSVG();
      pressedMap.clear();
      container.querySelectorAll('[data-idx]').forEach((el) => {
        pressedMap.set(Number(el.getAttribute('data-idx')), el);
      });
    }
    function setPressed(idx, on) {
      const el = pressedMap.get(idx);
      if (!el) return;
      el.classList.toggle('pressed', !!on);
    }
    function resetAll() { pressedMap.forEach((el) => el.classList.remove('pressed')); }
    function getStandardName(idx) {
      if (idx >= 0 && idx < STANDARD_NAMES.length) return STANDARD_NAMES[idx];
      return null;
    }
    return { mount, setPressed, resetAll, getStandardName, STANDARD_NAMES };
  })();

  /* =========================================================
   * 5. GAMEPAD MANAGER (USB + BLE)
   * ========================================================= */
  const GamepadManager = (() => {
    let settings = Settings.get();
    let sessionId = generateSessionId();
    let selectedIndex = null;
    let monitoring = false;
    let rafId = null;
    let lastInputAt = null;
    let pollCount = 0;
    let lastAxisSample = 0;
    let rediscoverTimer = null;

    const prevButtons = new Map();
    const prevAxes = { 0: null, 1: null, 2: null, 3: null };
    const buttonPressCounts = new Map();
    const buttonReleaseCounts = new Map();
    const buttonLastChange = new Map();
    const pendingTransitions = new Map();
    const connectedControllers = new Map();

    const subscribers = new Set();
    function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
    function emit(type, data) {
      subscribers.forEach((fn) => { try { fn(type, data); } catch (e) { console.error(e); } });
    }

    function generateSessionId() {
      return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }
    function applySettings(next) { settings = { ...settings, ...next }; }

    function getGamepads() {
      if (!navigator.getGamepads) return [];
      const list = navigator.getGamepads();
      return Array.from(list || []).filter(Boolean);
    }

    function detectTransport(id) {
      if (!id) return 'unknown';
      const s = id.toLowerCase();
      if (s.includes('bluetooth') || s.includes('wireless') || s.includes('bt ')) return 'bluetooth';
      if (s.includes('usb') || s.includes('wired')) return 'usb';
      if (/vendor:\s*054c/.test(s)) return 'usb';
      return 'unknown';
    }

    function refreshControllers() {
      const pads = getGamepads();
      const knownIdx = new Set();
      pads.forEach((p) => {
        knownIdx.add(p.index);
        const transport = detectTransport(p.id);
        const prev = connectedControllers.get(p.index);
        connectedControllers.set(p.index, {
          index: p.index,
          id: p.id,
          mapping: p.mapping || 'non-standard',
          buttons: p.buttons.length,
          axes: p.axes.length,
          transport,
          firstSeenAt: prev ? prev.firstSeenAt : new Date().toISOString(),
        });
      });
      [...connectedControllers.keys()].forEach((i) => { if (!knownIdx.has(i)) connectedControllers.delete(i); });

      if (pads.length === 1) {
        if (selectedIndex !== pads[0].index) selectedIndex = pads[0].index;
      } else if (selectedIndex == null && pads.length > 0) {
        selectedIndex = pads[0].index;
      } else if (selectedIndex != null && !pads.some((p) => p.index === selectedIndex)) {
        selectedIndex = pads.length ? pads[0].index : null;
      }

      emit('controllers-changed', { controllers: [...connectedControllers.values()], selectedIndex });
      return [...connectedControllers.values()];
    }

    function getSelectedPad() {
      if (selectedIndex == null) return null;
      return getGamepads().find((p) => p.index === selectedIndex) || null;
    }

    function selectController(index) {
      selectedIndex = index;
      prevButtons.clear();
      prevAxes[0] = prevAxes[1] = prevAxes[2] = prevAxes[3] = null;
      pendingTransitions.forEach((t) => clearTimeout(t.timer));
      pendingTransitions.clear();
      ControllerRenderer.resetAll();
      emit('selection-changed', { selectedIndex });
    }

    function start() {
      if (monitoring) return;
      monitoring = true;
      if (rediscoverTimer) clearInterval(rediscoverTimer);
      rediscoverTimer = setInterval(() => {
        if (!monitoring) return;
        if (connectedControllers.size === 0) refreshControllers();
      }, 2000);
      emit('started', {});
      loop();
    }

    function stop() {
      monitoring = false;
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = null;
      if (rediscoverTimer) { clearInterval(rediscoverTimer); rediscoverTimer = null; }
      pendingTransitions.forEach((t) => clearTimeout(t.timer));
      pendingTransitions.clear();
      emit('stopped', {});
    }

    function loop() {
      if (!monitoring) return;
      pollCount += 1;
      processPad();
      rafId = requestAnimationFrame(loop);
    }

    function queueTransition(pad, idx, nextPressed, value) {
      const existing = pendingTransitions.get(idx);
      const debounce = settings.debounceMs;

      if (debounce <= 0) {
        const was = prevButtons.get(idx) || false;
        if (nextPressed !== was) commitTransition(pad, idx, was, nextPressed, value);
        return;
      }
      if (existing && existing.pressed === nextPressed) return;
      if (existing) clearTimeout(existing.timer);

      const timer = setTimeout(() => {
        pendingTransitions.delete(idx);
        const was = prevButtons.get(idx) || false;
        if (nextPressed !== was) commitTransition(pad, idx, was, nextPressed, value);
      }, debounce);

      pendingTransitions.set(idx, { pressed: nextPressed, timer });
    }

    function resolvePressed(btn, was) {
      if (!btn) return false;
      const v = typeof btn.value === 'number' ? btn.value : (btn.pressed ? 1 : 0);
      const thr = was ? settings.releaseThreshold : settings.pressThreshold;
      if (btn.pressed && v > 0.01) return true;
      return v >= thr;
    }

    function processPad() {
      const pad = getSelectedPad();
      if (!pad) {
        if (prevButtons.size > 0) {
          prevButtons.forEach((was, idx) => {
            if (was) commitTransition(pad, idx, true, false, 0);
          });
          prevButtons.clear();
        }
        emit('pad-missing', {});
        return;
      }

      pad.buttons.forEach((btn, idx) => {
        const was = prevButtons.get(idx) || false;
        const next = resolvePressed(btn, was);
        if (next !== was) {
          queueTransition(pad, idx, next, typeof btn.value === 'number' ? btn.value : (next ? 1 : 0));
        }
      });
      [...prevButtons.keys()].forEach((i) => { if (i >= pad.buttons.length) prevButtons.delete(i); });

      const nowMs = Date.now();
      if (nowMs - lastAxisSample >= settings.axisInterval) {
        lastAxisSample = nowMs;
        for (let i = 0; i < Math.min(pad.axes.length, 4); i++) {
          const raw = pad.axes[i];
          const prev = prevAxes[i];
          const meaningful = Math.abs(raw - (prev == null ? 0 : prev)) >= settings.axisThreshold;
          const outsideDead = Math.abs(raw) >= settings.deadZone;
          if (prev == null || (meaningful && outsideDead)) {
            prevAxes[i] = raw;
            emit('axis-sample', { idx: i, raw, pad });
            if (prev != null && meaningful) logAxisChange(pad, i, prev, raw);
          }
        }
      }

      emit('pad-polled', { pad, pollCount });
    }

    function controlNameForButton(pad, idx) {
      if (pad.mapping === 'standard') {
        const name = ControllerRenderer.getStandardName(idx);
        if (name) return name;
      }
      return `Button ${idx}`;
    }
    function isAnalogButton(pad, idx) {
      if (pad.mapping === 'standard' && (idx === 6 || idx === 7)) return true;
      const b = pad.buttons[idx];
      return !!b && typeof b.value === 'number' && b.value > 0 && b.value < 1;
    }

    function commitTransition(pad, idx, was, now, value) {
      prevButtons.set(idx, now);
      if (!pad) return;
      const name = controlNameForButton(pad, idx);
      const eventType = now ? 'buttondown' : 'buttonup';
      const nowIso = new Date().toISOString();
      const transport = (connectedControllers.get(pad.index) || {}).transport || 'unknown';

      if (now) buttonPressCounts.set(idx, (buttonPressCounts.get(idx) || 0) + 1);
      else buttonReleaseCounts.set(idx, (buttonReleaseCounts.get(idx) || 0) + 1);
      buttonLastChange.set(idx, nowIso);
      lastInputAt = nowIso;

      ControllerRenderer.setPressed(idx, now);

      const evt = {
        eventId: 'evt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        sessionId,
        controllerId: pad.id,
        controllerIndex: pad.index,
        transport,
        eventType,
        controlName: name,
        controlIndex: idx,
        prevValue: was ? 1 : 0,
        newValue: now ? 1 : 0,
        state: now ? 'PRESSED' : 'RELEASED',
        analog: isAnalogButton(pad, idx),
        value,
        clientTimestamp: nowIso,
      };
      EventLogger.add(evt);
      DashboardStats.record(evt.eventType, evt.controlName);
      emit('button-transition', { evt, pad, idx, pressed: now, value });
    }

    function logAxisChange(pad, idx, prevRaw, newRaw) {
      const axisNames = ['Left X', 'Left Y', 'Right X', 'Right Y'];
      const nowIso = new Date().toISOString();
      lastInputAt = nowIso;
      const transport = (connectedControllers.get(pad.index) || {}).transport || 'unknown';
      const evt = {
        eventId: 'evt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        sessionId,
        controllerId: pad.id,
        controllerIndex: pad.index,
        transport,
        eventType: 'axischange',
        controlName: axisNames[idx] || `Axis ${idx}`,
        controlIndex: idx,
        prevValue: round2(prevRaw),
        newValue: round2(newRaw),
        state: '',
        analog: true,
        clientTimestamp: nowIso,
      };
      EventLogger.add(evt);
      DashboardStats.record(evt.eventType, evt.controlName);
      emit('axis-change', { evt, pad, idx, prevRaw, newRaw });
    }

    function resetSession() {
      sessionId = generateSessionId();
      prevButtons.clear();
      prevAxes[0] = prevAxes[1] = prevAxes[2] = prevAxes[3] = null;
      buttonPressCounts.clear();
      buttonReleaseCounts.clear();
      buttonLastChange.clear();
      pendingTransitions.forEach((t) => clearTimeout(t.timer));
      pendingTransitions.clear();
      lastInputAt = null;
      pollCount = 0;
      ControllerRenderer.resetAll();
    }

    function emitConnectionEvent(pad, type) {
      const nowIso = new Date().toISOString();
      const transport = pad ? detectTransport(pad.id) : 'unknown';
      const evt = {
        eventId: 'evt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        sessionId,
        controllerId: pad ? pad.id : 'unknown',
        controllerIndex: pad ? pad.index : -1,
        transport,
        eventType: type,
        controlName: 'Controller',
        controlIndex: -1,
        prevValue: '',
        newValue: '',
        state: type === 'connected' ? 'CONNECTED' : 'DISCONNECTED',
        analog: false,
        clientTimestamp: nowIso,
      };
      EventLogger.add(evt);
      DashboardStats.record(type, null);
      emit('connection-event', { evt });
    }

    function round2(n) { return Math.round(n * 100) / 100; }

    window.addEventListener('gamepadconnected', (e) => {
      refreshControllers();
      emitConnectionEvent(e.gamepad, 'connected');
      emit('gamepad-connected', { gamepad: e.gamepad });
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      emitConnectionEvent(e.gamepad, 'disconnected');
      if (prevButtons.size > 0) {
        prevButtons.forEach((was, idx) => {
          if (was) commitTransition(e.gamepad, idx, true, false, 0);
        });
        prevButtons.clear();
      }
      refreshControllers();
      emit('gamepad-disconnected', { gamepad: e.gamepad });
    });

    return {
      subscribe, start, stop, refreshControllers, selectController,
      getSelectedPad, get selectedIndex() { return selectedIndex; },
      get monitoring() { return monitoring; },
      get sessionId() { return sessionId; },
      get pollCount() { return pollCount; },
      get lastInputAt() { return lastInputAt; },
      get connectedControllers() { return [...connectedControllers.values()]; },
      get buttonPressCounts() { return buttonPressCounts; },
      get buttonReleaseCounts() { return buttonReleaseCounts; },
      get buttonLastChange() { return buttonLastChange; },
      get prevButtons() { return prevButtons; },
      resetSession, applySettings, detectTransport,
      generateSessionId,
    };
  })();

  /* =========================================================
   * 6. APP — navigation, wiring, UI
   * ========================================================= */
  const App = (() => {
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const views = ['overview', 'live', 'logs', 'settings'];
    const titles = { overview: 'Overview', live: 'Live Controller', logs: 'Event Logs', settings: 'Settings' };
    let activeView = 'overview';

    function switchView(name) {
      if (!views.includes(name)) return;
      activeView = name;
      $$('.nav-link').forEach((b) => {
        const isActive = b.dataset.view === name;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', String(isActive));
      });
      views.forEach((v) => {
        const el = $('#view-' + v);
        if (el) el.classList.toggle('active', v === name);
      });
      $('#topbarTitle').textContent = titles[name] || name;
    }

    function updateClock() {
      const el = $('#clock');
      if (!el) return;
      el.textContent = new Date().toLocaleTimeString();
    }

    function updateGamepadSupportedChip() {
      const chip = $('#gamepadSupportedChip');
      if (!navigator.getGamepads) {
        chip.textContent = 'Gamepad API: unsupported';
        chip.className = 'topbar-chip bad';
      } else {
        chip.textContent = 'Gamepad API: available';
        chip.className = 'topbar-chip ok';
      }
    }

    function transportLabel(t) {
      if (t === 'usb') return 'USB';
      if (t === 'bluetooth') return 'Bluetooth / BLE';
      return 'Unknown';
    }

    function updateControllerChip() {
      const chip = $('#controllerChip');
      const dot = $('#sidebarControllerDot');
      const text = $('#sidebarControllerText');
      const pad = GamepadManager.getSelectedPad();
      if (pad) {
        const info = GamepadManager.connectedControllers.find((c) => c.index === pad.index);
        const t = info ? info.transport : 'unknown';
        chip.textContent = `Controller: ${pad.id.split('(')[0].trim().slice(0, 40) || 'connected'}`;
        chip.className = 'topbar-chip ok';
        dot.className = 'status-dot green';
        text.textContent = pad.mapping === 'standard'
          ? `Connected (${transportLabel(t)}, standard)`
          : `Connected (${transportLabel(t)}, non-standard)`;
      } else {
        chip.textContent = 'Controller: none';
        chip.className = 'topbar-chip warn';
        dot.className = 'status-dot amber';
        text.textContent = 'No controller — press a button on the pad to wake it';
      }
    }

    function updateTransportChip() {
      const chip = $('#transportChip');
      const pad = GamepadManager.getSelectedPad();
      if (!pad) {
        chip.textContent = 'Transport: —';
        chip.className = 'topbar-chip';
        return;
      }
      const info = GamepadManager.connectedControllers.find((c) => c.index === pad.index);
      const t = info ? info.transport : 'unknown';
      chip.textContent = `Transport: ${transportLabel(t)}`;
      chip.className = 'topbar-chip ' + (t === 'bluetooth' ? 'warn' : t === 'usb' ? 'ok' : '');
    }

    function renderControllerSelect(list) {
      const sel = $('#controllerSelect');
      sel.innerHTML = '';
      if (!list.length) {
        const opt = document.createElement('option');
        opt.textContent = 'No controller detected';
        opt.disabled = true; opt.selected = true;
        sel.appendChild(opt);
        return;
      }
      list.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.index;
        opt.textContent = `[${c.index}] ${transportLabel(c.transport)} · ${c.id.slice(0, 40)}`;
        if (c.index === GamepadManager.selectedIndex) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    function renderControllerInfo() {
      const pad = GamepadManager.getSelectedPad();
      if (!pad) {
        $('#infoName').textContent = '—'; $('#infoId').textContent = '—';
        $('#infoIndex').textContent = '—'; $('#infoTransport').textContent = '—';
        $('#infoMapping').textContent = '—'; $('#infoButtons').textContent = '—';
        $('#infoAxes').textContent = '—'; $('#infoStatus').textContent = 'Disconnected';
        $('#infoLastInput').textContent = '—';
        return;
      }
      const info = GamepadManager.connectedControllers.find((c) => c.index === pad.index);
      $('#infoName').textContent = pad.id;
      $('#infoId').textContent = pad.id;
      $('#infoIndex').textContent = String(pad.index);
      $('#infoTransport').textContent = transportLabel(info ? info.transport : 'unknown');
      $('#infoMapping').textContent = pad.mapping || 'non-standard';
      $('#infoButtons').textContent = String(pad.buttons.length);
      $('#infoAxes').textContent = String(pad.axes.length);
      $('#infoStatus').textContent = GamepadManager.monitoring ? 'Monitoring' : 'Connected (stopped)';
      $('#infoLastInput').textContent = GamepadManager.lastInputAt || '—';
    }

    function renderButtonTable() {
      const tbody = $('#buttonTable tbody');
      tbody.innerHTML = '';
      const pad = GamepadManager.getSelectedPad();
      if (!pad) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="7" style="color:var(--text-dim)">No controller selected.</td>';
        tbody.appendChild(tr);
        return;
      }
      const activeFilter = ($('.chip.active[data-filter]') || {}).dataset
        ? $('.chip.active[data-filter]').dataset.filter : 'all';
      const now = Date.now();
      const prevButtons = GamepadManager.prevButtons;
      const pressCounts = GamepadManager.buttonPressCounts;
      const releaseCounts = GamepadManager.buttonReleaseCounts;
      const lastChange = GamepadManager.buttonLastChange;

      pad.buttons.forEach((btn, idx) => {
        const isPressed = !!prevButtons.get(idx);
        const analog = pad.mapping === 'standard' ? (idx === 6 || idx === 7) : false;
        const name = pad.mapping === 'standard'
          ? (ControllerRenderer.getStandardName(idx) || `Button ${idx}`)
          : `Button ${idx}`;
        const category = (function () {
          if (idx >= 12 && idx <= 15) return 'dpad';
          if (idx >= 0 && idx <= 3) return 'face';
          if (idx >= 4 && idx <= 7) return 'shoulder';
          if (analog) return 'analog';
          return 'other';
        })();
        const changedAt = lastChange.get(idx);
        const recentlyChanged = changedAt && now - new Date(changedAt).getTime() < 3000;

        if (activeFilter === 'pressed' && !isPressed) return;
        if (activeFilter === 'recent' && !recentlyChanged) return;
        if (activeFilter === 'dpad' && category !== 'dpad') return;
        if (activeFilter === 'face' && category !== 'face') return;
        if (activeFilter === 'shoulder' && category !== 'shoulder') return;
        if (activeFilter === 'analog' && category !== 'analog') return;

        const tr = document.createElement('tr');
        const value = typeof btn.value === 'number' ? btn.value.toFixed(2) : (btn.pressed ? '1.00' : '0.00');
        tr.innerHTML = `
          <td>${escapeHtml(name)}</td>
          <td>${idx}</td>
          <td class="${isPressed ? 'state-pressed' : 'state-released'}">${isPressed ? 'PRESSED' : 'RELEASED'}</td>
          <td>${value}</td>
          <td>${changedAt ? escapeHtml(new Date(changedAt).toLocaleTimeString()) : '—'}</td>
          <td>${pressCounts.get(idx) || 0}</td>
          <td>${releaseCounts.get(idx) || 0}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
    }

    function renderLogTable() {
      const list = EventLogger.filtered();
      const tbody = $('#logTable tbody');
      tbody.innerHTML = '';
      const sorted = list.slice().sort((a, b) => {
        const ta = new Date(a.clientTimestamp).getTime();
        const tb = new Date(b.clientTimestamp).getTime();
        return EventLogger.snapshot().sortDesc ? tb - ta : ta - tb;
      });
      const max = Settings.get().maxLogs;
      sorted.slice(0, max).forEach((e) => {
        const tr = document.createElement('tr');
        const stateClass = e.state === 'PRESSED' ? 'state-pressed' : 'state-released';
        tr.innerHTML = `
          <td>${escapeHtml(EventLogger.formatTime(e.clientTimestamp))}</td>
          <td>${escapeHtml(e.eventType)}</td>
          <td>${escapeHtml(e.controlName || '')}</td>
          <td>${e.controlIndex != null ? e.controlIndex : ''}</td>
          <td>${escapeHtml(String(e.prevValue ?? ''))}</td>
          <td>${escapeHtml(String(e.newValue ?? ''))}</td>
          <td class="${stateClass}">${escapeHtml(e.state || '')}</td>
          <td><button class="btn btn-tiny copy-json">Copy</button></td>
        `;
        tr.querySelector('.copy-json').addEventListener('click', () => {
          navigator.clipboard.writeText(JSON.stringify(e, null, 2)).catch(() => {});
        });
        tbody.appendChild(tr);
      });
      $('#logMeta').textContent = `${list.length} events (showing up to ${max}) · ` +
        `presses: ${EventLogger.snapshot().presses} · releases: ${EventLogger.snapshot().releases}`;
    }

    function renderStats() {
      const pad = GamepadManager.getSelectedPad();
      const snap = EventLogger.snapshot();
      $('#statController').textContent = pad ? 'Connected' : 'Disconnected';
      const info = pad ? GamepadManager.connectedControllers.find((c) => c.index === pad.index) : null;
      $('#statControllerSub').textContent = pad
        ? `${transportLabel(info ? info.transport : 'unknown')} · ${pad.mapping === 'standard' ? 'Standard mapping' : 'Non-standard mapping'}`
        : 'Press a button on your controller';
      $('#statPresses').textContent = String(DashboardStats.getPresses());
      $('#statReleases').textContent = String(DashboardStats.getReleases());
      $('#statEvents').textContent = String(snap.total);
      $('#statSession').textContent = DashboardStats.sessionDuration();
    }

    function renderRanking() {
      const rows = DashboardStats.ranking();
      const box = $('#buttonRanking');
      box.innerHTML = '';
      if (!rows.length) { box.innerHTML = '<div class="hint">No button activity yet.</div>'; return; }
      const max = rows[0].total || 1;
      rows.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'ranking-row';
        row.innerHTML = `
          <span>${escapeHtml(r.name)}</span>
          <div class="ranking-bar"><div class="ranking-fill" style="width:${Math.round((r.total / max) * 100)}%"></div></div>
          <span class="ranking-count">${r.total}</span>
        `;
        box.appendChild(row);
      });
    }

    function renderActivityChart() {
      const canvas = $('#activityChart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = (h - 20) * (i / 4) + 10;
        ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(w - 10, y); ctx.stroke();
      }
      const buckets = DashboardStats.buckets;
      const max = Math.max(1, ...buckets);
      const bw = (w - 20) / buckets.length;
      buckets.forEach((v, i) => {
        const bh = (h - 20) * (v / max);
        const x = 10 + i * bw;
        const y = h - 10 - bh;
        ctx.fillStyle = v > 0 ? 'rgba(59,130,246,0.85)' : 'rgba(59,130,246,0.15)';
        ctx.fillRect(x, y, Math.max(1, bw - 1), bh);
      });
      ctx.fillStyle = 'rgba(139,152,168,0.8)';
      ctx.font = '10px monospace';
      ctx.fillText('60s ago', 10, 12);
      ctx.fillText('now', w - 34, 12);
    }

    function renderSticks() {
      const pad = GamepadManager.getSelectedPad();
      drawStick('leftStick', pad ? pad.axes[0] : 0, pad ? pad.axes[1] : 0, 'leftStickValues');
      drawStick('rightStick', pad ? pad.axes[2] : 0, pad ? pad.axes[3] : 0, 'rightStickValues');
    }
    function drawStick(canvasId, x, y, labelId) {
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      const cx = w / 2, cy = h / 2;
      const r = w / 2 - 8;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      const dz = Settings.get().deadZone;
      ctx.strokeStyle = 'rgba(245,158,11,0.35)';
      ctx.beginPath(); ctx.arc(cx, cy, r * dz, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
      const px = cx + (x || 0) * r;
      const py = cy + (y || 0) * r;
      const dist = Math.sqrt((x || 0) ** 2 + (y || 0) ** 2);
      const active = dist >= dz;
      ctx.fillStyle = active ? 'rgba(34,197,94,0.9)' : 'rgba(139,152,168,0.9)';
      ctx.beginPath(); ctx.arc(px, py, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = active ? '#86efac' : '#4b5a6b';
      ctx.lineWidth = 2; ctx.stroke();
      const label = document.getElementById(labelId);
      if (label) {
        label.textContent = `X ${(x || 0).toFixed(2)} · Y ${(y || 0).toFixed(2)}` +
          (active ? ' · active' : ' · neutral');
      }
    }

    function renderTriggers() {
      const pad = GamepadManager.getSelectedPad();
      const l2 = pad && pad.buttons[6] ? (pad.buttons[6].value || 0) : 0;
      const r2 = pad && pad.buttons[7] ? (pad.buttons[7].value || 0) : 0;
      $('#l2Value').textContent = Math.round(l2 * 100) + '%';
      $('#r2Value').textContent = Math.round(r2 * 100) + '%';
      $('#l2Fill').style.width = Math.round(l2 * 100) + '%';
      $('#r2Fill').style.width = Math.round(r2 * 100) + '%';
    }

    function renderSettingsForm() {
      const s = Settings.get();
      const form = $('#settingsForm');
      form.deadZone.value = s.deadZone;
      form.axisThreshold.value = s.axisThreshold;
      form.axisInterval.value = s.axisInterval;
      form.pressThreshold.value = s.pressThreshold;
      form.releaseThreshold.value = s.releaseThreshold;
      form.debounceMs.value = s.debounceMs;
      form.maxLogs.value = s.maxLogs;
      form.utcTimestamps.checked = s.utcTimestamps;
    }

    function fillLogControllerFilter() {
      const sel = $('#logControllerFilter');
      const current = sel.value;
      sel.innerHTML = '<option value="">All controllers</option>';
      GamepadManager.connectedControllers.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.index;
        opt.textContent = `[${c.index}] ${transportLabel(c.transport)} · ${c.id.slice(0, 30)}`;
        sel.appendChild(opt);
      });
      if ([...sel.options].some((o) => o.value === current)) sel.value = current;
    }

    function tick() {
      updateClock();
      renderStats();
      renderActivityChart();
      if (activeView === 'live') {
        renderButtonTable(); renderSticks(); renderTriggers(); renderControllerInfo();
      }
      if (activeView === 'logs') {
        if (!EventLogger.snapshot().paused) renderLogTable();
      }
    }

    function wireEvents() {
      $$('.nav-link').forEach((btn) => {
        btn.addEventListener('click', () => switchView(btn.dataset.view));
      });

      $('#controllerSelect').addEventListener('change', (e) => {
        const idx = Number(e.target.value);
        GamepadManager.selectController(idx);
        renderControllerSelect(GamepadManager.connectedControllers);
        updateControllerChip();
        updateTransportChip();
      });
      $('#refreshControllersBtn').addEventListener('click', () => {
        GamepadManager.refreshControllers();
        renderControllerSelect(GamepadManager.connectedControllers);
        updateControllerChip();
        updateTransportChip();
      });

      $('#startBtn').addEventListener('click', () => {
        GamepadManager.refreshControllers();
        renderControllerSelect(GamepadManager.connectedControllers);
        GamepadManager.start();
        $('#startBtn').disabled = true;
        $('#stopBtn').disabled = false;
      });
      $('#stopBtn').addEventListener('click', () => {
        GamepadManager.stop();
        $('#startBtn').disabled = false;
        $('#stopBtn').disabled = true;
        renderButtonTable();
      });
      $('#clearSessionBtn').addEventListener('click', () => {
        if (!confirm('Clear the current session? Local logs will be removed.')) return;
        GamepadManager.resetSession();
        EventLogger.clear();
        DashboardStats.reset();
        renderLogTable(); renderStats(); renderButtonTable(); renderRanking();
      });

      $$('.chip[data-filter]').forEach((chip) => {
        chip.addEventListener('click', () => {
          $$('.chip[data-filter]').forEach((c) => c.classList.remove('active'));
          chip.classList.add('active');
          renderButtonTable();
        });
      });

      $('#logSearch').addEventListener('input', (e) => EventLogger.setSearch(e.target.value));
      $('#logTypeFilter').addEventListener('change', (e) => EventLogger.setTypeFilter(e.target.value));
      $('#logControllerFilter').addEventListener('change', (e) => EventLogger.setControllerFilter(e.target.value));
      $('#logTimeFilter').addEventListener('change', (e) => EventLogger.setTimeFilter(Number(e.target.value)));
      $('#logSortBtn').addEventListener('click', () => {
        const s = EventLogger.snapshot();
        EventLogger.setSort(!s.sortDesc);
        $('#logSortBtn').textContent = EventLogger.snapshot().sortDesc ? 'Newest first' : 'Oldest first';
        renderLogTable();
      });
      $('#logPauseBtn').addEventListener('click', () => {
        const s = EventLogger.snapshot();
        EventLogger.setPaused(!s.paused);
        $('#logPauseBtn').textContent = EventLogger.snapshot().paused ? 'Resume' : 'Pause';
      });
      $('#logClearBtn').addEventListener('click', () => {
        if (!confirm('Clear all local logs?')) return;
        EventLogger.clear();
        renderLogTable();
      });
      $('#exportCsvBtn').addEventListener('click', () => {
        downloadBlob(EventLogger.toCSV(EventLogger.filtered()), 'controller-events.csv', 'text/csv');
      });
      $('#exportJsonBtn').addEventListener('click', () => {
        downloadBlob(EventLogger.toJSON(EventLogger.filtered()), 'controller-events.json', 'application/json');
      });

      $('#settingsForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const f = e.target;
        Settings.set({
          deadZone: Number(f.deadZone.value),
          axisThreshold: Number(f.axisThreshold.value),
          axisInterval: Number(f.axisInterval.value),
          pressThreshold: Number(f.pressThreshold.value),
          releaseThreshold: Number(f.releaseThreshold.value),
          debounceMs: Number(f.debounceMs.value),
          maxLogs: Number(f.maxLogs.value),
          utcTimestamps: f.utcTimestamps.checked,
        });
        $('#settingsFeedback').textContent = 'Settings saved.';
        setTimeout(() => { $('#settingsFeedback').textContent = ''; }, 2000);
      });
      $('#settingsResetBtn').addEventListener('click', () => {
        Settings.reset();
        renderSettingsForm();
        $('#settingsFeedback').textContent = 'Settings reset to defaults.';
        setTimeout(() => { $('#settingsFeedback').textContent = ''; }, 2000);
      });

      Settings.subscribe((s) => {
        GamepadManager.applySettings(s);
        EventLogger.applySettings(s);
        renderSettingsForm();
      });
    }

    function downloadBlob(content, filename, mime) {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    }

    function wireGamepadSubscribers() {
      GamepadManager.subscribe((type, data) => {
        switch (type) {
          case 'controllers-changed':
          case 'selection-changed':
            renderControllerSelect(data.controllers || GamepadManager.connectedControllers);
            fillLogControllerFilter();
            updateControllerChip();
            updateTransportChip();
            renderControllerInfo();
            break;
          case 'pad-polled':
            updateControllerChip();
            break;
          case 'button-transition':
          case 'axis-change':
          case 'connection-event':
            if (activeView === 'logs' && !EventLogger.snapshot().paused) renderLogTable();
            if (activeView === 'live') { renderButtonTable(); renderTriggers(); renderSticks(); }
            if (activeView === 'overview') renderRanking();
            break;
          case 'started':
            $('#startBtn').disabled = true;
            $('#stopBtn').disabled = false;
            break;
          case 'stopped':
            $('#startBtn').disabled = false;
            $('#stopBtn').disabled = true;
            break;
          default:
            break;
        }
      });
      EventLogger.subscribe(() => {
        if (activeView === 'logs' && !EventLogger.snapshot().paused) renderLogTable();
        if (activeView === 'overview') renderStats();
      });
    }

    function init() {
      ControllerRenderer.mount($('#controllerRender'));
      updateGamepadSupportedChip();
      wireEvents();
      wireGamepadSubscribers();
      fillLogControllerFilter();
      updateControllerChip();
      updateTransportChip();
      renderSettingsForm();
      renderControllerSelect(GamepadManager.connectedControllers);

      GamepadManager.refreshControllers();
      renderControllerSelect(GamepadManager.connectedControllers);
      updateControllerChip();
      updateTransportChip();

      updateClock();
      setInterval(tick, 1000);
      setInterval(() => {
        if (activeView === 'overview') { renderActivityChart(); renderStats(); }
      }, 500);
      setInterval(() => {
        if (activeView === 'live' && GamepadManager.monitoring) {
          renderSticks(); renderTriggers(); renderButtonTable();
        }
      }, 100);

      switchView('overview');
    }

    return { init };
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init());
  } else {
    App.init();
  }
})();