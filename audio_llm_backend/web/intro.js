(() => {
  const overlay = document.getElementById('introOverlay');
  const video = document.getElementById('introVideo');
  const skip = document.getElementById('introSkip');
  const replay = document.getElementById('replayIntro');
  const seenKey = 'audio-insight-intro-seen-v1';
  let closeTimer;

  function finish() {
    if (overlay.hidden) return;
    video.pause();
    overlay.classList.remove('is-visible');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { overlay.hidden = true; }, 260);
    try { sessionStorage.setItem(seenKey, '1'); } catch (_) { /* storage may be disabled */ }
  }

  function show() {
    clearTimeout(closeTimer);
    overlay.hidden = false;
    video.currentTime = 0;
    requestAnimationFrame(() => overlay.classList.add('is-visible'));
    skip.focus({ preventScroll: true });
    const playback = video.play();
    if (playback) playback.catch(finish);
  }

  skip.addEventListener('click', finish);
  video.addEventListener('ended', finish);
  video.addEventListener('error', finish);
  replay.addEventListener('click', show);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) finish();
  });

  let alreadySeen = false;
  try { alreadySeen = sessionStorage.getItem(seenKey) === '1'; } catch (_) { /* storage may be disabled */ }
  if (!alreadySeen && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) show();
})();
