// Navigation for the sequence view. Swiping is native scroll-snap; this adds
// keys, buttons, click halves, #n URLs and preloading of neighbours.

export function initSequence(seq: HTMLElement) {
  const track = seq.querySelector<HTMLElement>('.track')!;
  const frames = [...track.querySelectorAll<HTMLElement>('.frame')];
  const prev = seq.querySelector<HTMLButtonElement>('.prev')!;
  const next = seq.querySelector<HTMLButtonElement>('.next')!;
  const firstImage = Number(seq.dataset.firstImage);
  const last = frames.length - 1;
  let current = -1;

  const clamp = (i: number) => Math.min(last, Math.max(0, i));
  const indexAtScroll = () => clamp(Math.round(track.scrollLeft / track.clientWidth));

  function indexFromHash() {
    const n = parseInt(location.hash.slice(1), 10);
    return n > 0 ? clamp(n - 1 + firstImage) : 0;
  }

  function settle(i: number) {
    if (i === current) return;
    current = i;
    const n = frames[i]!.dataset.number;
    const url = n ? `#${n}` : location.pathname + location.search;
    if (url !== location.hash) history.replaceState(null, '', url);
    prev.disabled = i === 0;
    next.disabled = i === last;
    frames.forEach((f, j) => (f.inert = j !== i));
    for (const j of [i - 1, i + 1, i + 2]) {
      const img = frames[j]?.querySelector('img');
      if (img) img.loading = 'eager';
    }
  }

  function go(i: number) {
    i = clamp(i);
    track.scrollTo({ left: i * track.clientWidth, behavior: 'instant' });
    settle(i);
  }

  let timer: number | undefined;
  track.addEventListener(
    'scroll',
    () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => settle(indexAtScroll()), 80);
    },
    { passive: true },
  );

  // Keep the current frame in place when the viewport resizes.
  new ResizeObserver(() => {
    if (current >= 0) track.scrollLeft = current * track.clientWidth;
  }).observe(track);

  prev.addEventListener('click', () => go(current - 1));
  next.addEventListener('click', () => go(current + 1));

  track.addEventListener('click', (e) => {
    const img = (e.target as Element).closest('.plate img');
    if (!img) return;
    const r = img.getBoundingClientRect();
    go(e.clientX < r.left + r.width / 2 ? current - 1 : current + 1);
  });

  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = e.target as Element;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    const step: Record<string, () => void> = {
      ArrowRight: () => go(current + 1),
      ArrowLeft: () => go(current - 1),
      PageDown: () => go(current + 1),
      PageUp: () => go(current - 1),
      Home: () => go(0),
      End: () => go(last),
      Escape: () => location.assign(seq.dataset.indexHref!),
    };
    const action = step[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  });

  window.addEventListener('hashchange', () => go(indexFromHash()));

  go(indexFromHash());
}
