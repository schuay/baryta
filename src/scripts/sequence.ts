// Navigation for the sequence view. Swiping is native scroll-snap; this adds
// keys, buttons, click halves, #n URLs and preloading of neighbours.
//
// A step is whatever the CSS currently makes a snap target: a whole frame, or
// on portrait screens a single column (page or image) of a split frame.

function isStep(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  return cs.display !== 'contents' && cs.display !== 'none' && cs.scrollSnapAlign !== 'none';
}

export function initSequence(seq: HTMLElement) {
  const track = seq.querySelector<HTMLElement>('.track')!;
  const candidates = [...track.querySelectorAll<HTMLElement>('.frame, .column')];
  const prev = seq.querySelector<HTMLButtonElement>('.prev')!;
  const next = seq.querySelector<HTMLButtonElement>('.next')!;
  let steps: HTMLElement[] = [];
  let current: HTMLElement | undefined;

  const refresh = () => (steps = candidates.filter(isStep));
  const index = () => (current ? steps.indexOf(current) : -1);

  function stepAtScroll(): HTMLElement | undefined {
    let best: HTMLElement | undefined;
    for (const s of steps) {
      if (!best || Math.abs(s.offsetLeft - track.scrollLeft) < Math.abs(best.offsetLeft - track.scrollLeft)) best = s;
    }
    return best;
  }

  function stepForNumber(n: number): HTMLElement | undefined {
    return steps.find((s) => s.dataset.number === String(n));
  }

  function settle(step: HTMLElement) {
    if (step === current) return;
    current = step;
    const i = index();
    const n = step.dataset.number;
    const url = n ? `#${n}` : location.pathname + location.search;
    if (url !== location.hash) history.replaceState(null, '', url);
    prev.disabled = i === 0;
    next.disabled = i === steps.length - 1;
    for (const c of candidates) {
      c.inert = false;
      delete c.dataset.current;
    }
    for (const s of steps) s.inert = s !== step;
    step.dataset.current = '';
    for (const j of [i - 1, i + 1, i + 2]) {
      for (const img of steps[j]?.querySelectorAll('img') ?? []) img.loading = 'eager';
    }
  }

  function go(i: number) {
    const step = steps[Math.min(steps.length - 1, Math.max(0, i))];
    if (!step) return;
    track.scrollTo({ left: step.offsetLeft, behavior: 'instant' });
    settle(step);
  }

  let timer: number | undefined;
  track.addEventListener(
    'scroll',
    () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const s = stepAtScroll();
        if (s) settle(s);
      }, 80);
    },
    { passive: true },
  );

  // On resize the set of steps can change (frames split or join); stay on the
  // same frame, or the same column of it.
  new ResizeObserver(() => {
    const before = current;
    refresh();
    let target = before && steps.includes(before) ? before : undefined;
    if (!target && before) {
      const n = Number(before.dataset.number);
      target = (before.classList.contains('column') && before.closest<HTMLElement>('.frame')) || undefined;
      if (!target || !steps.includes(target)) target = stepForNumber(n);
    }
    if (!target) return;
    current = undefined;
    track.scrollLeft = target.offsetLeft;
    settle(target);
  }).observe(track);

  prev.addEventListener('click', () => go(index() - 1));
  next.addEventListener('click', () => go(index() + 1));

  track.addEventListener('click', (e) => {
    const img = (e.target as Element).closest('.region img');
    if (!img) return;
    const r = track.getBoundingClientRect();
    go(e.clientX < r.left + r.width / 2 ? index() - 1 : index() + 1);
  });

  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = e.target as Element;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    const step: Record<string, () => void> = {
      ArrowRight: () => go(index() + 1),
      ArrowLeft: () => go(index() - 1),
      PageDown: () => go(index() + 1),
      PageUp: () => go(index() - 1),
      Home: () => go(0),
      End: () => go(steps.length - 1),
      Escape: () => location.assign(seq.dataset.indexHref!),
    };
    const action = step[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  });

  function fromHash() {
    const n = parseInt(location.hash.slice(1), 10);
    const step = n > 0 ? stepForNumber(n) : undefined;
    go(step ? steps.indexOf(step) : 0);
  }

  window.addEventListener('hashchange', fromHash);
  refresh();
  fromHash();
}
