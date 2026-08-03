import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);

async function openssl(directory, ...args) {
  return execFile('openssl', args, { cwd: directory, maxBuffer: 1024 * 1024 });
}

async function makeKey(directory, name) {
  await openssl(
    directory,
    'genpkey',
    '-algorithm', 'EC',
    '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-out', `${name}.key`,
  );
}

async function makeSelfSignedCa(directory, name, subject) {
  await makeKey(directory, name);
  await openssl(
    directory,
    'req', '-new', '-x509', '-sha256', '-days', '3',
    '-key', `${name}.key`,
    '-subj', subject,
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', 'subjectKeyIdentifier=hash',
    '-out', `${name}.pem`,
  );
}

async function makeSignedCertificate(directory, {
  name,
  subject,
  issuer,
  serial,
  extensions,
}) {
  await makeKey(directory, name);
  await openssl(
    directory,
    'req', '-new', '-sha256',
    '-key', `${name}.key`,
    '-subj', subject,
    '-out', `${name}.csr`,
  );
  await openssl(
    directory,
    'x509', '-req', '-sha256', '-days', '3',
    '-in', `${name}.csr`,
    '-CA', `${issuer}.pem`,
    '-CAkey', `${issuer}.key`,
    '-set_serial', String(serial),
    '-extfile', extensions,
    '-extensions', name === 'leaf' ? 'leaf' : 'ca',
    '-out', `${name}.pem`,
  );
}

test('certificate-chain fixture proves names cannot select issuers or identify rollover roots', {
  timeout: 20_000,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'folio-mtls-chain-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(join(directory, 'extensions.cnf'), `
[ca]
basicConstraints=critical,CA:TRUE,pathlen:2
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always,issuer

[leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always,issuer
`);

  // The root and rollover CA deliberately have the same DN. The rollover CA
  // is self-issued by name but is signed by the old root key, not its own key.
  await makeSelfSignedCa(directory, 'root', '/CN=Folio Rollover CA');
  await makeSignedCertificate(directory, {
    name: 'rollover',
    subject: '/CN=Folio Rollover CA',
    issuer: 'root',
    serial: 2,
    extensions: 'extensions.cnf',
  });
  await makeSignedCertificate(directory, {
    name: 'intermediate',
    subject: '/CN=Folio Intermediate',
    issuer: 'rollover',
    serial: 3,
    extensions: 'extensions.cnf',
  });
  await makeSignedCertificate(directory, {
    name: 'leaf',
    subject: '/CN=Folio Client',
    issuer: 'intermediate',
    serial: 4,
    extensions: 'extensions.cnf',
  });

  // A same-name CA with the wrong key and a wholly unrelated CA model PKCS#12
  // extras. A name-linking implementation can choose the decoy; path building
  // based on signatures ignores both extras.
  await makeSelfSignedCa(directory, 'decoy', '/CN=Folio Intermediate');
  await makeSelfSignedCa(directory, 'unrelated', '/CN=Unrelated Extra CA');
  const bundle = await Promise.all([
    'leaf.pem',
    'intermediate.pem',
    'rollover.pem',
    'decoy.pem',
    'unrelated.pem',
  ].map((name) => readFile(join(directory, name), 'utf8')));
  await writeFile(join(directory, 'bundle.pem'), bundle.join('\n'));
  await writeFile(join(directory, 'peer-chain.pem'), bundle.slice(1, 3).join('\n'));
  await writeFile(join(directory, 'peer-chain-without-rollover.pem'), bundle[1]);

  await openssl(
    directory,
    'pkcs12', '-export',
    '-inkey', 'leaf.key',
    '-in', 'leaf.pem',
    '-certfile', 'bundle.pem',
    '-passout', 'pass:fixture-password',
    '-out', 'identity-with-extras.p12',
  );
  const imported = await openssl(
    directory,
    'pkcs12',
    '-in', 'identity-with-extras.p12',
    '-nokeys',
    '-passin', 'pass:fixture-password',
  );
  assert.equal(imported.stdout.match(/-----BEGIN CERTIFICATE-----/g)?.length, 6);

  const { stdout } = await openssl(
    directory,
    'verify', '-show_chain',
    '-CAfile', 'root.pem',
    '-untrusted', 'bundle.pem',
    'leaf.pem',
  );
  assert.match(stdout, /leaf\.pem: OK/);
  assert.match(stdout, /depth=1: CN = Folio Intermediate/);
  assert.match(stdout, /depth=2: CN = Folio Rollover CA/);
  assert.match(stdout, /depth=3: CN = Folio Rollover CA/);
  assert.doesNotMatch(stdout, /Unrelated Extra CA/);

  // The rollover has the same normalized issuer and subject but is not signed
  // by its own key. A peer trusting the old root needs this top certificate.
  const rolloverNames = await openssl(
    directory,
    'x509', '-in', 'rollover.pem', '-noout', '-subject', '-issuer', '-nameopt', 'RFC2253',
  );
  assert.match(rolloverNames.stdout, /^subject=CN=Folio Rollover CA$/m);
  assert.match(rolloverNames.stdout, /^issuer=CN=Folio Rollover CA$/m);
  await assert.rejects(
    openssl(
      directory,
      'verify', '-CAfile', 'root.pem', '-untrusted', 'peer-chain-without-rollover.pem', 'leaf.pem',
    ),
    (error) => /unable to get local issuer certificate/i.test(
      `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
    ),
  );
  const peerValidation = await openssl(
    directory,
    'verify', '-CAfile', 'root.pem', '-untrusted', 'peer-chain.pem', 'leaf.pem',
  );
  assert.match(peerValidation.stdout, /leaf\.pem: OK/);

  const rootSelfValidation = await openssl(
    directory,
    'verify', '-check_ss_sig', '-CAfile', 'root.pem', 'root.pem',
  );
  assert.match(rootSelfValidation.stdout, /root\.pem: OK/);
  await assert.rejects(
    openssl(
      directory,
      'verify', '-check_ss_sig', '-CAfile', 'rollover.pem', 'rollover.pem',
    ),
    (error) => /unable to get local issuer certificate|certificate signature failure/i.test(
      `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
    ),
  );

  await assert.rejects(
    openssl(
      directory,
      'verify',
      '-CAfile', 'root.pem',
      '-untrusted', 'decoy.pem',
      'leaf.pem',
    ),
    (error) => /unable to get local issuer certificate|certificate signature failure/i.test(
      `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
    ),
  );

  const rootPublicKey = await openssl(directory, 'x509', '-in', 'root.pem', '-pubkey', '-noout');
  const rolloverPublicKey = await openssl(directory, 'x509', '-in', 'rollover.pem', '-pubkey', '-noout');
  assert.notEqual(rootPublicKey.stdout, rolloverPublicKey.stdout);
});
