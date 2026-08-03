import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertBoundedNativeMtlsResponse,
  assertNativeMtlsRequestUrl,
  createNativeMtlsFetch,
  createNativeMtlsPaperlessRequest,
  prepareNativeMutualTls,
  validateNativeMtlsResponseUrl,
} from '../src/lib/auth/native-mtls-adapter.ts';

const NOW = '2026-08-02T10:00:00.000Z';

function identity(overrides = {}) {
  return {
    identityId: 'identity-a',
    subject: 'CN=Alice',
    issuer: 'CN=Folio Test CA',
    notBefore: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    fingerprintSha256: 'AA:BB',
    hasPrivateKey: true,
    source: 'os-credential-store',
    ...overrides,
  };
}

function fakeSession(handler) {
  return {
    profileId: 'profile-a',
    async getRequestHeaders() { return {}; },
    async refreshIfNeeded() {},
    async logout() {},
    request: handler,
    async download() { throw new Error('not expected'); },
    async uploadMultipart() { throw new Error('not expected'); },
    async dispose() {},
  };
}

test('mTLS request URLs are HTTPS, same-origin, and constrained to the saved subpath', () => {
  assert.equal(
    assertNativeMtlsRequestUrl(
      'https://paper.example.com/paperless',
      'https://paper.example.com/paperless/api/documents/',
    ),
    'https://paper.example.com/paperless/api/documents/',
  );
  for (const requestUrl of [
    'https://other.example.com/paperless/api/documents/',
    'https://paper.example.com/api/documents/',
    'http://paper.example.com/paperless/api/documents/',
  ]) {
    assert.throws(
      () => assertNativeMtlsRequestUrl('https://paper.example.com/paperless', requestUrl),
      (error) => error.code === 'client-identity-origin-mismatch',
    );
  }
  assert.throws(
    () => assertNativeMtlsRequestUrl('http://paper.example.com', 'http://paper.example.com/api/'),
    (error) => error.code === 'client-identity-origin-mismatch',
  );
});

test('mTLS never follows even same-origin redirects and rejects cross-origin redirects explicitly', () => {
  assert.doesNotThrow(() => validateNativeMtlsResponseUrl('https://a.test/api/', 'https://a.test/api/'));
  assert.throws(
    () => validateNativeMtlsResponseUrl('https://a.test/api/', 'https://a.test/login/'),
    (error) => error.code === 'client-identity-origin-mismatch',
  );
  assert.throws(
    () => validateNativeMtlsResponseUrl('https://a.test/api/', 'https://b.test/api/'),
    (error) => error.code === 'client-identity-origin-mismatch',
  );
});

test('mTLS response validation counts UTF-8 bytes and fails with a safe bounded error', async () => {
  const response = {
    status: 200,
    headers: {},
    responseUrl: 'https://paper.example.com/api/',
    body: '\u{1f4c4}',
  };
  assert.doesNotThrow(() => assertBoundedNativeMtlsResponse(response, 4));
  assert.throws(
    () => assertBoundedNativeMtlsResponse({ ...response, body: `${response.body}x` }, 4),
    (error) =>
      error.code === 'client-identity-request-failed' &&
      !error.message.includes(response.responseUrl),
  );
  await assert.rejects(
    () => createNativeMtlsFetch(
      fakeSession(async () => ({ ...response, body: null })),
      'https://paper.example.com',
    )('https://paper.example.com/api/'),
    (error) =>
      error.code === 'client-identity-request-failed' &&
      error.message === 'The certificate-aware native transport returned an invalid response.',
  );
});

test('identity selection and connection testing use the same native session', async () => {
  const requests = [];
  const selected = identity();
  const session = fakeSession(async (request) => {
    requests.push(request);
    const settings = request.url.endsWith('/api/ui_settings/');
    return {
      status: 200,
      headers: { 'x-api-version': '10', 'x-version': '2.16.3' },
      responseUrl: request.url,
      body: JSON.stringify(settings
        ? {
            user: { username: 'alice', is_superuser: false },
            permissions: ['view_document'],
            settings: { app_title: 'Archive' },
          }
        : { count: 0, results: [] }),
    };
  });
  const opened = [];
  const result = await prepareNativeMutualTls(
    {
      profileId: 'profile-a',
      serverUrl: 'https://paper.example.com/subpath',
      now: NOW,
    },
    {
      async isAvailable() { return true; },
      async importClientIdentity() { throw new Error('not expected'); },
      async selectClientIdentity() {
        return { identity: selected, clientIdentityRef: 'native-ref-a' };
      },
      async describeClientIdentity() { return null; },
      async removeClientIdentity() {},
      async openAuthenticatedSession(input) {
        opened.push(input);
        return session;
      },
    },
  );

  assert.equal(result.identity.subject, 'CN=Alice');
  assert.equal(result.connection.username, 'alice');
  assert.deepEqual(opened, [{
    profileId: 'profile-a',
    clientIdentityRef: 'native-ref-a',
    serverUrl: 'https://paper.example.com/subpath',
  }]);
  assert.deepEqual(requests.map((request) => request.url), [
    'https://paper.example.com/subpath/api/documents/?page_size=1&truncate_content=true',
    'https://paper.example.com/subpath/api/ui_settings/',
  ]);
  assert.equal(requests.every((request) => !('body' in request)), true);
});

