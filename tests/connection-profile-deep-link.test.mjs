import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  parseExternalUrl,
  resolveExternalNavigation,
  serializeExternalRoute,
} from '../src/lib/external-routing.ts';
import { ExternalRoutingRuntime } from '../src/lib/external-routing-runtime.ts';
import { consumeCachedLinkingUrl } from '../src/lib/consumable-linking.ts';
import {
  connectionLinkQueryValues,
  isPrivateConnectionHost,
  parseConnectionLinkParameters,
} from '../src/lib/auth/connection-link.ts';
import { en, de } from '../src/i18n/catalogs.ts';

const settingsSource = fs.readFileSync(
  new URL('../src/app/settings.tsx', import.meta.url),
  'utf8',
);
const profileManagerSource = fs.readFileSync(
  new URL('../src/components/profile-manager-sheet.tsx', import.meta.url),
  'utf8',
);
const gatewaySource = fs.readFileSync(
  new URL('../src/components/external-routing-gateway.tsx', import.meta.url),
  'utf8',
);

/** A first run: no profile exists yet, so a connect link must still resolve. */
const UNCONFIGURED = {
  bootstrap: 'ready',
  profileSelection: 'ready',
  biometric: 'unlocked',
  authenticated: false,
  activeProfileId: null,
  knownProfileIds: [],
};

function prefillFor(url) {
  const result = parseExternalUrl(url);
  assert.equal(result.accepted, true, `${url} → ${result.code ?? 'accepted'}`);
  assert.equal(result.route.kind, 'connect');
  return result.route.prefill;
}

function rejectionFor(url) {
  const result = parseExternalUrl(url);
  assert.equal(result.accepted, false, url);
  return result.code;
}

test('a connect link prefills public connection settings and defaults to token auth', () => {
  assert.deepEqual(
    prefillFor('folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com%2F'),
    { serverUrl: 'https://paperless.example.com', authKind: 'token' },
  );
  assert.deepEqual(
    prefillFor(
      'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com%2Fpaperless%2F' +
        '&auth=password&name=Household%20Paperless',
    ),
    {
      serverUrl: 'https://paperless.example.com/paperless',
      authKind: 'paperless-credentials',
      displayName: 'Household Paperless',
    },
  );
});

test('an OIDC connect link carries the issuer, the client registration, and scopes', () => {
  assert.deepEqual(
    prefillFor(
      'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&auth=oidc' +
        '&issuer=https%3A%2F%2Fidentity.example.com%2Frealms%2Ffolio%2F' +
        '&client_id=folio-mobile&scopes=openid%20profile%20email&name=Team',
    ),
    {
      serverUrl: 'https://paperless.example.com',
      authKind: 'oidc',
      displayName: 'Team',
      issuer: 'https://identity.example.com/realms/folio',
      clientId: 'folio-mobile',
      scopes: ['openid', 'profile', 'email'],
    },
  );
});

test('a connect link never carries a secret', () => {
  const secretLinks = [
    'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&token=abcdef',
    'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&password=hunter2',
    'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&Api_Key=abcdef',
    'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&auth=oidc' +
      '&issuer=https%3A%2F%2Fidentity.example.com&client_id=folio&client_secret=shhh',
    'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&otp=123456',
    'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&authorization=Bearer%20x',
  ];
  for (const link of secretLinks) {
    assert.equal(rejectionFor(link), 'connect-secret-in-link', link);
  }
  // The refusal also holds when the parser is called with the values directly.
  assert.deepEqual(
    parseConnectionLinkParameters({ server: 'https://paperless.example.com', secret: 'x' }),
    { accepted: false, code: 'connect-secret-in-link' },
  );
});

test('a connect link requires a usable server address', () => {
  assert.equal(rejectionFor('folio-paperless://connect'), 'connect-server-required');
  assert.equal(rejectionFor('folio-paperless://connect?server='), 'connect-server-required');
  assert.equal(
    rejectionFor('folio-paperless://connect?server=not%20a%20url'),
    'connect-invalid-server',
  );
  assert.equal(
    rejectionFor('folio-paperless://connect?server=ftp%3A%2F%2Fpaperless.example.com'),
    'connect-invalid-server',
  );
  assert.equal(
    rejectionFor('folio-paperless://connect?server=https%3A%2F%2Fuser%3Apass%40paperless.example.com'),
    'connect-invalid-server',
  );
  assert.equal(
    rejectionFor('folio-paperless://connect?server=http%3A%2F%2Fpaperless.example.com'),
    'connect-insecure-server',
  );
});

