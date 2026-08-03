import { translateRuntime } from '../i18n/runtime.ts';

export const WIDGET_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const WIDGET_QUICK_SCAN_ROUTE = 'folio-paperless://scan' as const;
export const MAX_WIDGET_SNAPSHOT_BYTES = 1_024;

export type FolioWidgetLabels = {
  locked: string;
  inbox: string;
  openScan: string;
  inboxItem: string;
  inboxItems: string;
};

type WidgetSnapshotCommon = {
  schemaVersion: typeof WIDGET_SNAPSHOT_SCHEMA_VERSION;
  quickScanRoute: typeof WIDGET_QUICK_SCAN_ROUTE;
  /** Optional only so an app upgrade can safely render a version-one cached snapshot. */
  labels?: FolioWidgetLabels;
};

export type FolioWidgetSnapshot = WidgetSnapshotCommon & (
  | {
      state: 'locked';
      inboxCount: null;
      syncedAt: null;
    }
  | {
      state: 'no-data';
      inboxCount: null;
      syncedAt: null;
    }
  | {
      state: 'ready';
      inboxCount: number;
      syncedAt: string;
    }
);

export interface WidgetSnapshotAdapter {
  updateSnapshot(snapshot: FolioWidgetSnapshot): Promise<void>;
  clearSnapshot(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createWidgetLabels(): FolioWidgetLabels {
  return {
    locked: translateRuntime('widget.locked'),
    inbox: translateRuntime('widget.inbox'),
    openScan: translateRuntime('widget.openScan'),
    inboxItem: translateRuntime('widget.inboxItem'),
    inboxItems: translateRuntime('widget.inboxItems'),
  };
}

function parseWidgetLabels(value: unknown): FolioWidgetLabels | null {
  if (!isRecord(value)) return null;
  const keys = ['locked', 'inbox', 'openScan', 'inboxItem', 'inboxItems'] as const;
  if (Object.keys(value).length !== keys.length || keys.some((key) => {
    const label = value[key];
    return typeof label !== 'string'
      || !label.trim()
      || label.length > 80
      || /[\u0000-\u001F\u007F]/.test(label);
  })) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as FolioWidgetLabels;
}

function assertBounded(snapshot: FolioWidgetSnapshot): FolioWidgetSnapshot {
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_WIDGET_SNAPSHOT_BYTES) {
    throw new Error('Widget snapshot exceeds the shared-cache privacy limit.');
  }
  return snapshot;
}

export function createWidgetSnapshot(input: {
  authenticated: boolean;
  unlocked: boolean;
  inboxCount: number | null;
  syncedAt: string | null;
}): FolioWidgetSnapshot {
  const labels = createWidgetLabels();
  if (!input.authenticated || !input.unlocked) {
    return assertBounded({
      schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
      state: 'locked',
      inboxCount: null,
      syncedAt: null,
      quickScanRoute: WIDGET_QUICK_SCAN_ROUTE,
      labels,
    });
  }
  if (
    input.inboxCount === null ||
    input.syncedAt === null ||
    !Number.isFinite(Date.parse(input.syncedAt))
  ) {
    return assertBounded({
      schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
      state: 'no-data',
      inboxCount: null,
      syncedAt: null,
      quickScanRoute: WIDGET_QUICK_SCAN_ROUTE,
      labels,
    });
  }
  if (!Number.isSafeInteger(input.inboxCount) || input.inboxCount < 0) {
    throw new Error('Widget inbox count is invalid.');
  }
  return assertBounded({
    schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
    state: 'ready',
    inboxCount: Math.min(input.inboxCount, 999),
    syncedAt: input.syncedAt,
    quickScanRoute: WIDGET_QUICK_SCAN_ROUTE,
    labels,
  });
}

export function parseWidgetSnapshot(value: unknown): FolioWidgetSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== WIDGET_SNAPSHOT_SCHEMA_VERSION) return null;
  const allowed = new Set([
    'schemaVersion',
    'state',
    'inboxCount',
    'syncedAt',
    'quickScanRoute',
    'labels',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (value.quickScanRoute !== WIDGET_QUICK_SCAN_ROUTE) return null;
  const labels = value.labels === undefined ? createWidgetLabels() : parseWidgetLabels(value.labels);
  if (!labels) return null;

  if (value.state === 'locked' || value.state === 'no-data') {
    if (value.inboxCount !== null || value.syncedAt !== null) return null;
    return assertBounded({
      schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
      state: value.state,
      inboxCount: null,
      syncedAt: null,
      quickScanRoute: WIDGET_QUICK_SCAN_ROUTE,
      labels,
    });
  }
  if (
    value.state !== 'ready' ||
    !Number.isSafeInteger(value.inboxCount) ||
    (value.inboxCount as number) < 0 ||
    (value.inboxCount as number) > 999 ||
    typeof value.syncedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.syncedAt))
  ) {
    return null;
  }
  return assertBounded({
    schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
    state: 'ready',
    inboxCount: value.inboxCount as number,
    syncedAt: value.syncedAt,
    quickScanRoute: WIDGET_QUICK_SCAN_ROUTE,
    labels,
  });
}

export async function lockWidget(adapter: WidgetSnapshotAdapter): Promise<void> {
  await adapter.updateSnapshot(
    createWidgetSnapshot({ authenticated: false, unlocked: false, inboxCount: null, syncedAt: null }),
  );
}

export async function clearWidgetAfterProfileRemoval(
  adapter: WidgetSnapshotAdapter,
): Promise<void> {
  await adapter.clearSnapshot();
  await lockWidget(adapter);
}
