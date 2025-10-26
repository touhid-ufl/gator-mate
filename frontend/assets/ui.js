// ui.js — full helper set + laptop backend connector (ngrok-ready)

// -------------------- Tiny DOM helpers --------------------
export const qs = (s, r=document) => r.querySelector(s);
export const el = (t, a={}, ...c) => {
  const n = document.createElement(t);
  Object.entries(a).forEach(([k,v]) => {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else n.setAttribute(k, v);
  });
  c.forEach(x => n.append(x?.nodeType ? x : document.createTextNode(x ?? '')));
  return n;
};

// Local storage key for per-course answers
export const storageKey = (id) => `answers:${id}`;

// -------------------- GitHub save via Vercel (same-origin) --------------------
export const VERCEL_BASE_URL = ""; // leave empty to use current origin

export async function saveViaVercel(payload) {
  const origin = VERCEL_BASE_URL || window.location.origin;
  const url = origin.replace(/\/$/, '') + '/api/save-answers';
  const same = origin === window.location.origin;

  const res = await fetch(url, {
    method: 'POST',
    mode: same ? 'same-origin' : 'cors',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(txt || ('HTTP ' + res.status));
  }
  return res.json();
}

// -------------------- Local/Remote laptop backend (ngrok-ready) --------------------
// Use HTTPS for ngrok to avoid mixed-content issues when your site is served over HTTPS.
export let BACKEND_URL = 'https://saunciest-unethereal-clora.ngrok-free.dev';

// Optional shared secret header if your backend enforces it
// export const BACKEND_SECRET = "some-long-random-string"; // optional

// Ngrok interstitial bypass
const NGROK_SKIP = { 'ngrok-skip-browser-warning': 'true' };

// Build a fully-qualified backend URL and append the ngrok skip param + cache buster
function buildBackendUrl(path) {
  const base = BACKEND_URL.replace(/\/$/, '');
  const hasQ = path.includes('?');
  const url = `${base}${path}${hasQ ? '&' : '?'}ngrok-skip-browser-warning=true&_=${Date.now()}`;
  return url;
}

// Small fetch wrapper with timeout + robust JSON handling
async function request(method, path, { body, headers={}, timeoutMs=10000, signal } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const mergedSignal = signal
    ? new AbortController()
    : null;

  if (mergedSignal) {
    // If a caller provides a signal, abort our controller when it aborts
    signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  const res = await fetch(buildBackendUrl(path), {
    method,
    cache: 'no-store',
    headers: {
      ...NGROK_SKIP,
      'Content-Type': 'application/json',
      // ...(typeof BACKEND_SECRET === 'string' ? { 'x-backend-secret': BACKEND_SECRET } : {}),
      ...headers
    },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: ctrl.signal
  }).finally(() => clearTimeout(t));

  if (!res.ok) {
    // Try to surface useful error info
    const txt = await res.text().catch(() => '');
    throw new Error(txt || `HTTP ${res.status}`);
  }

  // Guard against ngrok HTML interstitials or unexpected content-types
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    // If backend ever returns non-JSON, still try to parse; otherwise throw
    try {
      return await res.json();
    } catch {
      const txt = await res.text().catch(() => '');
      throw new Error(`Expected JSON from backend, got: ${ct || 'unknown content-type'} ${txt ? '— ' + txt.slice(0, 280) : ''}`);
    }
  }

  return res.json();
}

/**
 * Update backend URL at runtime (e.g., let users switch between local and ngrok)
 * @param {string} url
 */
export function setBackendUrl(url) {
  BACKEND_URL = url;
}

/**
 * Ask the laptop backend (chat endpoint).
 * Automatically adds ngrok bypass header/param and uses cache busting + timeout.
 * @param {object} payload
 * @param {object} [opts] - { timeoutMs?: number, signal?: AbortSignal, headers?: Record<string,string> }
 */
export async function askLaptop(payload, opts = {}) {
  return request('POST', '/api/chat', { body: payload, ...opts });
}

/**
 * Convenience pings you might call from pages (optional utilities)
 * Uncomment/use as needed in your app.
 */
// export async function backendStatus(opts = {}) {
//   return request('GET', '/api/check-status', opts);
// }
// export async function saveAnswers(payload, opts = {}) {
//   return request('POST', '/api/saveAnswers', { body: payload, ...opts });
// }
