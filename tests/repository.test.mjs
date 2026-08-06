import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FOLIO_DATABASE_MIGRATIONS,
  FOLIO_DATABASE_VERSION,
  migrationsAfter,
} from '../src/lib/database-schema.ts';
import { MemoryFolioRepository } from '../src/lib/memory-repository.ts';

test('database migrations are ordered, reversible by retaining earlier schema, and complete', () => {
  assert.deepEqual(migrationsAfter(0).map((migration) => migration.version), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(migrationsAfter(2).map((migration) => migration.version), [3, 4, 5, 6, 7]);
  assert.deepEqual(migrationsAfter(3).map((migration) => migration.version), [4, 5, 6, 7]);
  assert.deepEqual(migrationsAfter(FOLIO_DATABASE_VERSION), []);
  const metadataMigration = migrationsAfter(3)[0];
  assert.match(metadataMigration.sql, /CREATE INDEX IF NOT EXISTS persistent_metadata_tasks_due/);
  assert.match(metadataMigration.sql, /profile_id, kind, stage, next_attempt_at, updated_at/);
  assert.doesNotMatch(metadataMigration.sql, /DROP|DELETE|ALTER TABLE/i);
  const offlineMigration = migrationsAfter(4)[0];
  assert.match(offlineMigration.sql, /ADD COLUMN file_name TEXT/);
  assert.match(offlineMigration.sql, /ADD COLUMN mime_type TEXT/);
  assert.match(offlineMigration.sql, /CREATE TABLE IF NOT EXISTS task_notification_outbox/);
  assert.doesNotMatch(offlineMigration.sql, /DROP|DELETE/i);
  const removalMigration = migrationsAfter(5)[0];
  assert.match(removalMigration.sql, /CREATE TABLE IF NOT EXISTS profile_removal_tombstones/);
  assert.match(removalMigration.sql, /CREATE UNIQUE INDEX IF NOT EXISTS profile_removal_tombstones_profile/);
  assert.doesNotMatch(removalMigration.sql, /DROP|DELETE|ALTER TABLE/i);
  const manifestMigration = migrationsAfter(6)[0];
  assert.match(manifestMigration.sql, /CREATE TABLE IF NOT EXISTS profile_removal_manifests/);
  assert.match(manifestMigration.sql, /BEFORE DELETE ON profile_removal_tombstones/);
  assert.match(manifestMigration.sql, /BEFORE INSERT ON persistent_tasks/);
  assert.match(manifestMigration.sql, /BEFORE INSERT ON workspaces/);
  assert.doesNotMatch(manifestMigration.sql, /DROP|ALTER TABLE/i);
  assert.throws(() => migrationsAfter(99), /Unsupported Folio database version/);
});

test('v7 makes a minimal tombstone permanent and fences every profile-scoped table', () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-v7-removal-fence-'));
  const database = join(directory, 'folio.db');
  try {
    const throughV6 = FOLIO_DATABASE_MIGRATIONS
      .filter((migration) => migration.version <= 6)
      .map((migration) => migration.sql)
      .join('\n');
    execFileSync('sqlite3', [database], {
      input: `BEGIN;\n${throughV6}\nCOMMIT;`,
    });
    execFileSync('sqlite3', [database], {
      input: "INSERT INTO profile_removal_tombstones (operation_id, profile_id, created_at, payload_json) VALUES ('remove-1', 'profile-a', '2026-08-02', '{\"legacy\":\"large recovery payload\"}');\n"
        + "INSERT INTO persistent_tasks VALUES ('profile-a', 'stale-v6-task', 'sync', 'queued', NULL, NULL, NULL, '2026-08-02', '{}');",
    });
    const v7 = FOLIO_DATABASE_MIGRATIONS.find((migration) => migration.version === 7);
    execFileSync('sqlite3', [database], {
      input: `BEGIN;\n${v7.sql}\nCOMMIT;`,
    });
    const staleRows = execFileSync('sqlite3', [database], {
      encoding: 'utf8',
      input: "SELECT COUNT(*) FROM persistent_tasks WHERE profile_id = 'profile-a';",
    }).trim();
    assert.equal(staleRows, '0');
    const inserts = [
      "INSERT INTO workspaces VALUES ('profile-a', '{}', '2026-08-02', 'current', NULL);",
      "INSERT INTO document_details VALUES ('profile-a', 'doc-1', '{}', '2026-08-02');",
      "INSERT INTO persistent_tasks VALUES ('profile-a', 'task-1', 'sync', 'queued', NULL, NULL, NULL, '2026-08-02', '{}');",
      "INSERT INTO route_aliases VALUES ('profile-a', 'from', 'to', '2026-08-02');",
      "INSERT INTO upload_presets VALUES ('profile-a', 'preset-1', '2026-08-02', '{}');",
      "INSERT INTO offline_files (profile_id, document_id, representation, uri, byte_size, pinned, last_accessed_at, created_at) VALUES ('profile-a', 'doc-1', 'original', 'file:///blocked', 1, 0, '2026-08-02', '2026-08-02');",
      "INSERT INTO task_notification_outbox VALUES ('profile-a', 'task-1', 'dispatch-1', 'pending', NULL, NULL, '2026-08-02');",
      "INSERT INTO capabilities VALUES ('profile-a', 'fingerprint', '2026-08-02', '{}');",
    ];
    for (const statement of inserts) {
      assert.throws(
        () => execFileSync('sqlite3', [database], { input: statement, encoding: 'utf8' }),
        /connection profile has been removed/i,
      );
    }
    assert.throws(
      () => execFileSync('sqlite3', [database], {
        input: "DELETE FROM profile_removal_tombstones WHERE operation_id = 'remove-1';",
        encoding: 'utf8',
      }),
      /tombstones are permanent/i,
    );
    const tombstone = execFileSync('sqlite3', [database], {
      encoding: 'utf8',
      input: "SELECT operation_id, profile_id, payload_json FROM profile_removal_tombstones WHERE operation_id = 'remove-1';",
    }).trim();
    assert.equal(tombstone, 'remove-1|profile-a|{}');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v5 to v6 migration adds only the durable profile-removal commit marker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-v6-migration-'));
  const database = join(directory, 'folio.db');
  try {
    const throughV5 = FOLIO_DATABASE_MIGRATIONS
      .filter((migration) => migration.version <= 5)
      .map((migration) => migration.sql)
      .join('\n');
    execFileSync('sqlite3', [database], {
      input: `BEGIN;\n${throughV5}\nPRAGMA user_version = 5;\nCOMMIT;`,
    });
    execFileSync('sqlite3', [database], {
      input: "INSERT INTO persistent_tasks (profile_id, task_id, kind, stage, next_attempt_at, lease_owner, lease_expires_at, updated_at, payload_json) VALUES ('profile-a', 'legacy-upload', 'upload', 'uploading', '2026-08-02', 'dead-worker', '2026-08-02', '2026-08-02', '{\"schemaVersion\":3,\"kind\":\"upload\",\"stage\":\"uploading\"}');",
    });
    const v6 = FOLIO_DATABASE_MIGRATIONS.find((migration) => migration.version === 6);
    execFileSync('sqlite3', [database], {
      input: `BEGIN;\n${v6.sql}\nPRAGMA user_version = 6;\nCOMMIT;`,
    });
    execFileSync('sqlite3', [database], {
      input: "INSERT INTO profile_removal_tombstones (operation_id, profile_id, created_at, payload_json) VALUES ('remove-1', 'profile-a', '2026-08-02', '{}');",
    });
    const row = execFileSync('sqlite3', [database], {
      encoding: 'utf8',
      input: 'SELECT operation_id, profile_id FROM profile_removal_tombstones;',
    }).trim();
    assert.equal(row, 'remove-1|profile-a');
    const migratedTask = execFileSync('sqlite3', [database], {
      encoding: 'utf8',
      input: "SELECT stage, quote(next_attempt_at), quote(lease_owner), quote(lease_expires_at) FROM persistent_tasks WHERE task_id='legacy-upload';",
    }).trim();
    assert.equal(migratedTask, 'submission-uncertain|NULL|NULL|NULL');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v4 to v5 migration preserves legacy offline files and stores exact filename and MIME', () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-v5-migration-'));
  const database = join(directory, 'folio.db');
  try {
    const throughV4 = FOLIO_DATABASE_MIGRATIONS
      .filter((migration) => migration.version <= 4)
      .map((migration) => migration.sql)
      .join('\n');
    execFileSync('sqlite3', [database], {
      input: `BEGIN;\n${throughV4}\nPRAGMA user_version = 4;\nCOMMIT;\n`
        + `INSERT INTO offline_files (profile_id, document_id, representation, uri, byte_size, pinned, last_accessed_at, created_at) VALUES ('profile-a', 'remote-1', 'original', 'file:///legacy.bin', 42, 1, '2026-01-01', '2026-01-01');`,
    });
    const v5 = FOLIO_DATABASE_MIGRATIONS.find((migration) => migration.version === 5);
    execFileSync('sqlite3', [database], {
      input: `BEGIN;\n${v5.sql}\nPRAGMA user_version = 5;\nCOMMIT;`,
    });
    const legacy = execFileSync('sqlite3', [database], {
      encoding: 'utf8',
      input: "SELECT uri, quote(file_name), quote(mime_type) FROM offline_files WHERE profile_id='profile-a';",
    }).trim();
    assert.equal(legacy, 'file:///legacy.bin|NULL|NULL');
    execFileSync('sqlite3', [database], {
      input: "UPDATE offline_files SET file_name='letter.docx', mime_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document' WHERE profile_id='profile-a';",
    });
    const exact = execFileSync('sqlite3', [database], {
      encoding: 'utf8',
      input: "SELECT file_name, mime_type FROM offline_files WHERE profile_id='profile-a';",
    }).trim();
    assert.equal(exact, 'letter.docx|application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repositories isolate identical remote identities by profile', async () => {
  const repository = new MemoryFolioRepository();
  const makeWorkspace = (profileId, title) => ({
    profileId,
    documents: [{ id: 'remote-1', title }],
    catalog: {},
    totalDocuments: 1,
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    syncState: 'current',
  });
  await repository.replaceWorkspace(makeWorkspace('profile-a', 'Alpha'));
  await repository.replaceWorkspace(makeWorkspace('profile-b', 'Beta'));
  assert.equal((await repository.readWorkspace('profile-a')).documents[0].title, 'Alpha');
  assert.equal((await repository.readWorkspace('profile-b')).documents[0].title, 'Beta');
});

test('failed refresh keeps the last complete cached workspace', async () => {
  const repository = new MemoryFolioRepository();
  await repository.replaceWorkspace({
    profileId: 'profile-a',
    documents: [{ id: 'remote-1', title: 'Retained' }],
    catalog: {},
    totalDocuments: 1,
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    syncState: 'current',
  });
  await repository.writeWorkspaceError('profile-a', 'Server unavailable');
  const workspace = await repository.readWorkspace('profile-a');
  assert.equal(workspace.documents[0].title, 'Retained');
  assert.equal(workspace.syncState, 'error');
  assert.equal(workspace.syncError, 'Server unavailable');
});

test('SQLite workspace errors read and write the latest row in one exclusive transaction', () => {
  const source = readFileSync(
    new URL('../src/lib/sqlite-repository.ts', import.meta.url),
    'utf8',
  );
  const methodStart = source.indexOf('  async writeWorkspaceError(');
  const methodEnd = source.indexOf('\n  async ', methodStart + 3);
  assert.notEqual(methodStart, -1);
  assert.notEqual(methodEnd, -1);
  const method = source.slice(methodStart, methodEnd);

  const transactionStart = method.indexOf('exclusiveMutation');
  const transactionRead = method.indexOf('transaction.getFirstAsync');
  const transactionWrite = method.indexOf('transaction.runAsync');
  assert.ok(transactionStart >= 0);
  assert.ok(transactionRead > transactionStart);
  assert.ok(transactionWrite > transactionRead);
  assert.doesNotMatch(method, /this\.(?:readWorkspace|replaceWorkspace)/);
  assert.match(method, /UPDATE workspaces SET payload_json = \?, sync_state = \?, sync_error = \?/);
  assert.doesNotMatch(method, /INSERT INTO workspaces/);
});

test('SQLite repository serializes direct writes and exclusive transactions', () => {
  const source = readFileSync(
    new URL('../src/lib/sqlite-repository.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /private enqueueMutation<T>[\s\S]*this\.mutationQueue = queued\.then/);
  assert.equal((source.match(/database\.withExclusiveTransactionAsync/g) ?? []).length, 1);
  assert.equal((source.match(/\(await this\.database\(\)\)\.runAsync/g) ?? []).length, 1);
  assert.ok((source.match(/this\.exclusiveMutation\(database/g) ?? []).length > 20);
  assert.ok((source.match(/this\.queuedRunAsync\(/g) ?? []).length > 10);
});

test('profile cleanup never deletes another profile with the same server data', async () => {
  const repository = new MemoryFolioRepository();
  for (const profileId of ['profile-a', 'profile-b']) {
    await repository.writeTask({
      schemaVersion: 1,
      id: 'task-1',
      profileId,
      kind: 'sync',
      stage: 'failed',
      source: 'unknown',
      progress: 0,
      retryCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  await repository.deleteProfileData('profile-a');
  assert.equal((await repository.listTasks('profile-a')).length, 0);
  assert.equal((await repository.listTasks('profile-b')).length, 1);
});

test('profile data deletion publishes a durable scoped commit marker', async () => {
  const repository = new MemoryFolioRepository();
  for (const profileId of ['profile-a', 'profile-b']) {
    await repository.replaceWorkspace({
      profileId,
      documents: [{ id: 'remote-1', title: profileId }],
      catalog: {},
      totalDocuments: 1,
      lastSyncedAt: '2026-08-02T10:00:00.000Z',
      syncState: 'current',
    });
  }
  const tombstone = {
    operationId: 'remove-profile-a',
    profileId: 'profile-a',
    createdAt: '2026-08-02T10:00:00.000Z',
  };

  await repository.deleteProfileDataAndWriteRemovalTombstone(tombstone);

  assert.equal(await repository.readWorkspace('profile-a'), null);
  assert.equal((await repository.readWorkspace('profile-b')).documents[0].title, 'profile-b');
  assert.deepEqual(await repository.readProfileRemovalTombstone(tombstone.operationId), tombstone);
  assert.equal(typeof repository.deleteProfileRemovalTombstone, 'undefined');
});

test('a permanent removal tombstone rejects stale writes after cleanup completes', async () => {
  const repository = new MemoryFolioRepository();
  const tombstone = {
    operationId: 'remove-profile-a',
    profileId: 'profile-a',
    createdAt: '2026-08-02T10:00:00.000Z',
  };
  await repository.writeProfileRemovalManifest({
    schemaVersion: 1,
    reference: tombstone.operationId,
    operationId: tombstone.operationId,
    profileId: tombstone.profileId,
    createdAt: tombstone.createdAt,
    data: { moves: [] },
  });
  await repository.deleteProfileDataAndWriteRemovalTombstone(tombstone);
  await repository.deleteProfileRemovalManifest(tombstone.operationId);

  assert.ok(await repository.readProfileRemovalTombstone(tombstone.operationId));
  await assert.rejects(
    () => repository.replaceWorkspace({
      profileId: 'profile-a',
      documents: [],
      catalog: {},
      totalDocuments: 0,
      lastSyncedAt: tombstone.createdAt,
      syncState: 'current',
    }),
    /removed/,
  );
  const staleTask = {
    schemaVersion: 1,
    id: 'workspace-sync',
    profileId: 'profile-a',
    kind: 'sync',
    stage: 'processing',
    source: 'unknown',
    originalName: 'stale sync',
    progress: 0,
    retryCount: 0,
    createdAt: tombstone.createdAt,
    updatedAt: tombstone.createdAt,
  };
  await assert.rejects(
    () => repository.writeTask(staleTask),
    /removed/,
  );
  assert.equal(
    await repository.claimTask(staleTask, 'stale-worker', new Date(tombstone.createdAt)),
    null,
  );
  assert.equal(
    await repository.claimNextRunnableTask('profile-a', 'stale-worker', new Date(tombstone.createdAt)),
    null,
  );
});

test('a new precommit manifest replaces an orphan left before journal publication', async () => {
  const repository = new MemoryFolioRepository();
  const base = {
    schemaVersion: 1,
    profileId: 'profile-a',
    createdAt: '2026-08-02T10:00:00.000Z',
  };
  await repository.writeProfileRemovalManifest({
    ...base,
    reference: 'orphan-operation',
    operationId: 'orphan-operation',
    data: { moves: [{ originalUri: 'file:///never-staged' }] },
  });
  await repository.writeProfileRemovalManifest({
    ...base,
    reference: 'retry-operation',
    operationId: 'retry-operation',
    data: { moves: [] },
  });

  assert.equal(await repository.readProfileRemovalManifest('orphan-operation'), null);
  assert.deepEqual((await repository.readProfileRemovalManifest('retry-operation')).data, { moves: [] });
});

test('retrying the same removal operation replaces its orphan manifest', async () => {
  const repository = new MemoryFolioRepository();
  const manifest = {
    schemaVersion: 1,
    reference: 'retry-operation',
    operationId: 'retry-operation',
    profileId: 'profile-a',
    createdAt: '2026-08-02T10:00:00.000Z',
    data: { moves: [{ originalUri: 'file:///orphan' }] },
  };
  await repository.writeProfileRemovalManifest(manifest);
  await repository.writeProfileRemovalManifest({ ...manifest, data: { moves: [] } });

  assert.deepEqual((await repository.readProfileRemovalManifest(manifest.operationId)).data, { moves: [] });
});

test('claiming a runnable task leases it to exactly one worker', async () => {
  const repository = new MemoryFolioRepository();
  const now = new Date('2026-01-01T00:00:00.000Z');
  await repository.writeTask({
    schemaVersion: 1,
    id: 'task-1',
    profileId: 'profile-a',
    kind: 'upload',
    stage: 'queued',
    source: 'picker',
    progress: 0,
    retryCount: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  assert.equal((await repository.claimNextRunnableTask('profile-a', 'worker-a', now)).leaseOwner, 'worker-a');
  assert.equal(await repository.claimNextRunnableTask('profile-a', 'worker-b', now), null);
});

test('repository claims durable PDF and bulk operations but not unrelated sync jobs', async () => {
  const repository = new MemoryFolioRepository();
  const now = new Date('2026-01-01T00:00:00.000Z');
  for (const task of [
    { id: 'sync-1', kind: 'sync', stage: 'queued' },
    { id: 'pdf-1', kind: 'pdf-operation', stage: 'processing', paperlessTaskId: 'remote-task-1' },
    { id: 'bulk-1', kind: 'bulk-operation', stage: 'processing', paperlessTaskId: 'remote-task-2' },
  ]) {
    await repository.writeTask({
      schemaVersion: 1,
      profileId: 'profile-a',
      source: 'unknown',
      progress: 0,
      retryCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...task,
    });
  }
  const first = await repository.claimNextRunnableTask('profile-a', 'worker-a', now);
  assert.equal(first.id, 'pdf-1');
  const second = await repository.claimNextRunnableTask('profile-a', 'worker-b', now);
  assert.equal(second.id, 'bulk-1');
  assert.equal(await repository.claimNextRunnableTask('profile-a', 'worker-c', now), null);
});

test('batch task persistence makes every staged file visible together', async () => {
  const repository = new MemoryFolioRepository();
  const makeTask = (id) => ({
    schemaVersion: 1,
    id,
    profileId: 'profile-a',
    kind: 'upload',
    stage: 'preparing',
    source: 'share',
    progress: 0,
    retryCount: 0,
    createdAt: '2026-08-02T10:00:00Z',
    updatedAt: '2026-08-02T10:00:00Z',
  });
  await repository.writeTasks([makeTask('one'), makeTask('two')]);
  assert.deepEqual((await repository.listTasks('profile-a')).map((task) => task.id).sort(), ['one', 'two']);
});
