import { Sha256 } from './sha256.ts';

export interface PhysicalStringStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export interface StringStoreExclusiveCoordinator {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export const SECURE_STORE_PHYSICAL_VALUE_MAX_BYTES = 1_536;
export const SECURE_STORE_CHUNK_VALUE_MAX_BYTES = 1_400;
export const SECURE_STORE_LOGICAL_VALUE_MAX_BYTES = 256 * 1_024;
export const SECURE_STORE_LOGICAL_KEY_MAX_LENGTH = 240;
export const SECURE_STORE_MAX_CHUNKS = Math.ceil(
  SECURE_STORE_LOGICAL_VALUE_MAX_BYTES / SECURE_STORE_CHUNK_VALUE_MAX_BYTES,
);

const FORMAT_VERSION = 1 as const;
const INTERNAL_KEY_PREFIX = '__folio_ss_v1.';

type Generation = 'a' | 'b';

type PublishedPointer = {
  v: typeof FORMAT_VERSION;
  s: 'p';
  g: Generation;
  h: string;
};

type DeletedPointer = {
  v: typeof FORMAT_VERSION;
  s: 'd';
  a: number;
  b: number;
};

type Pointer = PublishedPointer | DeletedPointer;

type GenerationManifest = {
  v: typeof FORMAT_VERSION;
  s: 'w' | 'r';
  g: Generation;
  n: number;
  b: number;
  h: string;
};

class PrePublicationWriteError extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super('Protected-storage publication failed before its pointer changed.');
    this.name = 'PrePublicationWriteError';
    this.original = original;
  }
}

// This queue is deliberately shared by every adapter instance in the JavaScript
// runtime. Native production additionally takes a process-wide lease so a
// foreground and headless runtime cannot mutate the same physical namespace at
// the same time.
const mutationQueues = new Map<string, Promise<void>>();

export class SizeSafeStringStoreError extends Error {
  readonly code: 'invalid-key' | 'value-too-large' | 'corrupt-record';

