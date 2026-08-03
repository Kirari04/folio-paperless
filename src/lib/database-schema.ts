export const FOLIO_DATABASE_VERSION = 7;

export const FOLIO_DATABASE_MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS workspaces (
        profile_id TEXT PRIMARY KEY NOT NULL,
        payload_json TEXT NOT NULL,
        last_synced_at TEXT NOT NULL,
        sync_state TEXT NOT NULL,
        sync_error TEXT
      );
      CREATE TABLE IF NOT EXISTS document_details (
        profile_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, document_id)
      );
      CREATE TABLE IF NOT EXISTS persistent_tasks (
        profile_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        stage TEXT NOT NULL,
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (profile_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS persistent_tasks_due
        ON persistent_tasks(profile_id, stage, next_attempt_at);
      CREATE TABLE IF NOT EXISTS route_aliases (
        profile_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, source_id)
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS upload_presets (
        profile_id TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (profile_id, preset_id)
      );
      CREATE TABLE IF NOT EXISTS offline_files (
        profile_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        representation TEXT NOT NULL,
        uri TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, document_id, representation)
      );
      CREATE INDEX IF NOT EXISTS offline_files_lru
        ON offline_files(profile_id, pinned, last_accessed_at);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS capabilities (
        profile_id TEXT PRIMARY KEY NOT NULL,
        fingerprint TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    // Additive and downgrade-safe: version 3 builds ignore this index and keep
    // reading the same task payload rows if the application is rolled back.
    sql: `
      CREATE INDEX IF NOT EXISTS persistent_metadata_tasks_due
        ON persistent_tasks(profile_id, kind, stage, next_attempt_at, updated_at);
    `,
  },
  {
    version: 5,
    // Additive forward migration. Existing rows retain their original fields;
    // rollback to a v4 binary still requires restoring a v4 database backup
    // because that binary correctly rejects a newer user_version.
    sql: `
      ALTER TABLE offline_files ADD COLUMN file_name TEXT;
      ALTER TABLE offline_files ADD COLUMN mime_type TEXT;
      CREATE INDEX IF NOT EXISTS persistent_offline_downloads_due
        ON persistent_tasks(profile_id, kind, stage, next_attempt_at, updated_at);
      CREATE TABLE IF NOT EXISTS task_notification_outbox (
        profile_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        lease_owner TEXT,
        lease_expires_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, task_id)
      );
    `,
  },
  {
    version: 6,
    // Committing this marker in the same transaction as profile-scoped data
    // deletion lets startup distinguish a pre-commit native-file quarantine
    // (which must roll back) from a deletion that must be finished.
    sql: `
      CREATE TABLE IF NOT EXISTS profile_removal_tombstones (
        operation_id TEXT PRIMARY KEY NOT NULL,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS profile_removal_tombstones_profile
        ON profile_removal_tombstones(profile_id);
      UPDATE persistent_tasks
        SET stage = 'submission-uncertain', next_attempt_at = NULL,
            lease_owner = NULL, lease_expires_at = NULL
        WHERE kind = 'upload' AND stage = 'uploading'
          AND json_extract(payload_json, '$.paperlessTaskId') IS NULL;
    `,
  },
  {
    version: 7,
    // Large native-path manifests must be durable before quarantine staging,
    // but do not belong in SecureStore where platform value limits are small.
    sql: `
      CREATE TABLE IF NOT EXISTS profile_removal_manifests (
        operation_id TEXT PRIMARY KEY NOT NULL,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS profile_removal_manifests_profile
        ON profile_removal_manifests(profile_id);
      UPDATE profile_removal_tombstones SET payload_json = '{}';
      DELETE FROM workspaces WHERE profile_id IN (SELECT profile_id FROM profile_removal_tombstones);
      DELETE FROM document_details WHERE profile_id IN (SELECT profile_id FROM profile_removal_tombstones);
      DELETE FROM persistent_tasks WHERE profile_id IN (SELECT profile_id FROM profile_removal_tombstones);
      DELETE FROM route_aliases WHERE profile_id IN (SELECT profile_id FROM profile_removal_tombstones);
      DELETE FROM upload_presets WHERE profile_id IN (SELECT profile_id FROM profile_removal_tombstones);
      DELETE FROM offline_files WHERE profile_id IN (SELECT profile_id FROM profile_removal_tombstones);
      DELETE FROM task_notification_outbox WHERE profile_id IN (SELECT profile_id FROM profile_removal_tombstones);
      DELETE FROM capabilities WHERE profile_id IN (SELECT profile_id FROM profile_removal_tombstones);
      CREATE TRIGGER IF NOT EXISTS keep_profile_removal_tombstones_permanent
        BEFORE DELETE ON profile_removal_tombstones
        BEGIN SELECT RAISE(ABORT, 'Profile removal tombstones are permanent.'); END;
      CREATE TRIGGER IF NOT EXISTS keep_profile_removal_tombstones_immutable
        BEFORE UPDATE ON profile_removal_tombstones
        BEGIN SELECT RAISE(ABORT, 'Profile removal tombstones are immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS block_removed_profile_workspaces
        BEFORE INSERT ON workspaces
        WHEN EXISTS (
          SELECT 1 FROM profile_removal_tombstones WHERE profile_id = NEW.profile_id
        )
        BEGIN SELECT RAISE(ABORT, 'The connection profile has been removed.'); END;
      CREATE TRIGGER IF NOT EXISTS block_removed_profile_document_details
        BEFORE INSERT ON document_details
        WHEN EXISTS (
          SELECT 1 FROM profile_removal_tombstones WHERE profile_id = NEW.profile_id
        )
        BEGIN SELECT RAISE(ABORT, 'The connection profile has been removed.'); END;
      CREATE TRIGGER IF NOT EXISTS block_removed_profile_persistent_tasks
        BEFORE INSERT ON persistent_tasks
        WHEN EXISTS (
          SELECT 1 FROM profile_removal_tombstones WHERE profile_id = NEW.profile_id
        )
        BEGIN SELECT RAISE(ABORT, 'The connection profile has been removed.'); END;
      CREATE TRIGGER IF NOT EXISTS block_removed_profile_route_aliases
        BEFORE INSERT ON route_aliases
        WHEN EXISTS (
          SELECT 1 FROM profile_removal_tombstones WHERE profile_id = NEW.profile_id
        )
        BEGIN SELECT RAISE(ABORT, 'The connection profile has been removed.'); END;
      CREATE TRIGGER IF NOT EXISTS block_removed_profile_upload_presets
        BEFORE INSERT ON upload_presets
        WHEN EXISTS (
          SELECT 1 FROM profile_removal_tombstones WHERE profile_id = NEW.profile_id
        )
        BEGIN SELECT RAISE(ABORT, 'The connection profile has been removed.'); END;
      CREATE TRIGGER IF NOT EXISTS block_removed_profile_offline_files
        BEFORE INSERT ON offline_files
        WHEN EXISTS (
          SELECT 1 FROM profile_removal_tombstones WHERE profile_id = NEW.profile_id
        )
        BEGIN SELECT RAISE(ABORT, 'The connection profile has been removed.'); END;
      CREATE TRIGGER IF NOT EXISTS block_removed_profile_task_notification_outbox
        BEFORE INSERT ON task_notification_outbox
        WHEN EXISTS (
          SELECT 1 FROM profile_removal_tombstones WHERE profile_id = NEW.profile_id
        )
        BEGIN SELECT RAISE(ABORT, 'The connection profile has been removed.'); END;
      CREATE TRIGGER IF NOT EXISTS block_removed_profile_capabilities
        BEFORE INSERT ON capabilities
        WHEN EXISTS (
          SELECT 1 FROM profile_removal_tombstones WHERE profile_id = NEW.profile_id
        )
        BEGIN SELECT RAISE(ABORT, 'The connection profile has been removed.'); END;
    `,
  },
] as const;

export function migrationsAfter(version: number) {
  if (!Number.isInteger(version) || version < 0 || version > FOLIO_DATABASE_VERSION) {
    throw new Error(`Unsupported Folio database version ${version}.`);
  }
  return FOLIO_DATABASE_MIGRATIONS.filter((migration) => migration.version > version);
}

export function parseStoredJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Stored ${label} data is corrupted.`);
  }
}