test('plain HTTP survives only for loopback and private-network servers', () => {
  assert.equal(
    prefillFor('folio-paperless://connect?server=http%3A%2F%2F192.168.1.10%3A8000').serverUrl,
    'http://192.168.1.10:8000',
  );
  assert.equal(
    prefillFor('folio-paperless://connect?server=http%3A%2F%2Flocalhost%3A8000').serverUrl,
    'http://localhost:8000',
  );
  assert.equal(
    prefillFor('folio-paperless://connect?server=http%3A%2F%2Fpaperless.home.lan').serverUrl,
    'http://paperless.home.lan',
  );
  for (const host of ['localhost', '127.0.0.1', '10.0.0.4', '172.16.0.9', 'nas.local']) {
    assert.equal(isPrivateConnectionHost(host), true, host);
  }
  for (const host of ['paperless.example.com', '8.8.8.8', '172.32.0.1', 'local']) {
    assert.equal(isPrivateConnectionHost(host), false, host);
  }
});

test('an OIDC connect link is refused without a verifiable issuer and client', () => {
  const base = 'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&auth=oidc';
  assert.equal(rejectionFor(base), 'connect-issuer-required');
  assert.equal(
    rejectionFor(`${base}&issuer=http%3A%2F%2Fidentity.example.com&client_id=folio`),
    'connect-invalid-issuer',
  );
  assert.equal(
    rejectionFor(`${base}&issuer=https%3A%2F%2Fidentity.example.com%3Ffoo%3Dbar&client_id=folio`),
    'connect-invalid-issuer',
  );
  assert.equal(
    rejectionFor(`${base}&issuer=https%3A%2F%2Fidentity.example.com`),
    'connect-client-required',
  );
  assert.equal(
    rejectionFor(`${base}&issuer=https%3A%2F%2Fidentity.example.com&client_id=folio%20mobile`),
    'connect-invalid-client',
  );
  assert.equal(
    rejectionFor(
      `${base}&issuer=https%3A%2F%2Fidentity.example.com&client_id=folio&scopes=open%22id`,
    ),
    'connect-invalid-scopes',
  );
});

test('connect parameters are strictly allowlisted and single-valued', () => {
  assert.equal(
    rejectionFor('folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&profile=a'),
    'unexpected-query-parameter',
  );
  assert.equal(
    rejectionFor(
      'folio-paperless://connect?server=https%3A%2F%2Fa.example.com&server=https%3A%2F%2Fb.example.com',
    ),
    'duplicate-query-parameter',
  );
  assert.equal(
    rejectionFor('folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&auth=saml'),
    'connect-unsupported-auth',
  );
  // OIDC configuration is meaningless for the other sign-in methods.
  assert.equal(
    rejectionFor(
      'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&client_id=folio',
    ),
    'connect-unsupported-auth',
  );
  assert.equal(
    rejectionFor(
      `folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&name=${'n'.repeat(65)}`,
    ),
    'connect-invalid-name',
  );
  assert.equal(rejectionFor('folio-paperless://connect/extra'), 'route-not-allowed');
  assert.equal(rejectionFor('folio-paperless://connect#server'), 'unsafe-url-components');
});

test('an accepted connect route serializes back to the canonical link', () => {
  const link =
    'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&auth=oidc' +
    '&issuer=https%3A%2F%2Fidentity.example.com&client_id=folio-mobile&name=Team' +
    '&scopes=openid+profile';
  const route = parseExternalUrl(link).route;
  const canonical = serializeExternalRoute(route);
  assert.equal(
    canonical,
    'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&auth=oidc' +
      '&issuer=https%3A%2F%2Fidentity.example.com&client_id=folio-mobile&name=Team' +
      '&scopes=openid+profile',
  );
  assert.deepEqual(parseExternalUrl(canonical).route.prefill, route.prefill);
  assert.deepEqual(connectionLinkQueryValues(route.prefill), {
    server: 'https://paperless.example.com',
    auth: 'oidc',
    issuer: 'https://identity.example.com',
    client_id: 'folio-mobile',
    name: 'Team',
    scopes: 'openid profile',
  });
});

test('a connect route reaches Settings without a configured profile', async () => {
  const route = parseExternalUrl('folio-paperless://connect?server=https%3A%2F%2Fp.example.com').route;
  assert.deepEqual(await resolveExternalNavigation(route, UNCONFIGURED), {
    kind: 'navigate',
    target: {
      pathname: '/settings',
      params: { connect: 'folio-paperless://connect?server=https%3A%2F%2Fp.example.com&auth=token' },
    },
  });
  assert.deepEqual(
    await resolveExternalNavigation(route, { ...UNCONFIGURED, bootstrap: 'pending' }),
    { kind: 'defer', reason: 'bootstrap' },
  );
  assert.deepEqual(
    await resolveExternalNavigation(route, { ...UNCONFIGURED, biometric: 'locked' }),
    { kind: 'defer', reason: 'biometric-lock' },
  );
});

