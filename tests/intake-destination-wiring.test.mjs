import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const gatewaySource = await readFile(
  new URL('../src/components/incoming-share-gateway.tsx', import.meta.url),
  'utf8',
);
const scanSource = await readFile(new URL('../src/app/scan.tsx', import.meta.url), 'utf8');
const homeSource = await readFile(new URL('../src/app/index.tsx', import.meta.url), 'utf8');
const intakeEditorSource = await readFile(new URL('../src/app/intake.tsx', import.meta.url), 'utf8');
const rejectionListSource = await readFile(
  new URL('../src/components/intake-rejection-list.tsx', import.meta.url),
  'utf8',
);
const appContextSource = await readFile(new URL('../src/context/app-context.tsx', import.meta.url), 'utf8');
const paperlessSource = await readFile(new URL('../src/lib/paperless.ts', import.meta.url), 'utf8');

test('incoming shares wait for a completed, rendered destination switch before staging', () => {
  assert.match(gatewaySource, /await switchProfile\(profileId\)/);
  assert.match(gatewaySource, /completedSwitchId !== requestedProfileId/);
  assert.match(gatewaySource, /activeProfile\?\.id !== requestedProfileId/);
  assert.match(gatewaySource, /stageForActiveProfile\(profileId\)/);
});

test('incoming payloads are cleared only after intake or an explicit discard action', () => {
  assert.equal(gatewaySource.match(/clearSharedPayloads\(\)/g)?.length, 2);
  assert.match(gatewaySource, /function discardPayloads\(\)/);
  assert.match(gatewaySource, /await prepareDocuments\(candidates, 'share'\)[\s\S]*clearSharedPayloads\(\)/);
});

test('native share resolver errors never expose untrusted provider details', () => {
  assert.match(gatewaySource, /resolveError \? t\('share\.stagingError'\) : null/);
  assert.doesNotMatch(gatewaySource, /resolveError\?\.message/);
});

