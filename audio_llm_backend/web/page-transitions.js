(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let navigating = false;

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.target && link.target !== '_self' || link.hasAttribute('download')) return;
    const destination = new URL(link.href, location.href);
    if (destination.origin !== location.origin || !['/', '/app'].includes(destination.pathname)) return;
    if (destination.href === location.href || navigating || reducedMotion.matches) return;
    event.preventDefault();
    navigating = true;
    document.body.classList.add('page-leaving');
    window.setTimeout(() => { location.assign(destination.href); }, 180);
  });

  window.addEventListener('pageshow', () => {
    navigating = false;
    document.body.classList.remove('page-leaving');
  });
})();