test('explicit import tests the imported identity without falling back to selection', async () => {
  const calls = [];
  const imported = identity({ identityId: 'identity-imported' });
  const result = await prepareNativeMutualTls(
    {
      profileId: 'profile-import',
      serverUrl: 'https://paper.example.com',
      selectionMode: 'import',
      now: NOW,
    },
    {
      async isAvailable() { return true; },
      async importClientIdentity() {
        calls.push('import');
        return { identity: imported, clientIdentityRef: 'native-ref-imported' };
      },
      async selectClientIdentity() {
        assert.fail('explicit import must not open the identity selector');
      },
      async describeClientIdentity() {
        assert.fail('explicit import must not reuse a saved identity');
      },
      async removeClientIdentity() {},
      async openAuthenticatedSession(input) {
        calls.push(`open:${input.clientIdentityRef}`);
        return fakeSession(async (request) => ({
          status: 200,
          headers: { 'x-api-version': '10', 'x-version': '2.16.3' },
          responseUrl: request.url,
          body: request.url.endsWith('/api/ui_settings/')
            ? JSON.stringify({ user: { username: 'alice' }, permissions: [] })
            : JSON.stringify({ count: 0, results: [] }),
        }));
      },
    },
  );

  assert.equal(result.clientIdentityRef, 'native-ref-imported');
  assert.deepEqual(calls, ['import', 'open:native-ref-imported']);
});

test('failed imported-identity tests invoke caller-owned unreferenced cleanup', async () => {
  const released = [];
  await assert.rejects(
    () => prepareNativeMutualTls(
      {
        profileId: 'profile-import',
        serverUrl: 'https://paper.example.com',
        selectionMode: 'import',
        releaseImportedIdentityIfUnused: async (reference) => released.push(reference),
        now: NOW,
      },
      {
        async isAvailable() { return true; },
        async importClientIdentity() {
          return { identity: identity(), clientIdentityRef: 'native-ref-failed-import' };
        },
        async selectClientIdentity() { assert.fail('not expected'); },
        async describeClientIdentity() { assert.fail('not expected'); },
        async removeClientIdentity() {},
        async openAuthenticatedSession() {
          return fakeSession(async () => ({
            status: 401,
            headers: {},
            responseUrl: 'https://paper.example.com/api/documents/?page_size=1&truncate_content=true',
            body: '{}',
          }));
        },
      },
    ),
    (error) => error.code === 'authentication-failure',
  );
  assert.deepEqual(released, ['native-ref-failed-import']);
});

