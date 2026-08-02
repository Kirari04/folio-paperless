import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowPath = join(repositoryRoot, '.github/workflows/store-release.yml');
const workflow = readFileSync(workflowPath, 'utf8');

function jobSource(name, nextName) {
  const startMarker = `  ${name}:\n`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = nextName ? workflow.indexOf(`  ${nextName}:\n`, start + startMarker.length) : workflow.length;
  assert.notEqual(end, -1, `missing ${nextName} job`);
  return workflow.slice(start, end);
}

function stepSource(job, name) {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} step`);
  const next = job.indexOf('\n      - name: ', start + marker.length);
  return job.slice(start, next === -1 ? job.length : next);
}

function inlineNodeScript(step) {
  const match = step.match(/          node <<'NODE'\n([\s\S]*?)\n          NODE/);
  assert.ok(match, 'missing inline Node validator');
  return match[1].replace(/^          /gm, '');
}

const androidJob = jobSource('android-store', 'ios-store');
const iosJob = jobSource('ios-store');

test('EAS artifact metadata is reduced to a bounded canonical HTTPS step output', () => {
  const cases = [
    {
      file: 'eas-android.json',
      job: androidJob,
      outputId: 'android-artifact',
      suffix: 'aab',
    },
    {
      file: 'eas-ios.json',
      job: iosJob,
      outputId: 'ios-artifact',
      suffix: 'ipa',
    },
  ];

  for (const item of cases) {
    const validatorStep = stepSource(item.job, 'Validate EAS artifact URL');
    assert.ok(validatorStep.includes(`id: ${item.outputId}`));
    assert.match(validatorStep, /typeof artifactUrl !== 'string'/);
    assert.match(validatorStep, /artifactUrl\.length > 2048/);
    assert.match(validatorStep, /artifactUrl !== artifactUrl\.trim\(\)/);
    assert.match(validatorStep, /\\u0000-\\u001f/);
    assert.match(validatorStep, /new URL\(artifactUrl\)/);
    assert.ok(validatorStep.includes("url.protocol !== 'https:'"));
    assert.match(validatorStep, /url\.username/);
    assert.match(validatorStep, /url\.password/);
    assert.match(validatorStep, /url\.href !== artifactUrl/);
    assert.match(validatorStep, /process\.env\.GITHUB_OUTPUT/);
    assert.doesNotMatch(validatorStep, /GITHUB_ENV/);
    assert.doesNotMatch(validatorStep, /JSON\.stringify\(build\)/);

    const downloadStep = stepSource(
      item.job,
      item.suffix === 'aab' ? 'Download and verify AAB' : 'Download and verify IPA',
    );
    assert.ok(
      downloadStep.includes(`ARTIFACT_URL: \${{ steps.${item.outputId}.outputs.artifact_url }}`),
    );
    assert.match(downloadStep, /"\$ARTIFACT_URL"/);
  }

  assert.doesNotMatch(workflow, /GITHUB_ENV/);
  assert.doesNotMatch(workflow, /ANDROID_BUILD_URL|IOS_BUILD_URL/);
});

test('inline EAS URL validators reject metadata injection and preserve a legitimate URL', () => {
  const cases = [
    { file: 'eas-android.json', job: androidJob, suffix: 'aab' },
    { file: 'eas-ios.json', job: iosJob, suffix: 'ipa' },
  ];
  const invalidUrls = [
    'http://artifacts.example.test/release.bin',
    'https://user:password@artifacts.example.test/release.bin',
    'https://artifacts.example.test/release.bin\r\nANDROID_STORE_CERT_SHA256=ATTACKER',
    'https://artifacts.example.test/release.bin\nIOS_TEAM_ID=ATTACKER00',
    'https://artifacts.example.test/release.bin\n::warning::ATTACKER',
    ' https://artifacts.example.test/release.bin',
    `https://artifacts.example.test/${'a'.repeat(2048)}`,
  ];

  for (const item of cases) {
    const script = inlineNodeScript(stepSource(item.job, 'Validate EAS artifact URL'));
    const directory = mkdtempSync(join(tmpdir(), `folio-eas-${item.suffix}-`));
    try {
      const metadataPath = join(directory, item.file);
      const outputPath = join(directory, 'github-output');
      const run = (artifactUrl) => {
        writeFileSync(metadataPath, JSON.stringify({
          status: 'FINISHED',
          artifacts: { buildUrl: artifactUrl },
        }));
        rmSync(outputPath, { force: true });
        return spawnSync(process.execPath, ['-e', script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputPath,
            RUNNER_TEMP: directory,
          },
        });
      };

      const legitimateUrl = `https://artifacts.example.test/releases/folio.${item.suffix}?token=abc%2F123`;
      const legitimate = run(legitimateUrl);
      assert.equal(legitimate.status, 0, legitimate.stderr);
      assert.equal(readFileSync(outputPath, 'utf8'), `artifact_url=${legitimateUrl}\n`);

      for (const invalidUrl of invalidUrls) {
        const rejected = run(invalidUrl);
        assert.notEqual(rejected.status, 0, `accepted unsafe URL: ${JSON.stringify(invalidUrl)}`);
        assert.equal(existsSync(outputPath), false);
        assert.doesNotMatch(`${rejected.stdout}\n${rejected.stderr}`, /ATTACKER|::warning/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('EXPO_TOKEN is available only to the two EAS invocation steps', () => {
  for (const job of [androidJob, iosJob]) {
    const stepsOffset = job.indexOf('    steps:\n');
    assert.notEqual(stepsOffset, -1);
    assert.doesNotMatch(job.slice(0, stepsOffset), /EXPO_TOKEN/);

    const requestStep = stepSource(job, 'Request signed EAS build');
    assert.ok(requestStep.includes('EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}'));
    assert.match(requestStep, /\[ -z "\$EXPO_TOKEN" \]/);
    assert.equal([...job.matchAll(/EXPO_TOKEN:/g)].length, 1);
  }
  assert.equal([...workflow.matchAll(/EXPO_TOKEN: \$\{\{ secrets\.EXPO_TOKEN \}\}/g)].length, 2);
});

test('iOS verification binds the app signature and reported team to the protected identity', () => {
  const environmentStep = stepSource(iosJob, 'Validate protected environment');
  assert.match(environmentStep, /\^\[A-Z0-9\]\{10\}\$/);

  const verificationStep = stepSource(iosJob, 'Download and verify IPA');
  assert.match(verificationStep, /codesign --display --verbose=4/);
  assert.match(verificationStep, /actual_team_id=/);
  assert.match(verificationStep, /\[ -z "\$actual_team_id" \]/);
  assert.match(verificationStep, /"\$actual_team_id" != "\$IOS_TEAM_ID"/);
  assert.match(verificationStep, /codesign --verify[\s\S]*-R=/);
  assert.ok(verificationStep.includes('anchor apple generic'));
  assert.ok(verificationStep.includes('certificate leaf[subject.OU]'));
  assert.ok(verificationStep.includes('identifier \\"app.folio.paperless\\"'));
  assert.match(verificationStep, /TeamIdentifier:0/);
});
