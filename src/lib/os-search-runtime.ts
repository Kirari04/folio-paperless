import { buildOsSearchReconciliation } from './os-search-privacy.ts';
import type {
  OsSearchPrivacyPolicy,
  SearchableDocumentSummary,
} from './os-search-privacy';
import type {
  FolioPlatformCapabilities,
  NativeOsSearchIndexAdapter,
} from './os-search-native-adapter';

export type OsSearchRuntimeResult =
  | { kind: 'indexed'; count: number; engine: FolioPlatformCapabilities['osSearch']['engine'] }
  | { kind: 'cleared'; reason: 'disabled' | 'locked' | 'signed-out' | 'no-profile' }
  | { kind: 'unsupported'; reason: string };

export async function reconcileNativeOsSearch(
  adapter: NativeOsSearchIndexAdapter,
  input: {
    policy: OsSearchPrivacyPolicy;
    profileId: string | null;
    unlocked: boolean;
    authenticated: boolean;
    clearOnBackground: boolean;
    documents: readonly SearchableDocumentSummary[];
  },
): Promise<OsSearchRuntimeResult> {
  const mayIndex = Boolean(
    input.policy.enabled
    && input.profileId
    && input.unlocked
    && input.authenticated,
  );
  await adapter.setAccessState({
    unlocked: mayIndex,
    clearOnBackground: input.clearOnBackground,
  });

  const capabilities = await adapter.capabilities();
  if (!capabilities.osSearch.supported) {
    return {
      kind: 'unsupported',
      reason: capabilities.osSearch.reason ?? 'platform-unavailable',
    };
  }

  if (!mayIndex || !input.profileId) {
    await adapter.clear();
    return {
      kind: 'cleared',
      reason: !input.policy.enabled
        ? 'disabled'
        : !input.unlocked
          ? 'locked'
          : !input.authenticated
            ? 'signed-out'
            : 'no-profile',
    };
  }

  const plan = buildOsSearchReconciliation({
    policy: input.policy,
    profileId: input.profileId,
    unlocked: true,
    authenticated: true,
    documents: input.documents,
    currentEntries: [],
  });
  await adapter.replace(plan.upsert);
  return {
    kind: 'indexed',
    count: plan.upsert.length,
    engine: capabilities.osSearch.engine,
  };
}

export async function revokeNativeOsSearch(
  adapter: NativeOsSearchIndexAdapter,
  clearOnBackground: boolean,
): Promise<void> {
  await adapter.setAccessState({ unlocked: false, clearOnBackground });
  await adapter.clear();
}
