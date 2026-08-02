import type { PaperlessOption } from '../types/document.ts';

export type VisibleTagRecord = {
  id: number;
  name: string;
  color?: string;
  parent?: number | null;
  children?: number[];
  is_inbox_tag?: boolean;
};

type ResolvedPath = {
  depth: number;
  pathLabel: string;
  valid: boolean;
};

function isPositiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * Enrich only the unique tag records returned to this user. Parent and child
 * edges are rebuilt from that permission-filtered set: raw recursive `children`
 * values are never copied because they can still contain inaccessible IDs.
 * Missing/private parents become a new visible root, while cycles and anything
 * below a cycle are flattened to prevent stale or malformed paths from leaking.
 */
export function buildVisibleTagOptions(items: VisibleTagRecord[]): PaperlessOption[] {
  const visible = new Map<number, VisibleTagRecord>();
  for (const item of items) {
    if (!isPositiveId(item.id) || typeof item.name !== 'string' || visible.has(item.id)) continue;
    visible.set(item.id, item);
  }

  const parentById = new Map<number, number | null>();
  for (const item of visible.values()) {
    const parentId = item.parent;
    parentById.set(
      item.id,
      isPositiveId(parentId) && visible.has(parentId) ? parentId : null,
    );
  }

  const paths = new Map<number, ResolvedPath>();
  const resolvePath = (startId: number): ResolvedPath => {
    const cached = paths.get(startId);
    if (cached) return cached;

    const chain: number[] = [];
    const positions = new Set<number>();
    let cursor: number | null = startId;
    let base: ResolvedPath | null = null;

    while (cursor !== null) {
      const resolved = paths.get(cursor);
      if (resolved) {
        base = resolved;
        break;
      }
      if (positions.has(cursor)) {
        base = { pathLabel: '', depth: 0, valid: false };
        break;
      }
      positions.add(cursor);
      chain.push(cursor);
      cursor = parentById.get(cursor) ?? null;
    }

    if (base?.valid === false) {
      for (const id of chain) {
        const item = visible.get(id)!;
        paths.set(id, { pathLabel: item.name, depth: 0, valid: false });
      }
      return paths.get(startId)!;
    }

    let pathLabel = base?.pathLabel ?? '';
    let depth = base?.depth ?? -1;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const id = chain[index];
      const item = visible.get(id)!;
      pathLabel = pathLabel ? `${pathLabel} / ${item.name}` : item.name;
      depth += 1;
      paths.set(id, { pathLabel, depth, valid: true });
    }
    return paths.get(startId)!;
  };

  for (const id of visible.keys()) resolvePath(id);

  const childrenById = new Map<number, number[]>();
  for (const [id, parentId] of parentById) {
    if (parentId === null || !paths.get(id)?.valid) continue;
    childrenById.set(parentId, [...(childrenById.get(parentId) ?? []), id]);
  }

  return [...visible.values()].map((item) => {
    const path = paths.get(item.id)!;
    const parentId = parentById.get(item.id);
    return {
      id: `remote-tag-${item.id}`,
      remoteId: item.id,
      name: item.name,
      color: item.color,
      pathLabel: path.pathLabel,
      depth: path.depth,
      ...(path.valid && parentId !== null ? { parentRemoteId: parentId } : {}),
      childRemoteIds: path.valid ? childrenById.get(item.id) ?? [] : [],
      isInboxTag: item.is_inbox_tag === true,
    };
  });
}

/**
 * Return the tag rows a filter should render. Search intentionally ignores
 * disclosure state and matches both the visible name and the privacy-safe path.
 */
export function selectTagFilterOptions<T extends PaperlessOption>(
  options: T[],
  query: string,
  expandedRemoteIds: ReadonlySet<number>,
): T[] {
  const ordered = [...options].sort((left, right) => (
    (left.pathLabel || left.name).localeCompare(right.pathLabel || right.name)
  ));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery) {
    return ordered.filter((option) => (
      option.name.toLocaleLowerCase().includes(normalizedQuery)
      || option.pathLabel?.toLocaleLowerCase().includes(normalizedQuery)
    ));
  }

  const byRemoteId = new Map(ordered.flatMap((option) => (
    isPositiveId(option.remoteId) ? [[option.remoteId, option] as const] : []
  )));
  return ordered.filter((option) => {
    let parentId = option.parentRemoteId;
    const visited = new Set<number>();
    while (isPositiveId(parentId) && byRemoteId.has(parentId)) {
      if (visited.has(parentId) || !expandedRemoteIds.has(parentId)) return false;
      visited.add(parentId);
      parentId = byRemoteId.get(parentId)?.parentRemoteId;
    }
    return true;
  });
}

/** Expand only the visible ancestor chain needed to reveal an existing selection. */
export function selectedTagAncestorIds(
  options: PaperlessOption[],
  selectedIds: readonly string[],
): Set<number> {
  const selected = new Set(selectedIds);
  const byRemoteId = new Map(options.flatMap((option) => (
    isPositiveId(option.remoteId) ? [[option.remoteId, option] as const] : []
  )));
  const expanded = new Set<number>();

  for (const option of options) {
    if (!selected.has(option.id)) continue;
    let parentId = option.parentRemoteId;
    const visited = new Set<number>();
    while (isPositiveId(parentId) && byRemoteId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      expanded.add(parentId);
      parentId = byRemoteId.get(parentId)?.parentRemoteId;
    }
  }
  return expanded;
}
