(() => {
  const tabs = document.querySelector('.result-tabs');
  if (!tabs) return;
  const buttons = Array.from(tabs.querySelectorAll('.tab'));
  const indicator = document.createElement('span');
  indicator.className = 'result-tab-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  tabs.prepend(indicator);

  function positionIndicator() {
    const active = tabs.querySelector('.tab.active');
    if (!active) return;
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.height = `${active.offsetHeight}px`;
    indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  }

  // Follow both clicks and programmatic tab changes (search, upload, history).
  const selectionObserver = new MutationObserver(positionIndicator);
  buttons.forEach((button) => selectionObserver.observe(button, { attributes: true, attributeFilter: ['class'] }));
  const sizeObserver = new ResizeObserver(positionIndicator);
  sizeObserver.observe(tabs);
  buttons.forEach((button) => sizeObserver.observe(button));
  document.fonts.ready.then(positionIndicator);
  positionIndicator();
  // Commit its initial position before enabling travel between selections.
  indicator.getBoundingClientRect();
  tabs.classList.add('tabs-ready');
})();
