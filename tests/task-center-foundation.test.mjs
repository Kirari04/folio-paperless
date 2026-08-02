import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MemoryFolioRepository } from '../src/lib/memory-repository.ts';
import { TaskCenterService, projectTask } from '../src/lib/task-center.ts';

const taskCenterScreenSource = await readFile(
  new URL('../src/app/tasks.tsx', import.meta.url),
  'utf8',
);

function task(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'job-1',
    profileId: 'profile-a',
    kind: 'offline-download',
    stage: 'queued',
    source: 'unknown',
    originalName: 'Contract.pdf',
    progress: 0.25,
    retryCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('Task Center projects profile-scoped active, failed, and completed counts', async () => {
  const repository = new MemoryFolioRepository();
  for (const value of [
    task({ id: 'active' }),
    task({ id: 'failed', stage: 'failed', error: { code: 'network', message: 'Offline', retryable: true } }),
    task({ id: 'ready', stage: 'ready', result: { remoteDocumentId: 44 } }),
    task({ id: 'other', profileId: 'profile-b' }),
  ]) await repository.writeTask(value);
  const snapshot = await new TaskCenterService(repository).snapshot('profile-a');
  assert.deepEqual(snapshot.counts, { active: 1, failed: 1, completed: 1, canceled: 0 });
  assert.equal(snapshot.tasks.length, 3);
  assert.equal(snapshot.tasks.find((item) => item.id === 'ready').resultRouteId, 'remote-44');
});

test('retry state survives service restart and a Paperless task resumes polling', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(task({
    stage: 'failed',
    paperlessTaskId: 'paperless-42',
    error: { code: 'timeout', message: 'Polling timed out', retryable: true },
    nextAttemptAt: '2026-01-02T00:00:00.000Z',
  }));
  const firstService = new TaskCenterService(repository, undefined, () => new Date('2026-01-03T00:00:00.000Z'));
  const retried = await firstService.retry('profile-a', 'job-1');
  assert.equal(retried.kind, 'updated');
  assert.equal(retried.task.stage, 'processing');
  assert.equal(retried.task.paperlessTaskId, 'paperless-42');
  const restarted = new TaskCenterService(repository);
  assert.equal((await restarted.snapshot('profile-a')).tasks[0].stage, 'processing');
});

test('canceling accepted Paperless work only stops local tracking', async () => {
  const repository = new MemoryFolioRepository();
  const cancellationRequests = [];
  await repository.writeTask(task({
    kind: 'paperless-processing', stage: 'processing', paperlessTaskId: 'paperless-1',
  }));
  const service = new TaskCenterService(repository, {
    requestCancellation(value) { cancellationRequests.push(value.id); },
  }, () => new Date('2026-01-01T00:01:00.000Z'));
  const result = await service.cancel('profile-a', 'job-1');
  assert.equal(result.kind, 'updated');
  assert.equal(result.serverMayContinue, true);
  assert.equal(result.task.stage, 'canceled');
  assert.match(result.task.result.summary, /Paperless may continue/);
  assert.deepEqual(cancellationRequests, ['job-1']);
});

test('canceling an in-flight upload reports uncertain server acceptance', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(task({ kind: 'upload', stage: 'uploading' }));
  const result = await new TaskCenterService(repository).cancel('profile-a', 'job-1');
  assert.equal(result.kind, 'updated');
  assert.equal(result.serverMayContinue, true);
  assert.match(result.task.result.summary, /could not be ruled out/);
  assert.equal(projectTask(task({ stage: 'uploading' })).cancellationMeaning, 'acceptance-uncertain');
});

test('uncertain upload resubmission is a separate confirmation-gated action', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(task({
    schemaVersion: 4,
    kind: 'upload',
    stage: 'submission-uncertain',
    localUri: 'file:///private/contract.pdf',
    metadata: { title: { state: 'value', value: 'Edited contract' } },
    error: {
      code: 'submission-uncertain',
      message: 'Check Paperless before submitting again.',
      retryable: false,
    },
  }));
  const service = new TaskCenterService(
    repository,
    undefined,
    () => new Date('2026-01-01T00:02:00.000Z'),
  );
  const projection = projectTask(await repository.readTask('profile-a', 'job-1'));
  assert.equal(projection.category, 'failed');
  assert.equal(projection.serverAcceptance, 'unknown');
  assert.equal(projection.actions.retry, false);
  assert.equal(projection.actions.resubmit, true);

  const denied = await service.resubmit('profile-a', 'job-1', false);
  assert.equal(denied.kind, 'not-allowed');
  assert.equal((await repository.readTask('profile-a', 'job-1')).stage, 'submission-uncertain');

  const confirmed = await service.resubmit('profile-a', 'job-1', true);
  assert.equal(confirmed.kind, 'updated');
  assert.equal(confirmed.serverMayContinue, true);
  assert.equal(confirmed.task.stage, 'queued');
  assert.equal(confirmed.task.metadata.title.value, 'Edited contract');
});

test('only completed or canceled task records can be dismissed', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(task({ id: 'active' }));
  await repository.writeTask(task({ id: 'ready', stage: 'ready' }));
  const service = new TaskCenterService(repository);
  assert.equal((await service.deleteRecord('profile-a', 'active')).kind, 'not-allowed');
  assert.equal((await service.deleteRecord('profile-a', 'ready')).kind, 'deleted');
  assert.equal(await repository.readTask('profile-a', 'ready'), null);
});

