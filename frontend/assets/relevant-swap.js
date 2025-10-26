// --- relevant-swap.js (ngrok-ready) ---
// Displays a YouTube popup ("Videos you might find helpful") at specified times
// Uses backend /api/relevant-video -> final_merged_output.json (slide-based)
// Triggers using actual YouTube player time: yt = player.getCurrentTime()

/* Helper to extract YouTube video ID */
function parseYouTubeId(u) {
  try {
    const url = new URL(u);
    if (url.hostname.includes('youtu.be')) return url.pathname.replace(/^\//, '');
    if (url.hostname.includes('youtube.com')) return url.searchParams.get('v');
  } catch (e) {}
  return null;
}

/* -------------------- Backend config (HTTPS for ngrok) -------------------- */
let BACKEND_URL = 'https://saunciest-unethereal-clora.ngrok-free.dev';

const NGROK_SKIP = { 'ngrok-skip-browser-warning': 'true' };
const NO_STORE = { cache: 'no-store' };

function buildBackendUrl(path) {
  const base = BACKEND_URL.replace(/\/$/, '');
  const hasQ = path.includes('?');
  return `${base}${path}${hasQ ? '&' : '?'}ngrok-skip-browser-warning=true&_=${Date.now()}`;
}

/* Simple fetch with timeout + content-type guard */
async function getJson(path, { timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(buildBackendUrl(path), {
      ...NO_STORE,
      headers: { ...NGROK_SKIP },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      try {
        return await res.json();
      } catch (e) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Expected JSON, got ${ct || 'unknown'}${txt ? ' — ' + txt.slice(0, 180) : ''}`);
      }
    }
    return res.json();
  } finally {
    clearTimeout(to);
  }
}

/* Wait for a condition */
function waitFor(fn, { interval = 150, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      try {
        if (fn()) {
          clearInterval(id);
          resolve(true);
          return;
        }
      } catch (e) {}
      if (Date.now() - t0 > timeout) {
        clearInterval(id);
        resolve(false);
      }
    }, interval);
  });
}

/* Modal builder */
function ensureModal() {
  const existing = document.getElementById('rs-modal');
  if (existing) return existing;

  if (!document.getElementById('rs-modal-style')) {
    const css = `
#rs-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.6);z-index:9999}
#rs-modal .rs-panel{background:#fff;border-radius:14px;box-shadow:0 12px 28px rgba(0,0,0,.24);width:min(1100px,96vw);padding:16px 16px 20px;display:flex;flex-direction:column;gap:12px}
#rs-modal .rs-head{display:flex;align-items:center;justify-content:space-between}
#rs-modal .rs-title{margin:0;font:600 18px/1.3 system-ui,Segoe UI,Roboto;color:#0021A5}
#rs-modal .rs-close{appearance:none;border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:#444;padding:4px}
#rs-modal .rs-player{position:relative;width:100%;max-width:100%;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:#000}
#rs-modal .rs-player iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
@media (max-width:640px){
  #rs-modal .rs-panel{padding:12px}
  #rs-modal .rs-title{font-size:16px}
}
`.trim();
    const style = document.createElement('style');
    style.id = 'rs-modal-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  const modal = document.createElement('div');
  modal.id = 'rs-modal';
  modal.innerHTML = `
    <div class="rs-panel" role="dialog" aria-modal="true" aria-label="Helpful video">
      <div class="rs-head">
        <h3 class="rs-title">Videos you might find helpful</h3>
        <button class="rs-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="rs-player"><div id="secondary-player"></div></div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

/* Load relevant info for current course */
async function loadRelevant() {
  try {
    const json = await getJson('/api/relevant-video');
    if (!json || !json.ok) throw new Error((json && json.error) || 'Invalid response');
    const arr = Array.isArray(json.data) ? json.data : [];
    if (!arr.length) throw new Error('No relevant slides found');
    return arr;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('⚠️ Failed to fetch relevant video info:', err);
    return [];
  }
}

(function boot() {
  async function start() {
    const ready = await waitFor(
      () =>
        typeof window !== 'undefined' &&
        window.YT &&
        window.player &&
        typeof window.player.getPlayerState === 'function' &&
        typeof window.player.getCurrentTime === 'function',
      { timeout: 20000 }
    );
    if (!ready) return;

    // Use the global player the page provides
    const player = window.player;

    const slides = await loadRelevant();
    if (!slides.length) return;

    // Pick the first valid slide
    const m = slides.find(
      (s) =>
        s &&
        s.video_start != null &&
        s.yt_video_link_start &&
        s.yt_start_time != null &&
        s.yt_end_time != null
    );
    if (!m) return;

    // --- Core timing values (all numbers) ---
    const popupAt = Number(m.video_start); // when to pop, in *primary* video seconds
    const segStart = Number(m.yt_start_time); // secondary segment start
    const segEnd = Number(m.yt_end_time); // secondary segment end
    const ytLink = String(m.yt_video_link_start);
    const duration = Math.max(0, segEnd - segStart); // secondary clip duration
    const vidId = parseYouTubeId(ytLink);

    if (!vidId || !(segEnd > segStart) || !(popupAt >= 0)) return;

    // --- State ---
    const EPS = 0.25;
    let popupTriggered = false; // ensures we only show once
    let watchingPrimary = true;
    let secondaryPlayer = null;
    let rafId = null;

    // Poll actual YT time from the primary player; when yt >= popupAt, trigger popup.
    function tick() {
      try {
        const st =
          (typeof player.getPlayerState === 'function' && player.getPlayerState()) || null;
        const yt =
          (typeof player.getCurrentTime === 'function' && player.getCurrentTime()) || 0;

        if (watchingPrimary && !popupTriggered) {
          if (
            st === window.YT.PlayerState.PLAYING ||
            st === window.YT.PlayerState.BUFFERING ||
            st === window.YT.PlayerState.PAUSED
          ) {
            if (yt + EPS >= popupAt) {
              popupTriggered = true;
              runSegment(yt);
              return; // runSegment will manage the flow
            }
          }
        }
      } catch (e) {}

      rafId = window.requestAnimationFrame(tick);
    }

    function startTicking() {
      if (!rafId) rafId = window.requestAnimationFrame(tick);
    }
    function stopTicking() {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    function onStateChange(e) {
      // Keep ticking so we can catch resume/time progress naturally
      if (!watchingPrimary) return;
      if (
        e.data === window.YT.PlayerState.PLAYING ||
        e.data === window.YT.PlayerState.BUFFERING ||
        e.data === window.YT.PlayerState.PAUSED
      ) {
        startTicking();
      }
    }

    try {
      if (player && typeof player.addEventListener === 'function') {
        player.addEventListener('onStateChange', onStateChange);
      }
    } catch (e) {}

    try {
      const st = player.getPlayerState && player.getPlayerState();
      if (
        st === window.YT.PlayerState.PLAYING ||
        st === window.YT.PlayerState.BUFFERING ||
        st === window.YT.PlayerState.PAUSED
      ) {
        startTicking();
      }
    } catch (e) {}

    // --- Modal helpers ---
    function showModal(titleText) {
      const modal = ensureModal();
      modal.style.display = 'flex';
      if (titleText) {
        const t = modal.querySelector('.rs-title');
        if (t) t.textContent = titleText;
      }
      return modal;
    }
    function hideModal() {
      const modal = document.getElementById('rs-modal');
      if (modal) modal.style.display = 'none';
    }
    function attachCloseHandler(resumeTime) {
      const modal = document.getElementById('rs-modal');
      const btn = modal ? modal.querySelector('.rs-close') : null;
      if (btn) btn.onclick = () => restorePrimary(resumeTime);
      function escHandler(ev) {
        if (ev.key === 'Escape') restorePrimary(resumeTime);
      }
      document.addEventListener('keydown', escHandler, { once: true });
    }

    // Resume the primary player at resumeTime and continue ticking.
    function restorePrimary(resumeTime) {
      hideModal();

      try {
        if (secondaryPlayer && typeof secondaryPlayer.stopVideo === 'function') {
          secondaryPlayer.stopVideo();
        }
      } catch (e) {}
      try {
        if (secondaryPlayer && typeof secondaryPlayer.destroy === 'function') {
          secondaryPlayer.destroy();
        }
      } catch (e) {}
      secondaryPlayer = null;

      watchingPrimary = true;
      stopTicking();

      const t = Math.max(0, Math.floor(resumeTime));
      let attempts = 0;
      const retry = window.setInterval(() => {
        attempts += 1;
        try {
          if (typeof player.seekTo === 'function') player.seekTo(t, true);
        } catch (e) {}
        try {
          if (typeof player.playVideo === 'function') player.playVideo();
        } catch (e) {}

        try {
          const st = player.getPlayerState && player.getPlayerState();
          if (st === window.YT.PlayerState.PLAYING) {
            clearInterval(retry);
            startTicking();
          }
        } catch (e) {}

        if (attempts >= 20) {
          clearInterval(retry);
          startTicking();
        }
      }, 300);
    }

    // Play the secondary clip for `duration` seconds, then close and resume.
    function runSegment(currentPrimaryTime) {
      watchingPrimary = false;
      stopTicking();

      try {
        if (typeof player.pauseVideo === 'function') player.pauseVideo();
      } catch (e) {}

      const modal = showModal(m.video_title || 'Videos you might find helpful');
      attachCloseHandler(currentPrimaryTime);

      const container = modal.querySelector('#secondary-player');
      if (container) {
        // clear previous iframe if any (safety)
        container.innerHTML = '';
      }

      let segRaf = null;
      let startWall = null;

      function startSecondaryWallTimer(resumeAt) {
        function segTick(now) {
          if (startWall == null) startWall = now;
          const elapsed = (now - startWall) / 1000; // seconds
          if (elapsed + EPS >= duration) {
            if (segRaf) window.cancelAnimationFrame(segRaf);
            segRaf = null;
            restorePrimary(resumeAt);
            return;
          }
          segRaf = window.requestAnimationFrame(segTick);
        }
        segRaf = window.requestAnimationFrame(segTick);
      }

      secondaryPlayer = new window.YT.Player('secondary-player', {
        videoId: vidId,
        width: '100%',
        height: '100%',
        playerVars: {
          start: Math.max(0, segStart),
          rel: 0,
          modestbranding: 1,
          controls: 1,
          iv_load_policy: 3
        },
        events: {
          onReady: (e) => {
            try {
              if (e && e.target && typeof e.target.seekTo === 'function') {
                e.target.seekTo(Math.max(0, segStart), true);
              }
            } catch (err) {}
            try {
              if (e && e.target && typeof e.target.playVideo === 'function') {
                e.target.playVideo();
              }
            } catch (err) {}
            startSecondaryWallTimer(currentPrimaryTime);
          }
        }
      });
    }
  }

  if (typeof window !== 'undefined' && window.YT && window.player) {
    // Primary player already available
    start();
  } else {
    // Wait for host page to signal readiness
    window.addEventListener('primary-player-ready', () => {
      start();
    }, { once: true });
  }
})();