  constructor(
    code: SizeSafeStringStoreError['code'],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SizeSafeStringStoreError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isGeneration(value: unknown): value is Generation {
  return value === 'a' || value === 'b';
}

function utf8CodePointSize(codePoint: number) {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** UTF-8 encoding with the same replacement behavior as TextEncoder. */
export function encodeSizeSafeStoreUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let offset = 0; offset < value.length; offset += 1) {
    const first = value.charCodeAt(offset);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(offset + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        offset += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export function sizeSafeStoreUtf8Length(value: string) {
  let bytes = 0;
  for (let offset = 0; offset < value.length; offset += 1) {
    const first = value.charCodeAt(offset);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(offset + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        offset += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      codePoint = 0xfffd;
    }
    bytes += utf8CodePointSize(codePoint);
  }
  return bytes;
}

function sha256Utf8(value: string) {
  return new Sha256().update(encodeSizeSafeStoreUtf8(value)).digestHex();
}

function validateLogicalKey(key: string) {
  if (
    typeof key !== 'string'
    || key.length < 1
    || key.length > SECURE_STORE_LOGICAL_KEY_MAX_LENGTH
    || !/^[A-Za-z0-9._-]+$/.test(key)
    || key.startsWith(INTERNAL_KEY_PREFIX)
  ) {
    throw new SizeSafeStringStoreError(
      'invalid-key',
      'Protected-storage keys must use only letters, numbers, dots, hyphens, and underscores.',
    );
  }
}

function internalRoot(key: string) {
  validateLogicalKey(key);
  return `${INTERNAL_KEY_PREFIX}${sha256Utf8(key)}`;
}

export function sizeSafeStorePhysicalKeys(key: string) {
  const root = internalRoot(key);
  return {
    pointer: `${root}.p`,
    manifest(generation: Generation) {
      return `${root}.${generation}.m`;
    },
    chunk(generation: Generation, index: number) {
      return `${root}.${generation}.c.${index.toString(36)}`;
    },
  };
}

function parsePointer(raw: string): Pointer {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new SizeSafeStringStoreError(
      'corrupt-record',
      'The protected-storage publication pointer is corrupted.',
      { cause },
    );
  }
  if (!isRecord(value) || value.v !== FORMAT_VERSION) {
    throw new SizeSafeStringStoreError(
      'corrupt-record',
      'The protected-storage publication pointer is invalid.',
    );
  }
  if (
    value.s === 'p'
    && hasOnlyKeys(value, ['v', 's', 'g', 'h'])
    && isGeneration(value.g)
    && isDigest(value.h)
  ) {
    return { v: FORMAT_VERSION, s: 'p', g: value.g, h: value.h };
  }
  if (
    value.s === 'd'
    && hasOnlyKeys(value, ['v', 's', 'a', 'b'])
    && Number.isSafeInteger(value.a)
    && Number.isSafeInteger(value.b)
    && (value.a as number) >= 0
    && (value.b as number) >= 0
    && (value.a as number) <= SECURE_STORE_MAX_CHUNKS
    && (value.b as number) <= SECURE_STORE_MAX_CHUNKS
  ) {
    return {
      v: FORMAT_VERSION,
      s: 'd',
      a: value.a as number,
      b: value.b as number,
    };
  }
  throw new SizeSafeStringStoreError(
    'corrupt-record',
    'The protected-storage publication pointer is invalid.',
  );
}

function parseManifest(raw: string, expectedGeneration: Generation): GenerationManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new SizeSafeStringStoreError(
      'corrupt-record',
      'A protected-storage generation manifest is corrupted.',
      { cause },
    );
  }
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['v', 's', 'g', 'n', 'b', 'h'])
    || value.v !== FORMAT_VERSION
    || (value.s !== 'w' && value.s !== 'r')
    || value.g !== expectedGeneration
    || !Number.isSafeInteger(value.n)
    || (value.n as number) < 1
    || (value.n as number) > SECURE_STORE_MAX_CHUNKS
    || !Number.isSafeInteger(value.b)
    || (value.b as number) <= SECURE_STORE_CHUNK_VALUE_MAX_BYTES
    || (value.b as number) > SECURE_STORE_LOGICAL_VALUE_MAX_BYTES
    || !isDigest(value.h)
  ) {
    throw new SizeSafeStringStoreError(
      'corrupt-record',
      'A protected-storage generation manifest is invalid.',
    );
  }
  return {
    v: FORMAT_VERSION,
    s: value.s,
    g: expectedGeneration,
    n: value.n as number,
    b: value.b as number,
    h: value.h,
  };
}

function splitUtf8Chunks(value: string) {
  const chunks: string[] = [];
  let start = 0;
  let chunkBytes = 0;
  for (let offset = 0; offset < value.length;) {
    const first = value.charCodeAt(offset);
    let width = 1;
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(offset + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        width = 2;
        codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
      } else {
        codePoint = 0xfffd;
      }
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      codePoint = 0xfffd;
    }
    const codePointBytes = utf8CodePointSize(codePoint);
    if (chunkBytes > 0 && chunkBytes + codePointBytes > SECURE_STORE_CHUNK_VALUE_MAX_BYTES) {
      chunks.push(value.slice(start, offset));
      start = offset;
      chunkBytes = 0;
    }
    chunkBytes += codePointBytes;
    offset += width;
  }
  if (start < value.length) chunks.push(value.slice(start));
  return chunks;
}

function otherGeneration(generation: Generation): Generation {
  return generation === 'a' ? 'b' : 'a';
}

/**
 * A crash-consistent logical string store for small native key/value stores.
 * The backend is intentionally structural so the publication protocol can be
 * tested without importing a native module.
 */
export class SizeSafeStringStore implements PhysicalStringStore {
  private readonly backend: PhysicalStringStore;
  private readonly exclusiveCoordinator?: StringStoreExclusiveCoordinator;

  constructor(
    backend: PhysicalStringStore,
    exclusiveCoordinator?: StringStoreExclusiveCoordinator,
  ) {
    this.backend = backend;
    this.exclusiveCoordinator = exclusiveCoordinator;
  }

