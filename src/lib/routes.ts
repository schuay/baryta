import type { Gallery, View } from './model.ts';

export const VIEW_LABELS: Record<View, string> = { sequence: 'Sequence', grid: 'Index' };

/** The gallery's primary view lives at its path, the other one below it. */
export function viewHref(g: Gallery, view: View): string {
  return view === g.view ? g.path : `${g.path}${view}/`;
}

export function otherView(view: View): View {
  return view === 'sequence' ? 'grid' : 'sequence';
}
