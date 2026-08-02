export const MAX_VIEWER_SEARCH_QUERY = 160;
export const MAX_VIEWER_SEARCH_MATCHES = 2_000;
export const MAX_SEARCHABLE_PAGE_CHARS = 2_000_000;
export const MAX_VIEWER_SEARCH_PAGES = 10_000;
export const MAX_VIEWER_SEARCH_TOTAL_CHARS = 16_000_000;

export type SearchablePdfPage = {
  page: number;
  text: string;
  /** Page identity must come from the rendered file, never whole-document OCR. */
  source: 'single-page-document' | 'page-extraction';
};

export type ViewerSearchMatch = {
  page: number;
  start: number;
  end: number;
  snippetBefore: string;
  snippetMatch: string;
  snippetAfter: string;
};

export type ViewerSearchResult =
  | { status: 'ready'; query: string; matches: ViewerSearchMatch[]; truncated: boolean }
  | { status: 'empty-query'; query: ''; matches: []; truncated: false }
  | { status: 'no-searchable-text'; query: string; matches: []; truncated: false };

export type NativePdfSearchEvent = {
  status: 'idle' | 'searching' | 'ready' | 'unavailable';
  query: string;
  matches: ViewerSearchMatch[];
  truncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Treat the native renderer event as an untrusted bridge boundary. This keeps
 * stale or malformed events from navigating the viewer and bounds the amount
 * of PDF-derived text retained by React state.
 */
export function validateNativePdfSearchEvent(
  value: unknown,
  expectedQuery: string,
  bounds: { pageCount: number; maxPageChars?: number },
): NativePdfSearchEvent | null {
  if (!isRecord(value)) return null;
  let expected: string;
  try {
    expected = normalizedQuery(expectedQuery);
  } catch {
    return null;
  }
  if (value.query !== expected) return null;
  if (!['idle', 'searching', 'ready', 'unavailable'].includes(String(value.status))) return null;
  if (typeof value.truncated !== 'boolean' || !Array.isArray(value.matches)) return null;
  if (value.matches.length > MAX_VIEWER_SEARCH_MATCHES) return null;
  if (!Number.isSafeInteger(bounds.pageCount) || bounds.pageCount < 1 || bounds.pageCount > MAX_VIEWER_SEARCH_PAGES) {
    return null;
  }
  const maxPageChars = Math.max(1, Math.min(
    MAX_SEARCHABLE_PAGE_CHARS,
    Math.floor(bounds.maxPageChars ?? MAX_SEARCHABLE_PAGE_CHARS),
  ));

  const matches: ViewerSearchMatch[] = [];
  for (const candidate of value.matches) {
    if (!isRecord(candidate)
      || typeof candidate.page !== 'number' || !Number.isSafeInteger(candidate.page) || candidate.page < 1
      || candidate.page > bounds.pageCount
      || typeof candidate.start !== 'number' || !Number.isSafeInteger(candidate.start) || candidate.start < 0
      || typeof candidate.end !== 'number' || !Number.isSafeInteger(candidate.end) || candidate.end <= candidate.start
      || candidate.end > maxPageChars
      || typeof candidate.snippetBefore !== 'string'
      || typeof candidate.snippetMatch !== 'string'
      || typeof candidate.snippetAfter !== 'string'
      || candidate.snippetBefore.length > 120
      || candidate.snippetMatch.length > MAX_VIEWER_SEARCH_QUERY
      || candidate.snippetAfter.length > 120) {
      return null;
    }
    matches.push({
      page: Number(candidate.page),
      start: Number(candidate.start),
      end: Number(candidate.end),
      snippetBefore: candidate.snippetBefore,
      snippetMatch: candidate.snippetMatch,
      snippetAfter: candidate.snippetAfter,
    });
  }

  return {
    status: value.status as NativePdfSearchEvent['status'],
    query: expected,
    matches,
    truncated: value.truncated,
  };
}

function normalizedQuery(value: string) {
  const query = value.trim();
  if (query.length > MAX_VIEWER_SEARCH_QUERY) {
    throw new Error(`Search is limited to ${MAX_VIEWER_SEARCH_QUERY} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(query)) {
    throw new Error('Search cannot contain control characters.');
  }
  return query;
}

export function deriveSearchablePdfPages(
  fullText: string | undefined,
  pageCount: number,
): SearchablePdfPage[] | null {
  if (!fullText?.trim() || !Number.isSafeInteger(pageCount) || pageCount < 1) return null;
  // Paperless `content` is whole-document OCR/extracted text. Its current
  // post-processing collapses PDF form feeds, so even a coincidental `\f`
  // count is not trustworthy evidence of rendered page boundaries.
  if (pageCount !== 1) return null;
  return [{ page: 1, text: fullText, source: 'single-page-document' }];
}

function snippet(text: string, start: number, end: number) {
  const radius = 58;
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  return {
    snippetBefore: `${from > 0 ? '…' : ''}${text.slice(from, start)}`,
    snippetMatch: text.slice(start, end),
    snippetAfter: `${text.slice(end, to)}${to < text.length ? '…' : ''}`,
  };
}

export async function searchPdfPages(
  pages: readonly SearchablePdfPage[] | null | undefined,
  value: string,
  signal?: AbortSignal,
): Promise<ViewerSearchResult> {
  const query = normalizedQuery(value);
  if (!query) return { status: 'empty-query', query: '', matches: [], truncated: false };
  if (!pages?.length) {
    return { status: 'no-searchable-text', query, matches: [], truncated: false };
  }

  const selectedPages = pages.slice(0, MAX_VIEWER_SEARCH_PAGES);
  const pageIds = new Set<number>();
  const trustworthyPages = selectedPages.every((page) => {
    if (!Number.isSafeInteger(page.page) || page.page < 1 || pageIds.has(page.page)) return false;
    pageIds.add(page.page);
    if (page.source === 'single-page-document') {
      return selectedPages.length === 1 && pages.length === 1 && page.page === 1;
    }
    return page.source === 'page-extraction';
  });
  if (!trustworthyPages) {
    return { status: 'no-searchable-text', query, matches: [], truncated: false };
  }

  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches: ViewerSearchMatch[] = [];
  let truncated = pages.length > selectedPages.length;
  let scannedChars = 0;
  for (let pageIndex = 0; pageIndex < selectedPages.length; pageIndex += 1) {
    if (signal?.aborted) throw new DOMException('Search canceled.', 'AbortError');
    const page = selectedPages[pageIndex];
    const remainingChars = MAX_VIEWER_SEARCH_TOTAL_CHARS - scannedChars;
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }
    const pageLimit = Math.min(MAX_SEARCHABLE_PAGE_CHARS, remainingChars);
    const text = page.text.slice(0, pageLimit);
    scannedChars += text.length;
    if (page.text.length > text.length) truncated = true;
    const expression = new RegExp(escapedQuery, 'giu');
    let match: RegExpExecArray | null;
    let pageMatches = 0;
    while ((match = expression.exec(text))) {
      if (signal?.aborted) throw new DOMException('Search canceled.', 'AbortError');
      const start = match.index;
      const end = start + match[0].length;
      matches.push({ page: page.page, start, end, ...snippet(text, start, end) });
      if (matches.length >= MAX_VIEWER_SEARCH_MATCHES) {
        truncated = true;
        break;
      }
      pageMatches += 1;
      if (pageMatches % 64 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (matches.length >= MAX_VIEWER_SEARCH_MATCHES) break;
    if (pageIndex % 8 === 7) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { status: 'ready', query, matches, truncated };
}