  private async writePhysical(key: string, value: string) {
    if (sizeSafeStoreUtf8Length(value) > SECURE_STORE_PHYSICAL_VALUE_MAX_BYTES) {
      throw new SizeSafeStringStoreError(
        'value-too-large',
        'An internal protected-storage value exceeds the physical safety limit.',
      );
    }
    await this.backend.setItem(key, value);
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = mutationQueues.get(key) ?? Promise.resolve();
    const coordinated = () => this.exclusiveCoordinator?.runExclusive(operation) ?? operation();
    const result = previous.then(coordinated, coordinated);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    mutationQueues.set(key, tail);
    void tail.then(() => {
      if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
    });
    return result;
  }

  private async readPointer(key: string) {
    const raw = await this.backend.getItem(sizeSafeStorePhysicalKeys(key).pointer);
    return { raw, value: raw === null ? null : parsePointer(raw) };
  }

  private async cleanupCount(key: string, generation: Generation) {
    const keys = sizeSafeStorePhysicalKeys(key);
    const raw = await this.backend.getItem(keys.manifest(generation));
    if (raw === null) return 0;
    try {
      return parseManifest(raw, generation).n;
    } catch {
      // A malformed manifest cannot be trusted to enumerate its fragments. The
      // namespace is finite, so deletion can safely sweep every possible index.
      return SECURE_STORE_MAX_CHUNKS;
    }
  }

  private async cleanupGeneration(
    key: string,
    generation: Generation,
    knownCount?: number,
  ) {
    const keys = sizeSafeStorePhysicalKeys(key);
    const count = knownCount ?? await this.cleanupCount(key, generation);
    for (let index = 0; index < count; index += 1) {
      await this.backend.deleteItem(keys.chunk(generation, index));
    }
    // The manifest is deliberately last: it remains a retry map if deleting a
    // chunk is interrupted.
    await this.backend.deleteItem(keys.manifest(generation));
  }

  private async bestEffortCleanupGeneration(key: string, generation: Generation) {
    try {
      await this.cleanupGeneration(key, generation);
    } catch {
      // Publication has already committed. A later read, write, or delete will
      // deterministically retry this inactive generation.
    }
  }

  private async finishDeletion(key: string) {
    await this.backend.deleteItem(key);
    // Counts in manifests and interrupted tombstones are recovery hints, not a
    // deletion authority. Explicit deletion always sweeps the complete bounded
    // namespace so valid-looking corrupt metadata cannot hide secret fragments.
    await this.cleanupGeneration(key, 'a', SECURE_STORE_MAX_CHUNKS);
    await this.cleanupGeneration(key, 'b', SECURE_STORE_MAX_CHUNKS);
    await this.backend.deleteItem(sizeSafeStorePhysicalKeys(key).pointer);
  }

  private async readPublished(key: string, pointer: PublishedPointer) {
    const keys = sizeSafeStorePhysicalKeys(key);
    const rawManifest = await this.backend.getItem(keys.manifest(pointer.g));
    if (rawManifest === null) {
      throw new SizeSafeStringStoreError(
        'corrupt-record',
        'The published protected-storage generation is missing its manifest.',
      );
    }
    const manifest = parseManifest(rawManifest, pointer.g);
    if (manifest.s !== 'r' || manifest.h !== pointer.h) {
      throw new SizeSafeStringStoreError(
        'corrupt-record',
        'The published protected-storage generation does not match its pointer.',
      );
    }

    const chunks: string[] = [];
    let observedBytes = 0;
    for (let index = 0; index < manifest.n; index += 1) {
      const chunk = await this.backend.getItem(keys.chunk(pointer.g, index));
      if (chunk === null) {
        throw new SizeSafeStringStoreError(
          'corrupt-record',
          'A published protected-storage chunk is missing.',
        );
      }
      const chunkBytes = sizeSafeStoreUtf8Length(chunk);
      if (
        chunkBytes < 1
        || chunkBytes > SECURE_STORE_CHUNK_VALUE_MAX_BYTES
        || observedBytes + chunkBytes > SECURE_STORE_LOGICAL_VALUE_MAX_BYTES
      ) {
        throw new SizeSafeStringStoreError(
          'corrupt-record',
          'A published protected-storage chunk has an invalid size.',
        );
      }
      observedBytes += chunkBytes;
      chunks.push(chunk);
    }
    const value = chunks.join('');
    if (
      observedBytes !== manifest.b
      || sizeSafeStoreUtf8Length(value) !== manifest.b
      || sha256Utf8(value) !== manifest.h
    ) {
      throw new SizeSafeStringStoreError(
        'corrupt-record',
        'The published protected-storage value failed its integrity check.',
      );
    }
    return value;
  }

