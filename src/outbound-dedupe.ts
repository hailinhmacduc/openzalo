const OPENZALO_OUTBOUND_RECENT_TTL_MS = 15_000;
const MAX_OPENZALO_OUTBOUND_RECENT_SIGNATURES = 5_000;

type OpenzaloOutboundDedupeEntry = {
  ticketId: number;
  signature: string;
  createdAt: number;
};

export type OpenzaloOutboundDedupeTicket = {
  id: number;
  signature: string;
};

export type AcquireOpenzaloOutboundDedupeResult =
  | {
      acquired: true;
      ticket: OpenzaloOutboundDedupeTicket;
    }
  | {
      acquired: false;
      reason: "inflight" | "recent";
    };

const inflightBySignature = new Map<string, OpenzaloOutboundDedupeEntry>();
const inflightByTicket = new Map<number, OpenzaloOutboundDedupeEntry>();
const recentBySignature = new Map<string, number>();
let nextTicketId = 0;

function normalizeChunk(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 1024);
}

function buildSignature(params: {
  accountId: string;
  sessionKey?: string;
  target: string;
  kind: "text" | "media";
  text?: string;
  mediaRef?: string;
}): string {
  const accountId = normalizeChunk(params.accountId);
  const sessionKey = normalizeChunk(params.sessionKey) || "-";
  const target = normalizeChunk(params.target);
  const kind = params.kind;
  const text = normalizeChunk(params.text);
  const mediaRef = normalizeChunk(params.mediaRef);
  return [accountId, sessionKey, target, kind, text, mediaRef].join("\u001f");
}

function evictRecentOverflow(): void {
  while (recentBySignature.size > MAX_OPENZALO_OUTBOUND_RECENT_SIGNATURES) {
    const oldest = recentBySignature.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    recentBySignature.delete(oldest);
  }
}

function pruneExpired(nowMs = Date.now()): void {
  for (const [signature, expiresAt] of recentBySignature.entries()) {
    if (expiresAt <= nowMs) {
      recentBySignature.delete(signature);
    }
  }

  // Safety net for leaked inflight entries if a process crashes mid-send.
  const staleCutoff = nowMs - OPENZALO_OUTBOUND_RECENT_TTL_MS * 4;
  for (const [signature, entry] of inflightBySignature.entries()) {
    if (entry.createdAt < staleCutoff) {
      inflightBySignature.delete(signature);
      inflightByTicket.delete(entry.ticketId);
    }
  }
}

export function acquireOpenzaloOutboundDedupeSlot(
  params: {
    accountId: string;
    sessionKey?: string;
    target: string;
    kind: "text" | "media";
    text?: string;
    mediaRef?: string;
  },
  nowMs = Date.now(),
): AcquireOpenzaloOutboundDedupeResult {
  pruneExpired(nowMs);
  const signature = buildSignature(params);

  const recentUntil = recentBySignature.get(signature);
  if (typeof recentUntil === "number" && recentUntil > nowMs) {
    return { acquired: false, reason: "recent" };
  }

  if (inflightBySignature.has(signature)) {
    return { acquired: false, reason: "inflight" };
  }

  nextTicketId += 1;
  const entry: OpenzaloOutboundDedupeEntry = {
    ticketId: nextTicketId,
    signature,
    createdAt: nowMs,
  };
  inflightBySignature.set(signature, entry);
  inflightByTicket.set(entry.ticketId, entry);
  return {
    acquired: true,
    ticket: {
      id: entry.ticketId,
      signature,
    },
  };
}

export function releaseOpenzaloOutboundDedupeSlot(params: {
  ticket: OpenzaloOutboundDedupeTicket;
  sent: boolean;
  nowMs?: number;
}): void {
  const nowMs = params.nowMs ?? Date.now();
  const entry = inflightByTicket.get(params.ticket.id);
  if (!entry || entry.signature !== params.ticket.signature) {
    return;
  }
  inflightByTicket.delete(entry.ticketId);
  inflightBySignature.delete(entry.signature);
  if (params.sent) {
    recentBySignature.set(entry.signature, nowMs + OPENZALO_OUTBOUND_RECENT_TTL_MS);
    evictRecentOverflow();
  }
}

export function resetOpenzaloOutboundDedupeForTests(): void {
  inflightBySignature.clear();
  inflightByTicket.clear();
  recentBySignature.clear();
  nextTicketId = 0;
}

