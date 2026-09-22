import type { DocumentStatus } from '../types/document.ts';

type InboxTagLike = { name: string; isInboxTag?: boolean };

/**
 * A Paperless inbox tag is whatever the server flags as one (`is_inbox_tag`),
 * whatever its name: "Inbox", "À vérifier", "Posteingang"… The literal name
 * `inbox` is only a fallback for a tag whose flag is unknown, so a catalog
 * loaded without that field still behaves as before.
 */
export function isInboxTagOption(tag: InboxTagLike) {
  if (typeof tag.isInboxTag === 'boolean') return tag.isInboxTag;
  return tag.name.toLocaleLowerCase() === 'inbox';
}

/** The document status implied by the tags it carries. */
export function inboxStatusFromTags(tags: readonly InboxTagLike[]): DocumentStatus {
  return tags.some(isInboxTagOption) ? 'inbox' : 'archived';
}