test('a cold-start connect link is consumed once and drains to Settings', async () => {
  let cachedUrl =
    'folio-paperless://connect?server=https%3A%2F%2Fpaperless.example.com&auth=oidc' +
    '&issuer=https%3A%2F%2Fidentity.example.com&client_id=folio-mobile';
  const cache = {
    getLinkingURL: () => cachedUrl,
    clearInitialURL: () => {
      cachedUrl = null;
    },
  };
  const runtime = new ExternalRoutingRuntime();
  assert.equal(
    consumeCachedLinkingUrl(cache, (url) => {
      // Expo's process-wide cache is cleared before the URL gains authority.
      assert.equal(cachedUrl, null);
      assert.equal(runtime.acceptUrl(url, 'deep-link').accepted, true);
    }),
    true,
  );
  const decisions = await runtime.drain(UNCONFIGURED);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'navigate');
  assert.equal(decisions[0].target.pathname, '/settings');
  assert.match(decisions[0].target.params.connect, /^folio-paperless:\/\/connect\?server=/);
  assert.equal(runtime.pending().length, 0);
  assert.equal(consumeCachedLinkingUrl(cache, () => assert.fail('replayed cold link')), false);
});

test('the runtime reports why a connection link was refused', () => {
  const runtime = new ExternalRoutingRuntime();
  assert.deepEqual(
    runtime.acceptUrl('folio-paperless://connect?server=https%3A%2F%2Fp.example.com&token=x'),
    { accepted: false, reason: 'invalid-url', code: 'connect-secret-in-link' },
  );
  assert.deepEqual(
    runtime.acceptUrl('folio-paperless://connect?server=http%3A%2F%2Fp.example.com'),
    { accepted: false, reason: 'invalid-url', code: 'connect-insecure-server' },
  );
  assert.equal(runtime.pending().length, 0);
});

test('the existing external routes are unchanged by the connect route', () => {
  const unchanged = [
    ['folio-paperless://home', 'home'],
    ['folio-paperless://settings', 'settings'],
    ['folio-paperless://scan', 'scanner'],
    ['folio-paperless://inbox?profile=profile-a', 'inbox'],
    ['folio-paperless://library', 'library'],
    ['folio-paperless://search?q=invoices', 'search'],
    ['folio-paperless://document/doc-42?profile=profile-a', 'document'],
  ];
  for (const [url, kind] of unchanged) {
    const result = parseExternalUrl(url);
    assert.equal(result.accepted, true, url);
    assert.equal(result.route.kind, kind, url);
  }
  assert.equal(parseExternalUrl('folio-paperless://connection').accepted, false);
  assert.equal(parseExternalUrl('https://folio.example/connect').accepted, false);
  assert.deepEqual(
    serializeExternalRoute({ kind: 'search', source: 'deep-link', scope: { kind: 'active-profile' }, query: 'invoices' }),
    'folio-paperless://search?q=invoices',
  );
});

test('Settings re-parses the link and the profile form still requires a tested connection', () => {
  assert.match(settingsSource, /parseExternalUrl\(link\)/);
  assert.match(settingsSource, /parsed\.route\.kind === 'connect'/);
  assert.match(settingsSource, /prefill=\{connectPrefillActive \? connectPrefill : null\}/);
  assert.match(profileManagerSource, /prefillApplied\.current = true;/);
  // Save stays gated on a successful connection test, prefilled or not.
  assert.match(profileManagerSource, /if \(!testResult\) return;/);
  // A prefill can never fill a secret field.
  assert.doesNotMatch(profileManagerSource, /setToken\(prefill/);
  assert.doesNotMatch(profileManagerSource, /setPassword\(prefill/);
  assert.match(gatewaySource, /routing\.connectSecretRejected/);
});

test('connection-link strings exist in every shipped catalog', () => {
  for (const catalog of [en, de]) {
    for (const key of [
      'routing.connectLinkTitle',
      'routing.connectSecretRejected',
      'routing.connectLinkRejected',
      'profiles.prefilledFromLink',
      'settings.connectLinkHint',
    ]) {
      assert.equal(typeof catalog[key], 'string', key);
      assert.ok(catalog[key].length > 0, key);
    }
  }
  assert.match(en['settings.connectLinkHint'], /folio-paperless:\/\/connect/);
});
