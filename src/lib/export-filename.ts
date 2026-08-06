// Expo's path utilities encode whitespace and most URL-sensitive characters,
// but leave square brackets and carets unescaped. Android's java.net.URI then
// rejects those file URIs. Also remove characters that are invalid in common
// desktop filenames so web downloads and native exports share one policy.
const UNSAFE_EXPORT_FILENAME_CHARACTERS = /[\\\/:*?"<>|\[\]\^\u0000-\u001f\u007f]/g;

export function sanitizeExportFilename(
  candidate: string,
  fallback: string,
  maxLength = 180,
) {
  const safe = candidate
    .replace(UNSAFE_EXPORT_FILENAME_CHARACTERS, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, maxLength);
  return safe || fallback;
}
