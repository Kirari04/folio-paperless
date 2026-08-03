import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const expoSqliteNodeAdapter = `
  import { DatabaseSync } from 'node:sqlite';

  class SQLiteDatabase {
    constructor(name) {
      this.database = new DatabaseSync(name);
    }

    async execAsync(sql) {
      this.database.exec(sql);
    }

    async runAsync(sql, ...parameters) {
      const result = this.database.prepare(sql).run(...parameters);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowid };
    }

    async getFirstAsync(sql, ...parameters) {
      return this.database.prepare(sql).get(...parameters) ?? null;
    }

    async getAllAsync(sql, ...parameters) {
      return this.database.prepare(sql).all(...parameters);
    }

    async withExclusiveTransactionAsync(operation) {
      this.database.exec('BEGIN EXCLUSIVE');
      try {
        const result = await operation(this);
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }

    async closeAsync() {
      this.database.close();
    }
  }

  export async function openDatabaseAsync(name) {
    return new SQLiteDatabase(name);
  }
`;
const expoSqliteNodeAdapterUrl = `data:text/javascript;base64,${Buffer.from(expoSqliteNodeAdapter).toString('base64')}`;
const sqliteRepositoryUrl = new URL('../src/lib/sqlite-repository.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-sqlite') {
      return { shortCircuit: true, url: expoSqliteNodeAdapterUrl };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        context.parentURL?.endsWith('.ts')
        && (specifier.startsWith('./') || specifier.startsWith('../'))
        && !specifier.endsWith('.ts')
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url !== sqliteRepositoryUrl) return nextLoad(url, context);
    return {
      format: 'module-typescript',
      shortCircuit: true,
      source: readFileSync(new URL(url), 'utf8').replace(
        "constructor(private readonly databaseName = 'folio.db') {}",
        "constructor(databaseName = 'folio.db') { this.databaseName = databaseName; }",
      ),
    };
  },
});

const { SQLiteFolioRepository } = await import('../src/lib/sqlite-repository.ts');

const option = (resource, remoteId, name) => ({
  id: `remote-${resource}-${remoteId}`,
  remoteId,
  name,
});

async function closeRepository(repository) {
  const databasePromise = repository.databasePromise;
  if (databasePromise) await (await databasePromise).closeAsync();
}

test('SQLite close/reopen preserves complete upload metadata and its profile-scoped preset', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-upload-restart-'));
  const databasePath = join(directory, 'folio.db');
  let repository;

  const metadata = {
    title: { state: 'value', value: 'Receipt 2026-08-02' },
    created: { state: 'value', value: '2026-08-02' },
    correspondent: { state: 'value', value: option('correspondent', 11, 'Corner shop') },
    documentType: { state: 'value', value: option('document-type', 12, 'Receipt') },
    tags: {
      state: 'value',
      value: [option('tag', 13, 'Tax'), option('tag', 14, 'Paid')],
    },
    storagePath: { state: 'value', value: option('storage-path', 15, 'Finance') },
    archiveSerialNumber: { state: 'value', value: 1042 },
    owner: { state: 'value', value: option('owner', 16, 'Bookkeeper') },
    workflow: { state: 'value', value: option('workflow', 17, 'Receipt intake') },
    customFields: [
      {
        fieldId: 'notes', fieldRemoteId: 21, dataType: 'longtext',
        value: { state: 'value', value: 'Paid at the counter' },
      },
      {
        fieldId: 'amount', fieldRemoteId: 22, dataType: 'monetary', defaultCurrency: 'CHF',
        value: { state: 'value', value: 'CHF-12.30' },
      },
      {
        fieldId: 'service-date', fieldRemoteId: 23, dataType: 'date',
        value: { state: 'value', value: '2026-08-01' },
      },
      {
        fieldId: 'reviewed', fieldRemoteId: 24, dataType: 'boolean',
        value: { state: 'value', value: false },
      },
      {
        fieldId: 'category', fieldRemoteId: 25, dataType: 'select', selectOptionIds: ['', 'travel'],
        value: { state: 'value', value: '' },
      },
      {
        fieldId: 'related', fieldRemoteId: 26, dataType: 'documentlink',
        value: { state: 'value', value: [42, 84] },
      },
    ],
  };
  const timestamps = {
    createdAt: '2026-08-02T10:00:00.000Z',
    updatedAt: '2026-08-02T10:01:00.000Z',
  };
  const preset = {
    schemaVersion: 1,
    id: 'receipts',
    profileId: 'profile-a',
    name: 'Receipts',
    icon: 'receipt',
    color: '#0d74ce',
    createdDateBehavior: 'last-used',
    metadata,
    filenameTitle: 'original',
    autoSubmit: true,
    defaultFor: ['camera', 'picker', 'share'],
    ...timestamps,
  };
  const otherProfilePreset = {
    ...preset,
    profileId: 'profile-b',
    name: 'Other server receipts',
  };
  const task = {
    schemaVersion: 4,
    id: 'upload-1',
    profileId: 'profile-a',
    batchId: 'batch-1',
    kind: 'upload',
    stage: 'queued',
    source: 'picker',
    originalName: 'receipt.final.pdf',
    stagedName: 'upload-1.pdf',
    localUri: 'file:///private/profile-a/upload-1.pdf',
    byteSize: 12345,
    mimeType: 'application/pdf',
    metadata,
    presetId: preset.id,
    progress: 0,
    retryCount: 0,
    ...timestamps,
  };

  try {
    repository = new SQLiteFolioRepository(databasePath);
    await repository.initialize();
    await repository.writePreset(preset);
    await repository.writePreset(otherProfilePreset);
    await repository.writeTask(task);
    await closeRepository(repository);
    repository = undefined;

    repository = new SQLiteFolioRepository(databasePath);
    await repository.initialize();

    const restoredTask = await repository.readTask('profile-a', task.id);
    const restoredPresets = await repository.listPresets('profile-a');
    assert.deepEqual(restoredTask, task);
    assert.deepEqual(restoredPresets, [preset]);
    assert.deepEqual(await repository.listPresets('profile-b'), [otherProfilePreset]);

    const restoredSelectedPreset = restoredPresets.find(
      (candidate) => candidate.id === restoredTask.presetId,
    );
    assert.equal(restoredSelectedPreset?.profileId, restoredTask.profileId);
    assert.deepEqual(restoredSelectedPreset?.metadata, restoredTask.metadata);
  } finally {
    if (repository) await closeRepository(repository);
    rmSync(directory, { recursive: true, force: true });
  }
});
