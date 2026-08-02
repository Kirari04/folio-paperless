export class ServerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerUrlError';
  }
}

export function normalizePaperlessServerUrl(
  value: string,
  { requireHttps = false }: { requireHttps?: boolean } = {},
) {
  const input = value.trim();
  if (!input) throw new ServerUrlError('Enter the address of your Paperless server.');

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new ServerUrlError('Enter a complete server URL, including https://.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ServerUrlError('Paperless server URLs must start with http:// or https://.');
  }
  if (requireHttps && parsed.protocol !== 'https:') {
    throw new ServerUrlError(
      'Folio on iOS requires an HTTPS Paperless address. Use a certificate trusted by this device.',
    );
  }
  if (parsed.username || parsed.password) {
    throw new ServerUrlError('Do not include a username or password in the Paperless server URL.');
  }
  if (parsed.search || parsed.hash) {
    throw new ServerUrlError('Remove the query string or fragment from the Paperless server URL.');
  }

  return parsed.toString().replace(/\/+$/, '');
}