  private async getItemDirect(key: string): Promise<string | null> {
    const pointer = await this.readPointer(key);
    if (pointer.value?.s === 'd') {
      try {
        await this.finishDeletion(key);
      } catch {
        // A deletion tombstone is authoritative even while physical cleanup is
        // waiting for a later retry.
      }
      return null;
    }
    if (pointer.value?.s === 'p') {
      const value = await this.readPublished(key, pointer.value);
      try {
        await this.backend.deleteItem(key);
      } catch {
        // The published pointer remains authoritative over a legacy raw copy.
      }
      await this.bestEffortCleanupGeneration(key, otherGeneration(pointer.value.g));
      return value;
    }

    const raw = await this.backend.getItem(key);
    if (raw === null) {
      await this.bestEffortCleanupGeneration(key, 'a');
      await this.bestEffortCleanupGeneration(key, 'b');
      return null;
    }
    const byteLength = sizeSafeStoreUtf8Length(raw);
    if (byteLength > SECURE_STORE_LOGICAL_VALUE_MAX_BYTES) {
      throw new SizeSafeStringStoreError(
        'value-too-large',
        'The legacy protected-storage value exceeds the logical safety limit.',
      );
    }
    if (byteLength > SECURE_STORE_CHUNK_VALUE_MAX_BYTES) {
      // Older app versions wrote the complete string directly. Migration uses
      // the same pointer-last path, so a failed migration leaves the raw value.
      try {
        await this.publishLargeValue(key, raw, byteLength);
      } catch (error) {
        if (!(error instanceof PrePublicationWriteError)) throw error;
        // A migration is maintenance, not read authority. Fall back only after
        // proving that publication never changed the pointer and the exact raw
        // value is still readable. Ambiguous publication continues to fail
        // closed in publishLargeValue.
        const preservedRaw = await this.backend.getItem(key);
        if (preservedRaw !== raw) {
          throw new SizeSafeStringStoreError(
            'corrupt-record',
            'The legacy protected-storage value changed during migration.',
            { cause: error.original },
          );
        }
        return raw;
      }
    } else {
      await this.bestEffortCleanupGeneration(key, 'a');
      await this.bestEffortCleanupGeneration(key, 'b');
    }
    return raw;
  }

  async getItem(key: string): Promise<string | null> {
    validateLogicalKey(key);
    return this.enqueue(key, () => this.getItemDirect(key));
  }

