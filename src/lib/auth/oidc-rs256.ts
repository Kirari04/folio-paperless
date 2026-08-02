import { translateRuntime } from '../../i18n/runtime.ts';

export type OidcRs256Jwk = JsonWebKey & {
  kty: 'RSA';
  kid: string;
  n: string;
  e: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeOidcBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error(translateRuntime('authRuntime.base64'));
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error(translateRuntime('authRuntime.base64'));
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new Error(translateRuntime('authRuntime.base64'));
  }
  return new Uint8Array(output);
}

/** Selects one trusted RS256 verification key and validates its public material in JS. */
export function selectOidcRs256Jwk(jwks: unknown, kid: string): OidcRs256Jwk {
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) {
    throw new Error(translateRuntime('authRuntime.jwks'));
  }
  const candidates = jwks.keys.filter(
    (value): value is Record<string, unknown> => isRecord(value) && value.kid === kid,
  );
  if (candidates.length === 0) {
    throw new Error(translateRuntime('authRuntime.signingKeyMissing'));
  }
  if (candidates.length !== 1) {
    throw new Error(translateRuntime('authRuntime.signingKeyAmbiguous'));
  }
  const jwk = candidates[0];
  if (
    jwk.kty !== 'RSA'
    || (jwk.use !== undefined && jwk.use !== 'sig')
    || (jwk.alg !== undefined && jwk.alg !== 'RS256')
    || (jwk.key_ops !== undefined
      && (!Array.isArray(jwk.key_ops)
        || !jwk.key_ops.every((operation) => typeof operation === 'string')
        || !jwk.key_ops.includes('verify')))
    || typeof jwk.n !== 'string'
    || typeof jwk.e !== 'string'
  ) {
    throw new Error(translateRuntime('authRuntime.signingKeyInvalid'));
  }
  const modulus = decodeOidcBase64Url(jwk.n);
  const exponentBytes = decodeOidcBase64Url(jwk.e);
  if (
    modulus.length < 256
    || modulus.length > 1_024
    || modulus[0] === 0
    || (modulus[0] & 0x80) === 0
    || exponentBytes.length < 1
    || exponentBytes.length > 8
    || exponentBytes[0] === 0
  ) {
    throw new Error(translateRuntime('authRuntime.signingKeyInvalid'));
  }
  const exponent = exponentBytes.reduce(
    (value, byte) => (value << 8n) | BigInt(byte),
    0n,
  );
  if (exponent < 3n || exponent > 0x7fff_ffff_ffff_ffffn || exponent % 2n === 0n) {
    throw new Error(translateRuntime('authRuntime.signingKeyInvalid'));
  }
  return {
    kty: 'RSA',
    kid,
    n: jwk.n,
    e: jwk.e,
    ...(jwk.use === 'sig' ? { use: 'sig' } : {}),
    ...(jwk.alg === 'RS256' ? { alg: 'RS256' } : {}),
    ...(Array.isArray(jwk.key_ops)
      ? { key_ops: jwk.key_ops.filter((operation): operation is string => typeof operation === 'string') }
      : {}),
  };
}
