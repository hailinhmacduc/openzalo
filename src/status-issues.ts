import type { ChannelAccountSnapshot, ChannelStatusIssue } from "openclaw/plugin-sdk";

type OpenzaloAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  dmPolicy?: unknown;
  lastError?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

function readOpenzaloAccountStatus(value: ChannelAccountSnapshot): OpenzaloAccountStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    dmPolicy: value.dmPolicy,
    lastError: value.lastError,
  };
}

function isMissingOpenzca(lastError?: string): boolean {
  if (!lastError) {
    return false;
  }
  const lower = lastError.toLowerCase();
  return lower.includes("openzca");
}

function isMissingBinaryDependency(lastError?: string): boolean {
  if (!lastError) {
    return false;
  }
  const lower = lastError.toLowerCase();
  return (lower.includes("not found") || lower.includes("enoent")) && isMissingOpenzca(lower);
}

export function collectOpenzaloStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readOpenzaloAccountStatus(entry);
    if (!account) {
      continue;
    }
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    if (!enabled) {
      continue;
    }

    const configured = account.configured === true;
    const lastError = asString(account.lastError)?.trim();

    if (!configured) {
      if (isMissingBinaryDependency(lastError)) {
        issues.push({
          channel: "openzalo",
          accountId,
          kind: "runtime",
          message: "openzca CLI not found in PATH.",
          fix: "Install openzca and ensure it is on PATH for the Gateway process.",
        });
      } else {
        issues.push({
          channel: "openzalo",
          accountId,
          kind: "auth",
          message: "Not authenticated (no openzca session).",
          fix: "Run: openclaw channels login --channel openzalo",
        });
      }
      continue;
    }

    if (account.dmPolicy === "open") {
      issues.push({
        channel: "openzalo",
        accountId,
        kind: "config",
        message:
          'Zalo Personal dmPolicy is "open", allowing any user to message the bot without pairing.',
        fix: 'Set channels.openzalo.dmPolicy to "pairing" or "allowlist" to restrict access.',
      });
    }
  }
  return issues;
}