test('PaperlessClient-compatible mTLS requests encode JSON without exposing identity material', async () => {
  const requests = [];
  const request = createNativeMtlsPaperlessRequest(
    fakeSession(async (input) => {
      requests.push(input);
      return {
        status: 201,
        headers: { 'content-type': 'application/json' },
        responseUrl: input.url,
        body: '{"ok":true}',
      };
    }),
    'https://paper.example.com/base',
  );
  const response = await request({
    path: '/api/documents/1/',
    method: 'PATCH',
    headers: { Accept: 'application/json; version=10', 'Content-Type': 'application/json' },
    json: { title: 'Updated' },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(response.data, { ok: true });
  assert.equal(requests[0].body, '{"title":"Updated"}');
  assert.doesNotMatch(JSON.stringify(requests[0]), /identity|private.?key|password/i);
});

test('Android reports no app-managed identities because KeyChain entries are system-owned', async () => {
  const android = await readFile(
    new URL('../modules/folio-mtls/android/src/main/java/app/folio/mtls/FolioMtlsModule.kt', import.meta.url),
    'utf8',
  );

  assert.match(
    android,
    /AsyncFunction\("listManagedClientIdentityRefsAsync"\) \{[\s\S]*?emptyList<String>\(\)[\s\S]*?\n\s*\}/,
  );
  assert.match(android, /Android KeyChain credentials remain user\/system-owned/);
});

test('iOS managed-identity enumeration is restricted to Folio-labeled Keychain entries', async () => {
  const [iosModule, iosIdentity] = await Promise.all([
    readFile(new URL('../modules/folio-mtls/ios/FolioMtlsModule.swift', import.meta.url), 'utf8'),
    readFile(new URL('../modules/folio-mtls/ios/FolioMtlsIdentityStore.swift', import.meta.url), 'utf8'),
  ]);

  assert.match(iosIdentity, /identityPrefix = "app\.folio\.paperless\.mtls\.identity\."/);
  assert.match(iosIdentity, /func list\(\) throws -> \[FolioMtlsStoredIdentity\]/);
  assert.match(iosIdentity, /label\.hasPrefix\(identityPrefix\)/);
  assert.match(
    iosModule,
    /AsyncFunction\("listManagedClientIdentityRefsAsync"\)[\s\S]*?identityStore\.list\(\)\.map\(\\\.reference\)/,
  );
});

test('bootstrap reconciles managed identities only after removal, fence, and profile recovery', async () => {
  const appContext = await readFile(
    new URL('../src/context/app-context.tsx', import.meta.url),
    'utf8',
  );
  const removalRecovery = appContext.indexOf('await recoverPendingProfileRemoval({');
  const fenceRecovery = appContext.indexOf('await recoverTemporaryNativeProfileFileRemovals({');
  const profileHydration = appContext.indexOf('const snapshot = await connectionProfiles.getSnapshot();', fenceRecovery);
  const identityReconciliation = appContext.indexOf('await reconcileManagedClientIdentities({');

  assert.ok(removalRecovery >= 0);
  assert.ok(fenceRecovery > removalRecovery);
  assert.ok(profileHydration > fenceRecovery);
  assert.ok(identityReconciliation > profileHydration);
  assert.match(appContext, /Prepared profile tests live only in process memory/);
  assert.match(appContext, /reconcileManagedClientIdentities\([\s\S]*?\)\.catch\(\(\) => undefined\)/);
});

test('native source contract keeps secrets native, uses OS identities, and preserves platform trust', async () => {
  const [android, iosModule, iosIdentity, iosCertificateParser, iosTransfer, tsBinding] = await Promise.all([
    readFile(new URL('../modules/folio-mtls/android/src/main/java/app/folio/mtls/FolioMtlsModule.kt', import.meta.url), 'utf8'),
    readFile(new URL('../modules/folio-mtls/ios/FolioMtlsModule.swift', import.meta.url), 'utf8'),
    readFile(new URL('../modules/folio-mtls/ios/FolioMtlsIdentityStore.swift', import.meta.url), 'utf8'),
    readFile(new URL('../modules/folio-mtls/ios/FolioMtlsCertificateParser.swift', import.meta.url), 'utf8'),
    readFile(new URL('../modules/folio-mtls/ios/FolioMtlsTransfer.swift', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/auth/native-mtls-module.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(android, /KeyChain\.createInstallIntent\(\)/);
  assert.match(android, /KeyChain\.choosePrivateKeyAlias/);
  assert.match(android, /ssl\.init\(arrayOf\(AliasKeyManager\(context, alias\)\), null, null\)/);
  assert.match(android, /instanceFollowRedirects = false/);
  assert.doesNotMatch(android, /hostnameVerifier\s*=|TrustAll|ALLOW_ALL/i);
  assert.match(iosIdentity, /SecPKCS12Import/);
  assert.match(iosIdentity, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(iosModule, /isSecureTextEntry = true/);
  assert.match(iosModule, /data\.resetBytes/);
  assert.match(iosModule, /read\(upToCount: folioMtlsMaxPkcs12Bytes \+ 1\)/);
  assert.doesNotMatch(iosModule, /Data\(contentsOf: url/);
  assert.match(iosIdentity, /input\.count <= folioMtlsMaxPkcs12Bytes/);
  assert.match(iosIdentity, /CFGetTypeID\(reference\) == SecIdentityGetTypeID\(\)/);
  assert.match(iosIdentity, /unsafeDowncast\(reference, to: SecIdentity\.self\)/);
  assert.doesNotMatch(iosIdentity, /unsafeBitCast/);
  assert.match(iosIdentity, /kSecImportItemTrust/);
  assert.match(iosIdentity, /SecTrustCopyCertificateChain/);
  assert.doesNotMatch(iosIdentity, /kSecImportItemCertChain/);
  assert.match(iosIdentity, /SecTrustSetAnchorCertificatesOnly\(trust, true\)/);
  assert.match(iosIdentity, /SecTrustEvaluateWithError/);
  assert.match(iosIdentity, /SecKeyVerifySignature/);
  assert.match(iosIdentity, /SecCertificateCopyNormalizedSubjectSequence/);
  assert.match(iosIdentity, /SecCertificateCopyNormalizedIssuerSequence/);
  assert.match(iosIdentity, /normalizedSubject == normalizedIssuer/);
  assert.match(iosIdentity, /var result = Array\(evaluated\.dropFirst\(\)\)/);
  assert.match(iosIdentity, /if let last = result\.last, isCryptographicallySelfSigned\(last\)/);
  assert.doesNotMatch(iosIdentity, /private func isTrustAnchor|configured intermediate anchor|system\/user anchor/);
  assert.match(iosIdentity, /makeTrust\(certificates: \[leaf\] \+ candidates\)/);
  assert.doesNotMatch(iosIdentity, /subjectDer|issuerDer|expectedSubject/);
  assert.match(iosIdentity, /if status == errSecItemNotFound \{ return \[\] \}/);
  assert.doesNotMatch(iosIdentity, /SecCertificateCopyValues|kSecOIDX509V1|kSecPropertyKey/);
  assert.match(iosCertificateParser, /case 0x17:[\s\S]*case 0x18:/);
  assert.match(iosCertificateParser, /notBefore < notAfter/);
  assert.match(iosCertificateParser, /signature: Data\(signatureValue\.contents\.dropFirst\(\)\)/);
  assert.match(iosCertificateParser, /case "1\.2\.840\.113549\.1\.1\.10": return try parseRsaPss/);
  assert.match(iosTransfer, /NSURLAuthenticationMethodClientCertificate/);
  assert.match(iosTransfer, /challenge\.protectionSpace\.host\.lowercased\(\) == expectedProtectionSpace\.host/);
  assert.match(iosTransfer, /challenge\.protectionSpace\.isProxy\(\) == false/);
  assert.match(iosTransfer, /certificates: chain\.isEmpty \? nil : chain/);
  assert.match(
    iosTransfer,
    /willPerformHTTPRedirection response: HTTPURLResponse,[\s\S]*newRequest request: URLRequest/,
  );
  assert.match(iosTransfer, /completionHandler\(\.performDefaultHandling, nil\)/);
  assert.match(iosTransfer, /completionHandler\(nil\)/);
  assert.match(iosTransfer, /totalBytesWritten > maximum/);
  assert.match(iosTransfer, /case \.download\(let destination, let maximum\)[\s\S]*downloadedSize[\s\S]*<= maximum/);
  assert.match(iosTransfer, /response\.expectedContentLength > maximum/);
  assert.match(iosTransfer, /data\.count > folioMtlsMaxResponseBytes - received\.count/);
  assert.match(iosTransfer, /RESPONSE_TOO_LARGE/);
  assert.doesNotMatch(iosTransfer, /serverTrust[\s\S]{0,120}useCredential|SecTrustEvaluate|allowInvalid/i);
  assert.match(android, /uploadMultipartAsync/);
  assert.match(android, /downloadAsync/);
  assert.match(android, /request\.maxBytes\.isFinite\(\)[\s\S]*val maxBytes = request\.maxBytes\.toLong\(\)/);
  assert.match(android, /declaredLength < 0 \|\| declaredLength <= maxBytes/);
  assert.match(android, /completed <= maxBytes/);
  assert.match(android, /connection\.contentLengthLong/);
  assert.match(android, /total > MAX_RESPONSE_BYTES/);
  assert.match(android, /RESPONSE_TOO_LARGE/);
  assert.match(iosModule, /uploadMultipartAsync/);
  assert.match(iosModule, /downloadAsync/);
  assert.match(iosModule, /record\.maxBytes[\s\S]*\.download\(destination, Int64\(record\.maxBytes\)\)/);
  assert.match(iosModule, /canceledPendingTransferIds/);
  assert.doesNotMatch(tsBinding, /\b(password|pkcs12|privateKey|certificateData)\s*[?:]/i);
  assert.match(tsBinding, /listManagedClientIdentityRefsAsync\(\): Promise<unknown>/);
  assert.match(tsBinding, /validateManagedClientIdentityRefs/);
  assert.match(tsBinding, /value\.length > 512/);
  assert.match(tsBinding, /assertBoundedNativeMtlsResponse\(response\)/);
  assert.match(tsBinding, /maxBytes: request\.maxBytes/);
});
