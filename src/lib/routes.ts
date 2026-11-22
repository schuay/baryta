import type { Gallery, View } from './model.ts';

export const VIEW_LABELS: Record<View, string> = { sequence: 'Sequence', grid: 'Index' };

/** The gallery's primary view lives at /slug/, the other at /slug/<view>/. */
export function viewHref(g: Gallery, view: View): string {
  return view === g.view ? `/${g.slug}/` : `/${g.slug}/${view}/`;
}

export function otherView(view: View): View {
  return view === 'sequence' ? 'grid' : 'sequence';
}