  private async publishLargeValue(key: string, value: string, byteLength: number) {
    const keys = sizeSafeStorePhysicalKeys(key);
    let current = await this.readPointer(key);
    if (current.value?.s === 'd') {
      await this.finishDeletion(key);
      current = { raw: null, value: null };
    }
    const active = current.value?.s === 'p' ? current.value.g : null;
    const generation: Generation = active === null ? 'a' : otherGeneration(active);
    const chunks = splitUtf8Chunks(value);
    if (chunks.length < 1 || chunks.length > SECURE_STORE_MAX_CHUNKS) {
      throw new SizeSafeStringStoreError(
        'value-too-large',
        'The protected-storage value requires too many chunks.',
      );
    }
    const digest = sha256Utf8(value);
    const staging: GenerationManifest = {
      v: FORMAT_VERSION,
      s: 'w',
      g: generation,
      n: chunks.length,
      b: byteLength,
      h: digest,
    };
    const ready: GenerationManifest = { ...staging, s: 'r' };
    const nextPointer: PublishedPointer = {
      v: FORMAT_VERSION,
      s: 'p',
      g: generation,
      h: digest,
    };
    const nextPointerRaw = JSON.stringify(nextPointer);
    let pointerAttempted = false;
    let committed = false;
    let failure: unknown;

    try {
      await this.cleanupGeneration(key, generation);
      await this.writePhysical(keys.manifest(generation), JSON.stringify(staging));
      for (let index = 0; index < chunks.length; index += 1) {
        await this.writePhysical(keys.chunk(generation, index), chunks[index]);
      }
      await this.writePhysical(keys.manifest(generation), JSON.stringify(ready));
      pointerAttempted = true;
      await this.writePhysical(keys.pointer, nextPointerRaw);
      committed = true;
    } catch (cause) {
      failure = cause;
      if (pointerAttempted) {
        try {
          const observed = await this.backend.getItem(keys.pointer);
          committed = observed === nextPointerRaw;
          if (!committed && observed !== current.raw) {
            // The pointer authority is no longer the generation observed at the
            // start of this mutation, so deleting either slot would be unsafe.
            throw new SizeSafeStringStoreError(
              'corrupt-record',
              'Protected storage changed concurrently during publication.',
              { cause },
            );
          }
        } catch (observationFailure) {
          if (observationFailure instanceof SizeSafeStringStoreError) throw observationFailure;
          throw new SizeSafeStringStoreError(
            'corrupt-record',
            'The protected-storage publication result could not be determined.',
            { cause: observationFailure },
          );
        }
      }
      if (!committed) {
        try {
          await this.cleanupGeneration(key, generation);
        } catch {
          // The staging manifest remains the bounded retry map.
        }
        throw new PrePublicationWriteError(failure);
      }
    }

    // The logical write has committed. Cleanup failures must not make callers
    // roll back a value that is already authoritative.
    if (active !== null) await this.bestEffortCleanupGeneration(key, active);
    try {
      await this.backend.deleteItem(key);
    } catch {
      // A raw legacy copy is ignored while the pointer exists and is retried by
      // reads and deletion.
    }
  }

  private async publishRawValue(key: string, value: string) {
    let current = await this.readPointer(key);
    if (current.value?.s === 'd') {
      await this.finishDeletion(key);
      current = { raw: null, value: null };
    }
    await this.writePhysical(key, value);
    if (current.value?.s === 'p') {
      try {
        await this.backend.deleteItem(sizeSafeStorePhysicalKeys(key).pointer);
      } catch (cause) {
        const observed = await this.backend.getItem(sizeSafeStorePhysicalKeys(key).pointer);
        if (observed !== null) throw cause;
      }
    }
    await this.bestEffortCleanupGeneration(key, 'a');
    await this.bestEffortCleanupGeneration(key, 'b');
  }

  async setItem(key: string, value: string): Promise<void> {
    validateLogicalKey(key);
    if (typeof value !== 'string') {
      throw new TypeError('Protected-storage values must be strings.');
    }
    const byteLength = sizeSafeStoreUtf8Length(value);
    if (byteLength > SECURE_STORE_LOGICAL_VALUE_MAX_BYTES) {
      throw new SizeSafeStringStoreError(
        'value-too-large',
        'The protected-storage value exceeds the logical safety limit.',
      );
    }
    return this.enqueue(key, async () => {
      if (byteLength <= SECURE_STORE_CHUNK_VALUE_MAX_BYTES) {
        await this.publishRawValue(key, value);
      } else {
        try {
          await this.publishLargeValue(key, value, byteLength);
        } catch (error) {
          if (error instanceof PrePublicationWriteError) throw error.original;
          throw error;
        }
      }
    });
  }

  async deleteItem(key: string): Promise<void> {
    validateLogicalKey(key);
    return this.enqueue(key, async () => {
      const keys = sizeSafeStorePhysicalKeys(key);
      const currentRaw = await this.backend.getItem(keys.pointer);
      const tombstone: DeletedPointer = {
        v: FORMAT_VERSION,
        s: 'd',
        a: SECURE_STORE_MAX_CHUNKS,
        b: SECURE_STORE_MAX_CHUNKS,
      };
      const tombstoneRaw = JSON.stringify(tombstone);
      if (currentRaw !== tombstoneRaw) {
        try {
          await this.writePhysical(keys.pointer, tombstoneRaw);
        } catch (cause) {
          const observed = await this.backend.getItem(keys.pointer);
          if (observed !== tombstoneRaw) throw cause;
        }
      }
      await this.finishDeletion(key);
    });
  }
}
