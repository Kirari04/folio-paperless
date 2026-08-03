/**
 * Non-iOS platforms need no per-file action here. Android backups are disabled
 * for the application in native configuration; web intake is development-only.
 * Metro selects the fail-closed iOS implementation from the sibling `.ios.ts`.
 */
export async function excludeSensitiveFileFromBackup(_fileUri: string) {}
