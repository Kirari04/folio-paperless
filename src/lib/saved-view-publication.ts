import type {
  PaperlessCatalog,
  PaperlessSavedView as LibrarySavedView,
} from '../types/document.ts';
import type { PaperlessSavedView as RemoteSavedView } from '../types/paperless-advanced.ts';
import type { FolioRepository } from '../types/persistence.ts';

export function librarySavedViewFromRemote(view: RemoteSavedView): LibrarySavedView {
  return {
    id: `remote-saved-view-${view.id}`,
    remoteId: view.id,
    name: view.name,
    sortField: view.sortField || 'added',
    sortReverse: view.sortReverse,
    filterRules: view.filterRules.map((rule) => ({
      ruleType: rule.ruleType,
      value: rule.value,
      known: rule.known,
      extra: rule.extra,
    })),
    pageSize: view.pageSize || 50,
    ...(view.displayMode ? { displayMode: view.displayMode } : {}),
    displayFields: (view.displayFields || []).map(String),
    extra: view.extra,
  };
}

export function catalogWithSavedView(
  catalog: PaperlessCatalog,
  view: LibrarySavedView,
): PaperlessCatalog {
  return {
    ...catalog,
    savedViews: [
      ...catalog.savedViews.filter((item) => item.remoteId !== view.remoteId && item.id !== view.id),
      view,
    ].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function catalogWithoutSavedView(
  catalog: PaperlessCatalog,
  remoteId: number,
): PaperlessCatalog {
  return {
    ...catalog,
    savedViews: catalog.savedViews.filter((view) => view.remoteId !== remoteId),
  };
}

/** Persists the authoritative mutation response before any fallible GET refresh. */
export async function persistReturnedSavedView(
  repository: Pick<FolioRepository, 'upsertSavedView'>,
  profileId: string,
  remoteView: RemoteSavedView,
): Promise<LibrarySavedView> {
  const view = librarySavedViewFromRemote(remoteView);
  await repository.upsertSavedView(profileId, view);
  return view;
}

/** Persists a confirmed DELETE before any fallible GET refresh. */
export async function persistDeletedSavedView(
  repository: Pick<FolioRepository, 'deleteSavedView'>,
  profileId: string,
  remoteId: number,
): Promise<void> {
  await repository.deleteSavedView(profileId, remoteId);
}