test('plain-text share contents survive the app-context intake boundary', () => {
  assert.match(appContextSource, /type ImportFile = \{[\s\S]*textContent\?: string/);
  assert.match(
    appContextSource,
    /files\.map\(\(file\) => \(\{[\s\S]*textContent: file\.textContent,[\s\S]*\}\)\)/,
  );
});

test('intake rejection notices survive picker navigation and present every filename with its reason', () => {
  assert.match(appContextSource, /intakeRejectionBatches/);
  assert.match(appContextSource, /name: sanitizeIntakeFilename\(item\.candidate\.name\)/);
  assert.match(appContextSource, /reason: item\.error\.message/);
  assert.match(appContextSource, /const rejectedTasks = staged\.rejected\.map/);
  assert.match(appContextSource, /const durableTasks = \[\.\.\.accepted, \.\.\.rejectedTasks\]/);
  assert.match(appContextSource, /writeTasks\(durableTasks\)/);
  assert.match(appContextSource, /retryable: false/);
  assert.match(appContextSource, /return \{ \.\.\.staged, accepted, batchId \}/);
  assert.match(homeSource, /profileConfigured && intake\.batchId[\s\S]*pathname: '\/intake'/);
  assert.ok(scanSource.match(/intake\?\.batchId/g)?.length >= 2);
  assert.match(intakeEditorSource, /notice\.batchId === batchId/);
  assert.match(intakeEditorSource, /<IntakeRejectionList/);
  assert.match(rejectionListSource, /item\.name/);
  assert.match(rejectionListSource, /item\.reason/);
  assert.match(rejectionListSource, /onChooseMore/);
  assert.match(rejectionListSource, /onDismiss/);
});

test('an all-invalid incoming share stays visible with per-file retry and discard actions', () => {
  const allInvalidBranch = gatewaySource.slice(
    gatewaySource.indexOf('if (profileConfigured && !result.accepted.length)'),
    gatewaySource.indexOf('clearSharedPayloads();', gatewaySource.indexOf('if (profileConfigured && !result.accepted.length)')),
  );
  assert.match(allInvalidBranch, /setRejectedItems/);
  assert.doesNotMatch(allInvalidBranch, /setVisible\(false\)|clearSharedPayloads/);
  assert.match(gatewaySource, /<IntakeRejectionList[\s\S]*onRetry/);
  assert.match(gatewaySource, /discardPayloads/);
});

test('scan and picker expose destination selection before acquisition and gate profile switching', () => {
  assert.ok(scanSource.match(/<DestinationControl/g)?.length >= 2);
  assert.match(scanSource, /profiles\.length > 1/);
  assert.match(scanSource, /await switchProfile\(profileId\)/);
  assert.match(scanSource, /completedSwitchId !== requestedProfileId/);
  assert.match(scanSource, /activeProfile\?\.id !== requestedProfileId/);
  assert.match(scanSource, /copyToCacheDirectory: true,[\s\S]*multiple: true/);
});

test('manual last-used presets resolve their date from durable prior task history', () => {
  assert.match(intakeEditorSource, /lastUsedCreatedDateForPreset\(/);
  assert.match(
    intakeEditorSource,
    /applyUploadPreset\(draft, preset,[\s\S]*lastUsedDate: lastUsedCreatedDateForPreset\([\s\S]*task\.id !== selected\.id[\s\S]*preset\.id/,
  );
  assert.match(
    intakeEditorSource,
    /uploadMetadataFieldProvenance\(draft, inherited\)/,
  );
});

test('repairing a failed upload edits only mutable jobs from its mixed-result batch', () => {
  assert.match(
    intakeEditorSource,
    /task\.kind === 'upload'[\s\S]*task\.stage === 'preparing'[\s\S]*task\.stage === 'queued'[\s\S]*task\.stage === 'failed'/,
  );
  assert.match(intakeEditorSource, /editable && \(batchId \? task\.batchId === batchId/);
});

test('a source-default auto-submit preset still requires explicit confirmation', () => {
  assert.match(intakeEditorSource, /const source = batch\[0\]\.source[\s\S]*preset\?\.autoSubmit[\s\S]*preset\.defaultFor\?\.includes\(source\)/);
  assert.match(intakeEditorSource, /Alert\.alert\(t\('intake\.autoSubmitConfirmTitle'\)[\s\S]*submitUploadTasks\(batch\.map/);
  assert.match(intakeEditorSource, /autoSubmitPrompts\.current\.has\(promptKey\)/);
});

test('custom fields expose distinct unset and explicit-clear states', () => {
  assert.match(intakeEditorSource, /setValue\(\{ state: 'unset' \}\)/);
  assert.match(intakeEditorSource, /setValue\(\{ state: 'clear' \}\)/);
  assert.match(intakeEditorSource, /explicit\.state === 'clear'[\s\S]*intake\.explicitClear/);
});

test('intake quick-create is exposed only through advertised per-resource capabilities', () => {
  assert.match(intakeEditorSource, /canQuickCreate\.correspondent[\s\S]*createCatalogOption\('correspondent'/);
  assert.match(intakeEditorSource, /canQuickCreate\.documentType[\s\S]*createCatalogOption\('documentType'/);
  assert.match(intakeEditorSource, /canQuickCreate\.tag && uploadAllowed[\s\S]*createCatalogOption\('tag'/);
});

test('foreground queue schedules the persisted retry deadline and cleanup stays profile-scoped', () => {
  assert.match(appContextSource, /const retryAt = nextAutomaticRetryAt\(tasks, profileId\)/);
  assert.match(appContextSource, /setTimeout\([\s\S]*retryAt - Date\.now\(\)/);
  assert.match(appContextSource, /AppState\.currentState === 'active'/);
  assert.match(appContextSource, /staging\.remove\(task\.profileId, task\.localUri\)/);
});

test('foreground upload completion fetches owner capabilities only for an explicit owner override', () => {
  assert.match(
    appContextSource,
    /const requestedOwner = task\.metadata\?\.owner;[\s\S]*if \(!requestedOwner \|\| requestedOwner\.state === 'unset'\) return;[\s\S]*const capabilities = await liveCreationCapabilities\(\)/,
  );
});

test('post-upload owner verification recognizes an exact visibility-losing transfer', () => {
  const ownerPath = paperlessSource.slice(
    paperlessSource.indexOf('export async function applyPaperlessUploadOwner'),
    paperlessSource.indexOf('export async function updatePaperlessDocument'),
  );
  assert.match(ownerPath, /const patched = await sendJson<ApiDocument>/);
  assert.match(ownerPath, /patchConfirmsOwner/);
  assert.match(ownerPath, /error\.status === 403 \|\| error\.status === 404/);
  assert.match(ownerPath, /\(verified\.owner \?\? null\) !== ownerId/);
});
