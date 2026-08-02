import type { ExternalRoute } from './external-routing';
import { translateRuntime } from '../i18n/runtime.ts';

export const DEFAULT_OS_SEARCH_POLICY = {
  enabled: false,
  metadata: 'minimal',
  maxItems: 250,
} as const;

export type OsSearchPrivacyPolicy = {
  enabled: boolean;
  metadata: 'minimal' | 'document-title';
  maxItems: number;
};

export type SearchableDocumentSummary = {
  profileId: string;
  documentId: string;
  title?: string;
  updatedAt: string;
  canView: boolean;
  deleted: boolean;
};

export type OsSearchIndexEntry = {
  identifier: string;
  profileId: string;
  documentId: string;
  displayTitle: string;
  keywords: string[];
  updatedAt: string;
  route: ExternalRoute;
};

export type OsSearchReconciliationPlan = {
  upsert: OsSearchIndexEntry[];
  removeIdentifiers: string[];
  reason: 'disabled' | 'locked' | 'signed-out' | 'reconcile';
};

export interface OsSearchIndexAdapter {
  upsert(entries: OsSearchIndexEntry[]): Promise<void>;
  remove(identifiers: string[]): Promise<void>;
  removeProfile(profileId: string): Promise<void>;
  clear(): Promise<void>;
}

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertOpaqueId(value: string, field: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function normalizePolicy(policy: OsSearchPrivacyPolicy): OsSearchPrivacyPolicy {
  if (!Number.isSafeInteger(policy.maxItems) || policy.maxItems < 1 || policy.maxItems > 1_000) {
    throw new Error('OS search index capacity must be between 1 and 1000.');
  }
  if (policy.metadata !== 'minimal' && policy.metadata !== 'document-title') {
    throw new Error('OS search metadata policy is invalid.');
  }
  return { ...policy };
}

function safeTitle(value: string | undefined): string {
  if (!value) return translateRuntime('osSearch.genericDocumentTitle');
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return translateRuntime('osSearch.genericDocumentTitle');
  return cleaned.length > 100 ? `${cleaned.slice(0, 99).trimEnd()}…` : cleaned;
}

export function osSearchIdentifier(profileId: string, documentId: string): string {
  return `folio:${assertOpaqueId(profileId, 'Profile ID')}:${assertOpaqueId(documentId, 'Document ID')}`;
}

function indexEntry(
  document: SearchableDocumentSummary,
  policy: OsSearchPrivacyPolicy,
): OsSearchIndexEntry {
  assertOpaqueId(document.profileId, 'Profile ID');
  assertOpaqueId(document.documentId, 'Document ID');
  if (!Number.isFinite(Date.parse(document.updatedAt))) throw new Error('Document update date is invalid.');
  return {
    identifier: osSearchIdentifier(document.profileId, document.documentId),
    profileId: document.profileId,
    documentId: document.documentId,
    displayTitle: policy.metadata === 'document-title'
      ? safeTitle(document.title)
      : translateRuntime('osSearch.genericDocumentTitle'),
    keywords: [],
    updatedAt: document.updatedAt,
    route: {
      kind: 'document',
      source: 'os-search',
      profileId: document.profileId,
      documentId: document.documentId,
    },
  };
}

function sameEntry(left: OsSearchIndexEntry, right: OsSearchIndexEntry): boolean {
  return (
    left.profileId === right.profileId &&
    left.documentId === right.documentId &&
    left.displayTitle === right.displayTitle &&
    left.updatedAt === right.updatedAt &&
    left.keywords.length === 0 &&
    right.keywords.length === 0
  );
}

export function buildOsSearchReconciliation(input: {
  policy: OsSearchPrivacyPolicy;
  profileId: string;
  unlocked: boolean;
  authenticated: boolean;
  documents: readonly SearchableDocumentSummary[];
  currentEntries: readonly OsSearchIndexEntry[];
}): OsSearchReconciliationPlan {
  const policy = normalizePolicy(input.policy);
  const profileId = assertOpaqueId(input.profileId, 'Profile ID');
  const current = input.currentEntries.filter((entry) => entry.profileId === profileId);
  if (!policy.enabled) {
    return {
      upsert: [],
      removeIdentifiers: current.map((entry) => entry.identifier),
      reason: 'disabled',
    };
  }
  if (!input.unlocked) {
    return {
      upsert: [],
      removeIdentifiers: current.map((entry) => entry.identifier),
      reason: 'locked',
    };
  }
  if (!input.authenticated) {
    return {
      upsert: [],
      removeIdentifiers: current.map((entry) => entry.identifier),
      reason: 'signed-out',
    };
  }

  const desired = input.documents
    .filter(
      (document) =>
        document.profileId === profileId && document.canView === true && document.deleted === false,
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, policy.maxItems)
    .map((document) => indexEntry(document, policy));
  const desiredById = new Map(desired.map((entry) => [entry.identifier, entry]));
  const currentById = new Map(current.map((entry) => [entry.identifier, entry]));

  return {
    upsert: desired.filter((entry) => {
      const existing = currentById.get(entry.identifier);
      return !existing || !sameEntry(existing, entry);
    }),
    removeIdentifiers: current
      .filter((entry) => !desiredById.has(entry.identifier))
      .map((entry) => entry.identifier),
    reason: 'reconcile',
  };
}

export async function applyOsSearchReconciliation(
  adapter: OsSearchIndexAdapter,
  plan: OsSearchReconciliationPlan,
): Promise<void> {
  if (plan.removeIdentifiers.length) await adapter.remove(plan.removeIdentifiers);
  if (plan.upsert.length) await adapter.upsert(plan.upsert);
}

export async function revokeOsSearchForProfile(
  adapter: OsSearchIndexAdapter,
  profileId: string,
): Promise<void> {
  await adapter.removeProfile(assertOpaqueId(profileId, 'Profile ID'));
}
