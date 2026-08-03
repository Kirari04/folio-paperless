export type DocumentFileActionContentState =
  | 'loading'
  | 'offline-unavailable'
  | 'unavailable'
  | 'ready';

export function documentFileActionContentState(input: {
  capabilityLoading: boolean;
  loading: boolean;
  offline: boolean;
  offlineFilesResolved: boolean;
  hasRepresentations: boolean;
  hasSelectedChoice: boolean;
  hasLoadError: boolean;
}): DocumentFileActionContentState {
  if (input.offline && input.offlineFilesResolved && !input.hasRepresentations) {
    return 'offline-unavailable';
  }
  if ((input.capabilityLoading && !input.hasRepresentations) || input.loading) {
    return 'loading';
  }
  if (input.hasLoadError || !input.hasRepresentations || !input.hasSelectedChoice) {
    return 'unavailable';
  }
  return 'ready';
}
