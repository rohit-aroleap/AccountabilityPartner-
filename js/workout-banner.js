import { getWorkoutMeta, loadWorkoutData } from './workout.js';

let bannerEl;
let updateTimer = null;

export function initWorkoutBanner() {
  const sidebar = document.querySelector('.sidebar');
  const list = document.querySelector('.customer-list');
  if (!sidebar || !list) return;

  bannerEl = document.createElement('div');
  bannerEl.className = 'workout-banner';
  bannerEl.innerHTML = `
    <span class="wb-dot" id="wb-dot"></span>
    <span class="wb-text" id="wb-text">Workout data not loaded</span>
    <button type="button" class="wb-refresh" id="wb-refresh" title="Force refresh from worker">&#x21bb;</button>
  `;
  sidebar.insertBefore(bannerEl, list);

  document.getElementById('wb-refresh').addEventListener('click', forceRefresh);
  update();
  updateTimer = setInterval(update, 30_000);
}

function update() {
  if (!bannerEl) return;
  const meta = getWorkoutMeta();
  const text = document.getElementById('wb-text');
  const dot = document.getElementById('wb-dot');
  if (!meta) {
    text.textContent = 'Workout data not loaded';
    dot.className = 'wb-dot dim';
    return;
  }
  const ageMs = meta.exportedAt ? Date.now() - meta.exportedAt : null;
  const ageStr = ageMs != null ? relativeTime(ageMs) : 'unknown';
  text.textContent = `Ferra data · ${meta.userCount} users · exported ${ageStr}`;
  // Health dot: green if < 30 min old, yellow < 6 h, red beyond
  if (ageMs == null) dot.className = 'wb-dot dim';
  else if (ageMs < 30 * 60 * 1000) dot.className = 'wb-dot ok';
  else if (ageMs < 6 * 60 * 60 * 1000) dot.className = 'wb-dot warn';
  else dot.className = 'wb-dot stale';
}

async function forceRefresh() {
  const btn = document.getElementById('wb-refresh');
  const text = document.getElementById('wb-text');
  btn.disabled = true;
  btn.classList.add('busy');
  const previous = text.textContent;
  text.textContent = 'Refreshing…';
  try {
    await loadWorkoutData({ force: true });
    update();
  } catch (err) {
    text.textContent = `Refresh failed: ${err.message}`;
    setTimeout(() => { text.textContent = previous; }, 4000);
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

function relativeTime(ms) {
  if (ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.floor(hr / 24)} d ago`;
}
