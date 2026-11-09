// SevynOS M6 — environment glue for Tokrah under the SevynOS host.
//
// Tokrah is a real React Native + Expo app: it expects the RN runtime
// globals (fetch, XMLHttpRequest, console, timers, performance,
// TextEncoder, URL, crypto.getRandomValues). The v2 host provides
// Sevyn.* + setTimeout/setImmediate only, so this module installs the
// rest before Tokrah loads.
//
// Transport: XHR/fetch go through the `sevyn net fetch` CLI verb
// (busybox wget under the hood) via Sevyn.exec when running on the
// real host — the ONLY network path an app has (cli.exec permission).
// Under Node (the mock harness) the harness installs
// globalThis.__sevynHttpRequest (Node http/https) before the bundle
// loads; this file never references Node builtins, so Metro can bundle
// it for Hermes. WebSocket is deliberately ABSENT: engine.io-client
// then falls back to XHR polling, which works over the exec bridge; a
// real WebSocket needs a host adapter (a later milestone, not M6).
(function () {
  const isNode =
    typeof process !== "undefined" && process.versions && process.versions.node;
  const hasSevyn =
    typeof Sevyn !== "undefined" && Sevyn && typeof Sevyn.exec === "function";

  // The Expo native runtime installs `globalThis.expo` (modules
  // registry + the native EventEmitter base class). expo-modules-core
  // reads it at load (`globalThis.expo.EventEmitter`). On the SevynOS
  // host there is no native runtime, so install a minimal stand-in:
  // no modules, and a no-op EventEmitter base class for the modules
  // that subclass it.
  if (!globalThis.expo) {
    class SevynExpoEventEmitter {
      constructor() {}
      addListener() {
        return { remove() {} };
      }
      removeListener() {}
      removeAllListeners() {}
      emit() {}
      listeners() {
        return [];
      }
    }
    globalThis.expo = { modules: {}, EventEmitter: SevynExpoEventEmitter };
  }

  // console: the host's console (if any) writes to the serial; fall
  // back to Sevyn.log so Tokrah's logging never throws.
  if (typeof console === "undefined" || !console.log) {
    globalThis.console = {
      log: (...a) => hasSevyn && Sevyn.log("[tokrah] " + a.map(String).join(" ")),
      info: (...a) => hasSevyn && Sevyn.log("[tokrah] " + a.map(String).join(" ")),
      warn: (...a) => hasSevyn && Sevyn.log("[tokrah:warn] " + a.map(String).join(" ")),
      error: (...a) => hasSevyn && Sevyn.log("[tokrah:error] " + a.map(String).join(" ")),
      debug: () => {},
    };
  }

  // Timers: the host installs setTimeout/setImmediate only. Tokrah
  // (and React) use setInterval + queueMicrotask + requestAnimationFrame.
  if (typeof setInterval === "undefined") {
    globalThis.setInterval = (fn, ms, ...args) => {
      let alive = true;
      const id = { __sevynInterval: true };
      const tick = () => {
        if (!alive) return;
        fn(...args);
        if (alive) id._t = setTimeout(tick, ms);
      };
      id._t = setTimeout(tick, ms);
      id.__cancel = () => {
        alive = false;
        clearTimeout(id._t);
      };
      return id;
    };
    globalThis.clearInterval = (id) => {
      if (id && id.__cancel) id.__cancel();
      else if (typeof clearTimeout === "function") clearTimeout(id);
    };
  }
  if (typeof queueMicrotask === "undefined") {
    globalThis.queueMicrotask = (fn) => Promise.resolve().then(fn);
  }
  if (typeof requestAnimationFrame === "undefined") {
    globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  }
  if (typeof performance === "undefined" || !performance.now) {
    globalThis.performance = { now: () => Date.now() };
  }
  if (typeof TextEncoder === "undefined") {
    globalThis.TextEncoder = function TextEncoder() {};
    TextEncoder.prototype.encode = (s) => {
      const str = String(s);
      const bytes = [];
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 0x80) bytes.push(c);
        else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
      return new Uint8Array(bytes);
    };
  }
  if (typeof TextDecoder === "undefined") {
    globalThis.TextDecoder = function TextDecoder() {};
    TextDecoder.prototype.decode = (buf) => {
      const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      let s = "";
      for (let i = 0; i < b.length; i++) {
        const c = b[i];
        if (c < 0x80) s += String.fromCharCode(c);
        else if ((c & 0xe0) === 0xc0)
          s += String.fromCharCode(((c & 0x1f) << 6) | (b[++i] & 0x3f));
        else
          s += String.fromCharCode(
            ((c & 0x0f) << 12) | ((b[++i] & 0x3f) << 6) | (b[++i] & 0x3f),
          );
      }
      return s;
    };
  }
  if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    globalThis.crypto = {
      getRandomValues: (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
    };
  }

  // URL + URLSearchParams: Hermes has neither; expo-router calls
  // `new URLSearchParams()` at module load (route state) and `new
  // URL(url)` while routing. Node has both natively, so the guards
  // keep the harness on the real ones. This is a small subset — the
  // WHATWG surface the bundle touches (parse + origin/hostname/path/
  // searchParams + the params get/set/append/entries) — not a full
  // implementation.
  if (typeof URLSearchParams === "undefined") {
    class SevynURLSearchParams {
      constructor(init) {
        this._pairs = [];
        if (init == null) return;
        if (typeof init === "string") {
          const q = init.charAt(0) === "?" ? init.slice(1) : init;
          if (!q) return;
          for (const part of q.split("&")) {
            if (!part) continue;
            const eq = part.indexOf("=");
            const rawK = eq < 0 ? part : part.slice(0, eq);
            const rawV = eq < 0 ? "" : part.slice(eq + 1);
            this._pairs.push([this._dec(rawK), this._dec(rawV)]);
          }
        } else if (Array.isArray(init)) {
          for (const pair of init) this._pairs.push([String(pair[0]), String(pair[1])]);
        } else if (typeof init === "object") {
          if (init instanceof SevynURLSearchParams) {
            this._pairs = init._pairs.map((p) => [p[0], p[1]]);
          } else {
            for (const k of Object.keys(init)) this._pairs.push([k, String(init[k])]);
          }
        }
      }
      _dec(s) {
        try {
          return decodeURIComponent(s.replace(/\+/g, " "));
        } catch (e) {
          return s;
        }
      }
      _enc(s) {
        return encodeURIComponent(String(s)).replace(/%20/g, "+");
      }
      append(k, v) {
        this._pairs.push([String(k), String(v)]);
      }
      delete(k) {
        const key = String(k);
        this._pairs = this._pairs.filter((p) => p[0] !== key);
      }
      get(k) {
        const key = String(k);
        for (const p of this._pairs) if (p[0] === key) return p[1];
        return null;
      }
      getAll(k) {
        const key = String(k);
        return this._pairs.filter((p) => p[0] === key).map((p) => p[1]);
      }
      has(k) {
        return this.get(k) !== null;
      }
      set(k, v) {
        const key = String(k);
        const val = String(v);
        let seen = false;
        this._pairs = this._pairs.filter((p) => {
          if (p[0] !== key) return true;
          if (seen) return false;
          seen = true;
          p[1] = val;
          return true;
        });
        if (!seen) this._pairs.push([key, val]);
      }
      get size() {
        return this._pairs.length;
      }
      toString() {
        return this._pairs.map((p) => this._enc(p[0]) + "=" + this._enc(p[1])).join("&");
      }
      forEach(fn, thisArg) {
        for (const p of this._pairs) fn.call(thisArg, p[1], p[0], this);
      }
      keys() {
        return this._pairs.map((p) => p[0]).values();
      }
      values() {
        return this._pairs.map((p) => p[1]).values();
      }
      entries() {
        return this._pairs.map((p) => [p[0], p[1]]).values();
      }
    }
    SevynURLSearchParams.prototype[Symbol.iterator] =
      SevynURLSearchParams.prototype.entries;
    globalThis.URLSearchParams = SevynURLSearchParams;
  }
  if (typeof URL === "undefined") {
    class SevynURL {
      constructor(url, base) {
        let input = String(url);
        if (base != null) {
          const b = base instanceof SevynURL ? base : new SevynURL(String(base));
          if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
            // Resolve against the base's protocol + host, NOT its
            // origin: origin is the string "null" for non-http(s)
            // schemes (file:), and expo-router parses routes with
            // `new URL(href, 'file:')` — resolving against "null"
            // would produce the invalid URL "null/...".
            const prefix = b.protocol + "//" + b.host;
            if (input.charAt(0) === "/") input = prefix + input;
            else if (input.charAt(0) === "?") input = prefix + b.pathname + input;
            else input = prefix + b.pathname.replace(/\/[^/]*$/, "/") + input;
          }
        }
        const m =
          /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^\/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(
            input,
          );
        if (!m) throw new TypeError("Invalid URL: " + input);
        this.protocol = m[1] + ":";
        const authority = m[2] || "";
        this.pathname = m[3] || "/";
        this.search = m[4] || "";
        this.hash = m[5] || "";
        const at = authority.lastIndexOf("@");
        const hostport = at >= 0 ? authority.slice(at + 1) : authority;
        const colon = hostport.lastIndexOf(":");
        if (colon > 0 && /^[0-9]+$/.test(hostport.slice(colon + 1))) {
          this.hostname = hostport.slice(0, colon);
          this.port = hostport.slice(colon + 1);
        } else {
          this.hostname = hostport;
          this.port = "";
        }
        this.host = this.port ? this.hostname + ":" + this.port : this.hostname;
        this.origin =
          this.protocol === "http:" || this.protocol === "https:"
            ? this.protocol + "//" + this.host
            : "null";
        this.href =
          this.protocol + "//" + authority + this.pathname + this.search + this.hash;
        this.searchParams = new globalThis.URLSearchParams(
          this.search.charAt(0) === "?" ? this.search.slice(1) : this.search,
        );
      }
      toString() {
        return this.href;
      }
      toJSON() {
        return this.href;
      }
    }
    globalThis.URL = SevynURL;
  }

  // DOMException: Hermes has none; livekit-client subclasses it at
  // module load (`class DeferrableMapAbortError extends DOMException`)
  // and constructs it for WebRTC errors. A minimal Error subclass
  // with the (message, name) constructor is enough.
  if (typeof DOMException === "undefined") {
    class SevynDOMException extends Error {
      constructor(message, name) {
        super(message == null ? "" : String(message));
        this.name = name == null ? "Error" : String(name);
        this.message = message == null ? "" : String(message);
      }
    }
    globalThis.DOMException = SevynDOMException;
  }

  // Intl: Hermes has none. Tokrah uses NumberFormat (compact counts,
  // currency, grouped decimals) and DateTimeFormat (dateStyle /
  // timeStyle) at module load and in feed/event renders, so a
  // missing Intl is a hard crash on the home feed, not a cosmetic
  // gap. Minimal en-US-only implementation of the observed surface.
  if (typeof Intl === "undefined") {
    const CURRENCY_SYMBOLS = {
      USD: "$",
      EUR: "€",
      GBP: "£",
      JPY: "¥",
      CAD: "$",
      AUD: "$",
      CHF: "CHF ",
      CNY: "¥",
      INR: "₹",
    };
    function groupInt(intPart) {
      return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    function trimZeros(frac, minFrac) {
      while (frac.length > minFrac && frac.endsWith("0")) frac = frac.slice(0, -1);
      return frac;
    }
    function formatDecimal(num, minFrac, maxFrac) {
      const neg = num < 0 || Object.is(num, -0);
      const fixed = Math.abs(num).toFixed(maxFrac);
      let parts = fixed.split(".");
      let intPart = groupInt(parts[0]);
      let fracPart = parts.length > 1 ? parts[1] : "";
      fracPart = trimZeros(fracPart, minFrac);
      let out = intPart;
      if (fracPart.length > 0) out += "." + fracPart;
      else if (minFrac > 0) out += "." + "0".repeat(minFrac);
      return (neg ? "-" : "") + out;
    }
    function SevynNumberFormat(locales, options) {
      const opts = options || {};
      this._notation = opts.notation || "standard";
      this._style = opts.style || "decimal";
      this._currency = opts.currency || "USD";
      this._minFrac =
        opts.minimumFractionDigits != null
          ? opts.minimumFractionDigits
          : this._style === "currency"
            ? 2
            : 0;
      this._maxFrac =
        opts.maximumFractionDigits != null
          ? opts.maximumFractionDigits
          : this._style === "currency"
            ? 2
            : 3;
      void locales;
    }
    SevynNumberFormat.prototype.format = function (value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return String(value);
      if (this._notation === "compact") {
        const abs = Math.abs(num);
        const units = [
          [1e12, "T"],
          [1e9, "B"],
          [1e6, "M"],
          [1e3, "K"],
        ];
        for (const pair of units) {
          if (abs >= pair[0]) {
            const scaled = num / pair[0];
            const fixed = Math.abs(scaled).toFixed(this._maxFrac);
            const frac = trimZeros(fixed.indexOf(".") >= 0 ? fixed.split(".")[1] : "", 0);
            const intPart = fixed.split(".")[0];
            return (num < 0 ? "-" : "") + intPart + (frac ? "." + frac : "") + pair[1];
          }
        }
        return formatDecimal(num, 0, this._maxFrac);
      }
      const body = formatDecimal(num, this._minFrac, this._maxFrac);
      if (this._style === "currency") {
        const symbol = CURRENCY_SYMBOLS[this._currency] || this._currency + " ";
        return body.charAt(0) === "-" ? "-" + symbol + body.slice(1) : symbol + body;
      }
      return body;
    };
    SevynNumberFormat.prototype.resolvedOptions = function () {
      return {
        locale: "en-US",
        notation: this._notation,
        style: this._style,
        currency: this._currency,
        minimumFractionDigits: this._minFrac,
        maximumFractionDigits: this._maxFrac,
      };
    };
    const MONTHS_SHORT = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const MONTHS_LONG = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const DAYS_LONG = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    function SevynDateTimeFormat(locales, options) {
      const opts = options || {};
      this._dateStyle = opts.dateStyle || null;
      this._timeStyle = opts.timeStyle || null;
      this._utc = opts.timeZone === "UTC";
      this._weekday = opts.weekday || null;
      this._month = opts.month || null;
      this._day = opts.day || null;
      this._year = opts.year || null;
      this._hour = opts.hour || null;
      this._minute = opts.minute || null;
      this._second = opts.second || null;
      this._hour12 = opts.hour12 !== false;
      void locales;
    }
    SevynDateTimeFormat.prototype.format = function (date) {
      const d = date instanceof Date ? date : new Date(date);
      const g = this._utc
        ? function (name) {
            return d["getUTC" + name]();
          }
        : function (name) {
            return d["get" + name]();
          };
      const month = g("Month");
      const dayNum = g("Date");
      const yearNum = g("FullYear");
      const weekdayNum = g("Day");
      let hourNum = g("Hours");
      const minuteNum = g("Minutes");
      const secondNum = g("Seconds");
      const pad2 = function (n) {
        return (n < 10 ? "0" : "") + n;
      };
      let datePart = "";
      const style = this._dateStyle;
      if (style === "full")
        datePart =
          DAYS_LONG[weekdayNum] +
          ", " +
          MONTHS_LONG[month] +
          " " +
          dayNum +
          ", " +
          yearNum;
      else if (style === "long")
        datePart = MONTHS_LONG[month] + " " + dayNum + ", " + yearNum;
      else if (style === "medium")
        datePart = MONTHS_SHORT[month] + " " + dayNum + ", " + yearNum;
      else if (style === "short")
        datePart = month + 1 + "/" + dayNum + "/" + String(yearNum).slice(2);
      else if (this._month || this._day || this._year || this._weekday) {
        const bits = [];
        if (this._weekday)
          bits.push(
            this._weekday === "long"
              ? DAYS_LONG[weekdayNum]
              : DAYS_LONG[weekdayNum].slice(0, 3),
          );
        if (this._month)
          bits.push(this._month === "long" ? MONTHS_LONG[month] : MONTHS_SHORT[month]);
        if (this._day) bits.push(String(dayNum));
        if (this._year) bits.push(String(yearNum));
        datePart = bits.join(" ");
      }
      let timePart = "";
      const tstyle = this._timeStyle;
      if (tstyle || this._hour || this._minute || this._second) {
        let suffix = "";
        if (this._hour12) {
          suffix = hourNum >= 12 ? " PM" : " AM";
          hourNum = hourNum % 12;
          if (hourNum === 0) hourNum = 12;
        }
        const showSeconds = tstyle === "medium" || tstyle === "long" || this._second;
        timePart =
          (this._hour === "2-digit" ? pad2(hourNum) : String(hourNum)) +
          ":" +
          pad2(minuteNum) +
          (showSeconds ? ":" + pad2(secondNum) : "") +
          suffix;
      }
      if (datePart && timePart) return datePart + ", " + timePart;
      return datePart || timePart;
    };
    SevynDateTimeFormat.prototype.resolvedOptions = function () {
      return {
        locale: "en-US",
        dateStyle: this._dateStyle,
        timeStyle: this._timeStyle,
        timeZone: this._utc ? "UTC" : undefined,
      };
    };
    globalThis.Intl = {
      NumberFormat: SevynNumberFormat,
      DateTimeFormat: SevynDateTimeFormat,
    };
  }

  // ---- HTTP transport -----------------------------------------------
  // Response shape both transports return: {status, headers, body}
  // (body is a string; binary bodies are out of scope for M6).
  // Host transport: one `sevyn net fetch` exec per request. The CLI
  // verb prints "<status>\n<headers-json>\n<body>". Prefer the async
  // bridge (Sevyn.execAsync): the synchronous exec blocks the JS
  // thread for the whole request, and a socket.io long-poll (held
  // open ~5 s by the server ping) would starve the app — the feed
  // never paints and taps land on stale layouts. execAsync runs the
  // CLI on a worker thread and resolves on the main loop. Falls back
  // to the synchronous exec on hosts that predate it.
  function execRequest(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        (async () => {
          try {
            // The exec bridge splits on whitespace with no quoting, so
            // header values and the body travel percent-encoded (the CLI
            // decodes %XX in --header values and --data); a plain body
            // with no %XX passes through unchanged.
            const args = ["sevyn", "net", "fetch", "--method", method, url];
            for (const k of Object.keys(headers || {}))
              args.push("--header", k + ":" + encodeURIComponent(headers[k]));
            if (body != null) args.push("--data", encodeURIComponent(String(body)));
            const run =
              typeof Sevyn.execAsync === "function" ? Sevyn.execAsync : Sevyn.exec;
            const raw = await run(args.join(" "));
            // The exec bridge prefixes the CLI's output with its own
            // "<exit-code>\n" line, so raw is
            // "<exit-code>\n<http-status>\n<headers-json>\n<body>".
            // Parsing the first line as the HTTP status (the old code)
            // gave every in-guest request status 0, which axios treats
            // as a never-settling network error — the login spinner
            // spun forever with no error and no navigation.
            const nl = raw.indexOf("\n");
            if (nl < 0)
              return reject(new Error("net fetch failed: " + raw.slice(0, 120)));
            const exitCode = parseInt(raw.slice(0, nl), 10);
            if (Number.isNaN(exitCode))
              return reject(new Error("net fetch failed: " + raw.slice(0, 120)));
            if (exitCode !== 0)
              return reject(
                new Error(
                  "net fetch failed (exit " +
                    exitCode +
                    "): " +
                    raw.slice(nl + 1, nl + 121),
                ),
              );
            const rest = raw.slice(nl + 1);
            const nl2 = rest.indexOf("\n");
            if (nl2 < 0) return reject(new Error("net fetch failed: no status line"));
            const status = parseInt(rest.slice(0, nl2), 10);
            if (Number.isNaN(status))
              return reject(
                new Error("net fetch failed: bad status: " + rest.slice(0, 120)),
              );
            const rest2 = rest.slice(nl2 + 1);
            const nl3 = rest2.indexOf("\n");
            let respHeaders = {};
            let respBody = rest2;
            if (nl3 >= 0) {
              try {
                respHeaders = JSON.parse(rest2.slice(0, nl3));
              } catch (e) {
                respHeaders = {};
              }
              respBody = rest2.slice(nl3 + 1);
            }
            resolve({ status, headers: respHeaders, body: respBody });
          } catch (e) {
            reject(e);
          }
        })();
      }, 0);
    });
  }
  // Node harness installs __sevynHttpRequest (real http/https); the
  // host uses the exec bridge. Neither is present only if the bundle
  // runs somewhere with no network at all — XHR then errors cleanly.
  const httpRequest =
    typeof globalThis.__sevynHttpRequest === "function"
      ? globalThis.__sevynHttpRequest
      : hasSevyn
        ? execRequest
        : null;

  // ---- XMLHttpRequest -------------------------------------------------
  // Enough of the XHR surface for axios + engine.io-client (polling):
  // open/send, readyState transitions, status/statusText, responseText,
  // getResponseHeader(s), onreadystatechange/onload/onerror/ontimeout,
  // addEventListener, setRequestHeader, abort, timeout.
  function SevynXHR() {
    this.readyState = 0;
    this.status = 0;
    this.statusText = "";
    this.responseText = "";
    this.response = "";
    this.timeout = 0;
    this.withCredentials = false;
    this._headers = {};
    this._listeners = {};
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.ontimeout = null;
  }
  SevynXHR.prototype._emit = function (type, ev) {
    const h = this["on" + type];
    if (typeof h === "function") {
      try {
        h.call(this, ev || {});
      } catch (e) {}
    }
    for (const fn of this._listeners[type] || []) {
      try {
        fn.call(this, ev || {});
      } catch (e) {}
    }
  };
  SevynXHR.prototype._setState = function (state) {
    this.readyState = state;
    this._emit("readystatechange");
  };
  SevynXHR.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  SevynXHR.prototype.removeEventListener = function (type, fn) {
    const l = this._listeners[type];
    if (l) {
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    }
  };
  SevynXHR.prototype.open = function (method, url) {
    this._method = String(method).toUpperCase();
    this._url = String(url);
    this._setState(1);
  };
  SevynXHR.prototype.setRequestHeader = function (k, v) {
    this._headers[k] = String(v);
  };
  SevynXHR.prototype.getResponseHeader = function (name) {
    const h = this._respHeaders || {};
    const want = String(name).toLowerCase();
    for (const k of Object.keys(h)) if (k.toLowerCase() === want) return h[k];
    return null;
  };
  SevynXHR.prototype.getAllResponseHeaders = function () {
    const h = this._respHeaders || {};
    return Object.keys(h)
      .map((k) => k + ": " + h[k])
      .join("\r\n");
  };
  SevynXHR.prototype.abort = function () {
    this._aborted = true;
    this._setState(0);
  };
  SevynXHR.prototype.send = function (body) {
    if (!httpRequest) {
      this._setState(4);
      this._emit("error", new Error("no HTTP transport on this host"));
      return;
    }
    const self = this;
    this._setState(2);
    let done = false;
    const timer =
      this.timeout > 0
        ? setTimeout(() => {
            if (!done) {
              done = true;
              self._emit("timeout");
            }
          }, this.timeout)
        : null;
    httpRequest(
      this._method,
      this._url,
      this._headers,
      body == null ? null : String(body),
    )
      .then((r) => {
        if (done || self._aborted) return;
        done = true;
        if (timer) clearTimeout(timer);
        self.status = r.status;
        self.statusText = r.status >= 200 && r.status < 300 ? "OK" : "";
        self._respHeaders = r.headers || {};
        self.responseText = r.body;
        self.response = r.body;
        self._setState(3);
        self._setState(4);
        self._emit("load");
      })
      .catch((e) => {
        if (done || self._aborted) return;
        done = true;
        if (timer) clearTimeout(timer);
        self._setState(4);
        self._emit("error", e);
      });
  };
  if (typeof XMLHttpRequest === "undefined") globalThis.XMLHttpRequest = SevynXHR;

  // ---- fetch ----------------------------------------------------------
  // Minimal fetch over the same transport (Response with .json/.text,
  // .ok/.status/.headers.get). Enough for livekit-client and any code
  // that prefers fetch over axios.
  if (typeof fetch === "undefined" && httpRequest) {
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init && init.method) || "GET";
      const headers = (init && init.headers) || {};
      const body = init && init.body != null ? String(init.body) : null;
      return httpRequest(method, url, headers, body).then((r) => ({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        statusText: "",
        headers: {
          get: (name) => {
            const want = String(name).toLowerCase();
            for (const k of Object.keys(r.headers || {}))
              if (k.toLowerCase() === want) return r.headers[k];
            return null;
          },
        },
        text: () => Promise.resolve(r.body),
        json: () => Promise.resolve(JSON.parse(r.body)),
      }));
    };
  }

  // FormData / Blob: only the constructor + append surface the mount
  // path touches (axios multipart uploads are out of M6 scope).
  if (typeof FormData === "undefined") {
    globalThis.FormData = function FormData() {
      this._parts = [];
    };
    FormData.prototype.append = function (k, v) {
      this._parts.push([k, v]);
    };
  }
  if (typeof Blob === "undefined") {
    globalThis.Blob = function Blob(parts) {
      this.parts = parts || [];
    };
  }
  // Keep the linter honest: isNode is intentionally unused beyond
  // documentation (transport selection is by __sevynHttpRequest /
  // Sevyn.exec presence, not by a Node check).
  void isNode;
})();