test('permanent failures cannot be manually placed into an infinite retry loop', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(task({
    stage: 'failed',
    error: { code: 'permission', message: 'Forbidden', retryable: false, status: 403 },
  }));
  const result = await new TaskCenterService(repository).retry('profile-a', 'job-1');
  assert.equal(result.kind, 'not-allowed');
  assert.equal((await repository.readTask('profile-a', 'job-1')).stage, 'failed');
});

test('failed tasks can be canceled without losing their original error', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(task({
    kind: 'upload',
    stage: 'failed',
    localUri: 'file:///private/contract.pdf',
    error: { code: 'permission', message: 'Forbidden', retryable: false, status: 403 },
  }));

  const projection = projectTask(await repository.readTask('profile-a', 'job-1'));
  assert.equal(projection.actions.cancel, true);
  assert.equal(projection.cancellationMeaning, 'cancel-local-work');

  const result = await new TaskCenterService(repository).cancel('profile-a', 'job-1');
  assert.equal(result.kind, 'updated');
  assert.equal(result.task.stage, 'canceled');
  assert.deepEqual(result.task.error, {
    code: 'permission', message: 'Forbidden', retryable: false, status: 403,
  });
});

test('Task Center exposes recovery controls for failed local upload drafts', () => {
  assert.match(taskCenterScreenSource, /const cancellable = !metadataConflict && \([\s\S]*task\.stage === 'failed'[\s\S]*task\.stage === 'submission-uncertain'/);
  assert.match(taskCenterScreenSource, /task\.stage === 'failed'[\s\S]*task\.kind === 'upload'[\s\S]*tasks\.editMetadata/);
  assert.doesNotMatch(taskCenterScreenSource, /task\.kind === 'upload'[\s\S]{0,160}!task\.paperlessTaskId[\s\S]{0,160}tasks\.editMetadata/);
  assert.match(taskCenterScreenSource, /!!task\.result\?\.routeDocumentId[\s\S]*tasks\.openResult/);
  assert.match(taskCenterScreenSource, /\{cancellable && \([\s\S]*confirmCancel\(task\)/);
});

test('Task Center exposes explicit metadata conflict and multi-file batch summaries', () => {
  assert.match(taskCenterScreenSource, /groupTasksByBatch\([\s\S]*activeProfile\?\.id/);
  assert.match(taskCenterScreenSource, /batch\.summary\.succeeded/);
  assert.match(taskCenterScreenSource, /batch\.summary\.failed/);
  assert.match(taskCenterScreenSource, /task\.error\?\.code === 'conflict'/);
  assert.match(taskCenterScreenSource, /resolveMetadataConflict\(task\.id, resolution\)/);
  assert.match(taskCenterScreenSource, /tasks\.useServer/);
  assert.match(taskCenterScreenSource, /tasks\.keepLocal/);
});

test('Task Center identifies each upload file by its persisted MIME type', () => {
  assert.match(taskCenterScreenSource, /task\.kind === 'upload'[\s\S]*tasks\.mimeType[\s\S]*task\.mimeType/);
});

test('Task Center treats active upload cancellation as acceptance-uncertain', () => {
  assert.match(taskCenterScreenSource, /taskCancellationMeaning\(task\) === 'acceptance-uncertain'/);
  assert.doesNotMatch(taskCenterScreenSource, /const accepted = !!task\.paperlessTaskId \|\| task\.stage === 'processing'/);
});

test('Task Center requires a destructive confirmation before uncertain upload resubmission', () => {
  assert.match(taskCenterScreenSource, /task\.stage === 'submission-uncertain'/);
  assert.match(taskCenterScreenSource, /confirmUncertainResubmission\(task\)/);
  assert.match(taskCenterScreenSource, /userConfirmedDuplicateRisk: true/);
  assert.match(taskCenterScreenSource, /tasks\.resubmitUncertainBody/);
});

test('Task Center projects exact bulk outcomes and retries failed items only', async () => {
  const repository = new MemoryFolioRepository();
  const failure = { code: 'rate-limited', message: 'Slow down', retryable: true, status: 429 };
  await repository.writeTask(task({
    kind: 'bulk-operation',
    stage: 'failed',
    paperlessTaskId: 'terminal-bulk-task',
    error: failure,
    bulk: {
      operation: { kind: 'tags', mode: 'add', tagIds: [7] },
      targets: [
        { localId: 'one', remoteDocumentId: 1 },
        { localId: 'two', remoteDocumentId: 2 },
      ],
    },
    result: {
      bulkOutcomes: [
        { localId: 'one', remoteDocumentId: 1, state: 'succeeded' },
        {
          localId: 'two', remoteDocumentId: 2, state: 'failed',
          paperlessTaskId: 'terminal-bulk-task', error: failure,
        },
      ],
    },
  }));

  const projection = projectTask(await repository.readTask('profile-a', 'job-1'));
  assert.deepEqual(projection.bulkSummary, { pending: 0, succeeded: 1, failed: 1, skipped: 0 });
  assert.equal(projection.actions.retry, true);

  const result = await new TaskCenterService(repository).retry('profile-a', 'job-1');
  assert.equal(result.kind, 'updated');
  assert.equal(result.task.stage, 'queued');
  assert.equal(result.task.paperlessTaskId, undefined);
  assert.deepEqual(result.task.result.bulkOutcomes.map((outcome) => outcome.state), [
    'succeeded', 'pending',
  ]);
  assert.equal(result.task.result.bulkOutcomes[1].paperlessTaskId, undefined);
});
