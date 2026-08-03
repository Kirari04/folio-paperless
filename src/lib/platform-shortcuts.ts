import type { ExternalRoute } from './external-routing';

export const FOLIO_SHORTCUTS = [
  {
    id: 'quick-scan',
    title: 'Quick Scan',
    longTitle: 'Scan into Folio',
    route: 'folio-paperless://scan',
  },
  {
    id: 'inbox',
    title: 'Inbox',
    longTitle: 'Open Folio Inbox',
    route: 'folio-paperless://inbox',
  },
  {
    id: 'search',
    title: 'Search',
    longTitle: 'Search Folio',
    route: 'folio-paperless://search',
  },
] as const;

export type FolioShortcutId = (typeof FOLIO_SHORTCUTS)[number]['id'];

export type ShortcutParseResult =
  | { accepted: true; route: ExternalRoute }
  | { accepted: false; code: 'invalid-shortcut' | 'unsupported-shortcut' };

export function routeForShortcut(input: unknown): ShortcutParseResult {
  if (typeof input !== 'string' || input.length > 64) {
    return { accepted: false, code: 'invalid-shortcut' };
  }
  switch (input) {
    case 'quick-scan':
      return { accepted: true, route: { kind: 'scanner', source: 'shortcut' } };
    case 'inbox':
      return {
        accepted: true,
        route: {
          kind: 'inbox',
          source: 'shortcut',
          scope: { kind: 'active-profile' },
        },
      };
    case 'search':
      return {
        accepted: true,
        route: {
          kind: 'search',
          source: 'shortcut',
          scope: { kind: 'active-profile' },
        },
      };
    default:
      return { accepted: false, code: 'unsupported-shortcut' };
  }
}
