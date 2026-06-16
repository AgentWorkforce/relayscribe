/*
 * Relay Generative-UI bridge — window.relayscribe.*
 * ----------------------------------------------------------------------------
 * This file is the ACTION BOUNDARY for the malleable (Generative UI Beta) app.
 *
 * The generated UI is free-form HTML/CSS/JS authored by an LLM from a plain-
 * English description. Presentation is unconstrained. The only things the UI
 * can *do* — the real app functions and data — are reached through this bridge.
 *
 * Most methods are thin wrappers over the local sidecar REST API (same-origin,
 * since the WebView loads the UI from the sidecar). A few "native" actions
 * (e.g. openSettings) hop to the Swift shell via a WKScriptMessageHandler when
 * one is installed.
 *
 * The bridge is injected into the <head> of every served UI document, so
 * `window.relayscribe` is always defined before the generated app's own scripts
 * run. Rich JS (DOM, fetch, EventSource, timers, …) is fully allowed; the
 * WebView itself is the only inherent sandbox.
 */
(function () {
  'use strict';

  if (window.relayscribe && window.relayscribe.__installed) return;

  var BASE = window.location.origin; // sidecar origin, e.g. http://127.0.0.1:3700

  function url(pathname, query) {
    var u = BASE + pathname;
    if (query) {
      var parts = [];
      for (var k in query) {
        if (query[k] === undefined || query[k] === null) continue;
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(query[k])));
      }
      if (parts.length) u += '?' + parts.join('&');
    }
    return u;
  }

  async function req(method, pathname, opts) {
    opts = opts || {};
    var init = { method: method, headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    var res = await fetch(url(pathname, opts.query), init);
    var text = await res.text();
    var data;
    try { data = text ? JSON.parse(text) : null; } catch (_e) { data = text; }
    if (!res.ok) {
      var err = new Error('relayscribe bridge ' + method + ' ' + pathname + ' → ' + res.status);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function nativeSend(message) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.relayscribe) {
        window.webkit.messageHandlers.relayscribe.postMessage(message);
        return true;
      }
    } catch (_e) {}
    return false;
  }

  var bridge = {
    __installed: true,
    version: 1,

    // ── Recording control ────────────────────────────────────────────────
    // Manually start a capture. In normal operation a meeting is auto-detected;
    // record() is the explicit "start now" used by custom UIs / demos.
    record: function (opts) {
      return req('POST', '/recording/test-start', { body: opts || {} });
    },
    startRecording: function (opts) { return this.record(opts); },
    stop: function () { return req('POST', '/recording/stop'); },
    stopRecording: function () { return this.stop(); },
    pause: function () { return req('POST', '/recording/pause'); },
    resume: function () { return req('POST', '/recording/resume'); },

    // ── Status / live state ──────────────────────────────────────────────
    status: function () { return req('GET', '/status'); },
    state: function () { return req('GET', '/state'); },
    // Subscribe to live recorder-state updates over SSE. cb receives the
    // parsed state object on every change. Returns an unsubscribe function.
    onState: function (cb) {
      var es = new EventSource(url('/state/stream'));
      es.onmessage = function (ev) {
        if (!ev.data) return;
        try { cb(JSON.parse(ev.data)); } catch (_e) {}
      };
      return function () { es.close(); };
    },

    // ── Recordings & transcripts ─────────────────────────────────────────
    listRecordings: function () { return req('GET', '/recordings'); },
    getTranscript: function (sessionId) {
      return req('GET', '/recordings/transcript', { query: { sessionId: sessionId } });
    },
    // Convenience: open a recording == fetch its transcript rows.
    openRecording: function (sessionId) { return this.getTranscript(sessionId); },
    search: function (query) {
      return req('GET', '/recordings/search', { query: { query: query } });
    },

    // ── Settings / config / integrations ─────────────────────────────────
    getSettings: function () { return req('GET', '/settings'); },
    updateSettings: function (patch) { return req('POST', '/settings', { body: patch || {} }); },
    getConfig: function () { return req('GET', '/config'); },
    // Connect a provider via the relay hosted OAuth flow. provider ∈
    // {slack, linear, github}. May take a while (opens browser auth).
    connect: function (provider) {
      return req('POST', '/integrations/' + encodeURIComponent(provider) + '/connect');
    },

    // ── Native shell actions ─────────────────────────────────────────────
    // Open the native macOS Settings window. Requires the Swift message
    // handler; resolves false in a plain browser.
    openSettings: function () {
      return Promise.resolve(nativeSend({ action: 'openSettings' }));
    },
    // Populate the persistent native describe/generate toolbar with text (e.g.
    // from an example chip). The native toolbar is the single authoring input;
    // generated/starter pages route prompts to it rather than rendering their
    // own. Resolves false in a plain browser.
    compose: function (text) {
      return Promise.resolve(nativeSend({ action: 'compose', text: String(text == null ? '' : text) }));
    },

    // ── Self-authoring (regenerate / reset this very UI) ──────────────────
    // Regenerate the whole interface from a new English description. The
    // current document is passed to the model as the base to iterate on.
    // NOTE: generated UIs should NOT render their own describe/generate input —
    // the app's persistent native toolbar is the single authoring surface. For
    // in-page prompt shortcuts, prefer compose() (populates that toolbar).
    regenerate: async function (request, opts) {
      opts = opts || {};
      var out = await req('POST', '/ui/generate', { body: { request: request, reset: !!opts.reset } });
      if (opts.reload !== false) window.location.reload();
      return out;
    },
    // Reset back to the starter/blank UI.
    reset: async function (opts) {
      opts = opts || {};
      var out = await req('DELETE', '/ui');
      if (opts.reload !== false) window.location.reload();
      return out;
    },

    // Introspection: the full callable surface (handy for generated UIs).
    describe: function () {
      return {
        version: 1,
        methods: [
          'record(opts?)', 'startRecording(opts?)', 'stop()', 'stopRecording()',
          'pause()', 'resume()', 'status()', 'state()', 'onState(cb)->unsub',
          'listRecordings()', 'getTranscript(sessionId)', 'openRecording(sessionId)',
          'search(query)', 'getSettings()', 'updateSettings(patch)', 'getConfig()',
          'connect(provider)', 'openSettings()', 'compose(text)',
          'regenerate(request,opts?)', 'reset(opts?)', 'describe()'
        ]
      };
    }
  };

  Object.defineProperty(window, 'relayscribe', { value: bridge, writable: false, configurable: false });
})();
