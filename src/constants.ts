export const OPENZALO_TEXT_LIMIT = 2000;

export const OPENZALO_DEFAULT_FAILURE_NOTICE_MESSAGE =
  "Some problem occurred, could not send a reply.";

/**
 * Fallback debounce for DM inbound events when no global/channel override is configured.
 * This helps coalesce split text+media events emitted by openzca into a single agent turn.
 */
export const OPENZALO_DEFAULT_DM_INBOUND_DEBOUNCE_MS = 500;
