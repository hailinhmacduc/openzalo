import type { ChildProcess } from "node:child_process";
import type { OpenClawConfig, MarkdownTableMode, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
  mergeAllowlist,
  summarizeMapping,
} from "openclaw/plugin-sdk";
import type {
  OpenzaloGroupMentionDetectionFailureMode,
  ResolvedOpenzaloAccount,
  ZcaFriend,
  ZcaGroup,
  ZcaMessage,
} from "./types.js";
import { getOpenzaloRuntime } from "./runtime.js";
import { sendMessageOpenzalo, sendTypingOpenzalo } from "./send.js";
import { parseJsonOutput, runOpenzca, runOpenzcaStreaming } from "./openzca.js";

export type OpenzaloMonitorOptions = {
  account: ResolvedOpenzaloAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type OpenzaloMonitorResult = {
  stop: () => void;
};

const ZALOUSER_TEXT_LIMIT = 2000;

type OpenzaloDispatchOutcome = {
  sent: boolean;
  failed: boolean;
};

function normalizeOpenzaloEntry(entry: string): string {
  return entry.replace(/^(openzalo|zlu):/i, "").trim();
}

function buildNameIndex<T>(items: T[], nameFn: (item: T) => string | undefined): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const name = nameFn(item)?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const list = index.get(name) ?? [];
    list.push(item);
    index.set(name, list);
  }
  return index;
}

type OpenzaloCoreRuntime = ReturnType<typeof getOpenzaloRuntime>;

function logVerbose(core: OpenzaloCoreRuntime, runtime: RuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log(`[openzalo] ${message}`);
  }
}

function getMentionDetectionFailureMode(
  account: ResolvedOpenzaloAccount,
): OpenzaloGroupMentionDetectionFailureMode {
  return account.config.groupMentionDetectionFailure ?? "deny";
}

function warnMentionDetectionFailure({
  runtime,
  accountId,
  chatId,
  mode,
}: {
  runtime: RuntimeEnv;
  accountId: string;
  chatId: string;
  mode: OpenzaloGroupMentionDetectionFailureMode;
}): void {
  runtime.error(
    `[openzalo] group mention gating is enabled for ${chatId} but no valid mention pattern was built. ` +
      `Current behavior: ${mode}. Set channels.openzalo.groupMentionDetectionFailure to ` +
      `"allow" or "allow-with-warning" to continue processing when detection fails.`,
  );
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(openzalo|zlu):/i, "");
    return normalized === normalizedSenderId;
  });
}

function normalizeGroupSlug(raw?: string | null): string {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isGroupAllowed(params: {
  groupId: string;
  groupName?: string | null;
  groups: Record<string, { allow?: boolean; enabled?: boolean }>;
}): boolean {
  const groups = params.groups ?? {};
  const keys = Object.keys(groups);
  if (keys.length === 0) {
    return false;
  }
  const candidates = [
    params.groupId,
    `group:${params.groupId}`,
    params.groupName ?? "",
    normalizeGroupSlug(params.groupName ?? ""),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const entry = groups[candidate];
    if (!entry) {
      continue;
    }
    return entry.allow !== false && entry.enabled !== false;
  }
  const wildcard = groups["*"];
  if (wildcard) {
    return wildcard.allow !== false && wildcard.enabled !== false;
  }
  return false;
}

async function startOpenzcaListener(
  runtime: RuntimeEnv,
  profile: string,
  onMessage: (msg: ZcaMessage) => void,
  onError: (err: Error) => void,
  abortSignal: AbortSignal,
): Promise<ChildProcess> {
  let buffer = "";

  const { proc, promise } = await runOpenzcaStreaming(["listen", "-r", "-k"], {
    profile,
    onData: (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as ZcaMessage;
          onMessage(parsed);
        } catch {
          // ignore non-JSON lines
        }
      }
    },
    onError,
  });

    proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      runtime.error(`[openzalo] openzca stderr: ${text}`);
    }
  });

  void promise.then((result) => {
    if (!result.ok && !abortSignal.aborted) {
      onError(new Error(result.stderr || `openzca listen exited with code ${result.exitCode}`));
    }
  });

  abortSignal.addEventListener(
    "abort",
    () => {
      proc.kill("SIGTERM");
    },
    { once: true },
  );

  return proc;
}

async function processMessage(
  message: ZcaMessage,
  account: ResolvedOpenzaloAccount,
  config: OpenClawConfig,
  core: OpenzaloCoreRuntime,
  runtime: RuntimeEnv,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  mentionDetectionFailureWarnings?: Set<string>,
): Promise<void> {
  const { threadId, content, timestamp, metadata } = message;
  if (!content?.trim()) {
    return;
  }

  const isGroup = metadata?.isGroup ?? false;
  const senderId = metadata?.fromId ?? threadId;
  const senderName = metadata?.senderName ?? "";
  const groupName = metadata?.threadName ?? "";
  const chatId = threadId;

  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
  const groups = account.config.groups ?? {};
  if (isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(core, runtime, `openzalo: drop group ${chatId} (groupPolicy=disabled)`);
      return;
    }
    if (groupPolicy === "allowlist") {
      const allowed = isGroupAllowed({ groupId: chatId, groupName, groups });
      if (!allowed) {
        logVerbose(core, runtime, `openzalo: drop group ${chatId} (not allowlisted)`);
        return;
      }
    }
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const rawBody = content.trim();
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    !isGroup && (dmPolicy !== "open" || shouldComputeAuth)
      ? await core.channel.pairing.readAllowFromStore("openzalo").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, effectiveAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logVerbose(core, runtime, `Blocked openzalo DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;

      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "openzalo",
            id: senderId,
            meta: { name: senderName || undefined },
          });

          if (created) {
            logVerbose(core, runtime, `openzalo pairing request sender=${senderId}`);
            try {
              await sendMessageOpenzalo(
                chatId,
                core.channel.pairing.buildPairingReply({
                  channel: "openzalo",
                  idLine: `Your Zalo user id: ${senderId}`,
                  code,
                }),
                { profile: account.profile },
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(
                core,
                runtime,
                `openzalo pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized openzalo sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  const isControlCommand = core.channel.commands.isControlCommandMessage(rawBody, config);
  if (isGroup && isControlCommand && commandAuthorized !== true) {
    logVerbose(
      core,
      runtime,
      `openzalo: drop control command from unauthorized sender ${senderId}`,
    );
    return;
  }

  const peer = isGroup
    ? { kind: "group" as const, id: chatId }
    : { kind: "group" as const, id: senderId };

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "openzalo",
    accountId: account.accountId,
    peer: {
      // Use "group" kind to avoid dmScope=main collapsing all DMs into the main session.
      kind: peer.kind,
      id: peer.id,
    },
  });

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config, route.agentId);
  const shouldRequireMention = isGroup
      ? core.channel.groups.resolveRequireMention({
          cfg: config,
          channel: "openzalo",
          accountId: account.accountId,
          groupId: chatId,
          groupChannel: groupName,
        })
      : false;
  const wasMentioned = isGroup
    ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
    : false;
  const shouldBypassMention = isControlCommand && shouldRequireMention && commandAuthorized === true;
  const canDetectMention = mentionRegexes.length > 0;
  const effectiveWasMentioned = shouldBypassMention || wasMentioned;
  if (isGroup && shouldRequireMention) {
    if (canDetectMention) {
      if (!effectiveWasMentioned) {
        logVerbose(core, runtime, `openzalo: skip group message (mention required): ${chatId}`);
        return;
      }
    } else {
      const mode = getMentionDetectionFailureMode(account);
      const warningKey = `${account.accountId}:${chatId}:mention-detection:${mode}`;
      if (!mentionDetectionFailureWarnings?.has(warningKey)) {
        if (mode === "allow-with-warning") {
          warnMentionDetectionFailure({
            runtime,
            accountId: account.accountId,
            chatId,
            mode,
          });
          mentionDetectionFailureWarnings?.add(warningKey);
        } else if (mode === "deny") {
          warnMentionDetectionFailure({
            runtime,
            accountId: account.accountId,
            chatId,
            mode,
          });
          mentionDetectionFailureWarnings?.add(warningKey);
          logVerbose(
            core,
            runtime,
            `openzalo: skip group message (mention required, detection unavailable): ${chatId}`,
          );
          return;
        }
      }
    }
  }

  const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Zalo Personal",
    from: fromLabel,
    timestamp: timestamp ? timestamp * 1000 : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `openzalo:group:${chatId}` : `openzalo:${senderId}`,
    To: `openzalo:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    Provider: "openzalo",
    Surface: "openzalo",
    MessageSid: message.msgId ?? `${timestamp}`,
    OriginatingChannel: "openzalo",
    OriginatingTo: `openzalo:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`openzalo: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "openzalo",
    accountId: account.accountId,
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "openzalo",
    accountId: account.accountId,
  });
  const shouldSendFailureNotice = account.config.sendFailureNotice !== false;
  const failureNoticeMessage = account.config.sendFailureMessage?.trim()
    ? account.config.sendFailureMessage.trim()
    : "Some problem occurred, could not send a reply.";

  let hadDispatchError = false;
  let sentReply = false;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      const result = await sendTypingOpenzalo(chatId, { profile: account.profile, isGroup });
      if (!result.ok) {
        throw new Error(result.error || "Failed to send typing indicator");
      }
    },
    onStartError: (err) => {
      hadDispatchError = true;
      logTypingFailure({
        log: (message) => runtime.log?.(`[openzalo] ${message}`),
        channel: "openzalo",
        action: "start",
        target: chatId,
        error: err,
      });
    },
  });
  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(config, route.agentId),
      deliver: async (payload) => {
        const outcome = await deliverOpenzaloReply({
          payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
          profile: account.profile,
          chatId,
          isGroup,
          runtime,
          core,
          config,
          accountId: account.accountId,
          statusSink,
          tableMode,
        });
        if (outcome.sent) {
          sentReply = true;
        }
        if (outcome.failed) {
          hadDispatchError = true;
        }
      },
      onError: (err, info) => {
        hadDispatchError = true;
        runtime.error?.(`[${account.accountId}] Openzalo ${info.kind} reply failed: ${String(err)}`);
      },
      onReplyStart: typingCallbacks.onReplyStart,
      onIdle: typingCallbacks.onIdle,
    });

  try {
    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg: config,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        onModelSelected,
      },
    });
  } catch (err) {
    hadDispatchError = true;
    runtime.error?.(`[${account.accountId}] openzalo dispatch failed: ${String(err)}`);
  } finally {
    markDispatchIdle();
  }

  if (hadDispatchError && !sentReply && shouldSendFailureNotice) {
    const notice = await sendMessageOpenzalo(chatId, failureNoticeMessage, {
      profile: account.profile,
      isGroup,
    });
    if (!notice.ok) {
      runtime.error(`openzalo: failed to send failure notice: ${notice.error || "unknown error"}`);
    }
  }
}

async function deliverOpenzaloReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  profile: string;
  chatId: string;
  isGroup: boolean;
  runtime: RuntimeEnv;
  core: OpenzaloCoreRuntime;
  config: OpenClawConfig;
  accountId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  tableMode?: MarkdownTableMode;
}): Promise<OpenzaloDispatchOutcome> {
  const { payload, profile, chatId, isGroup, runtime, core, config, accountId, statusSink } =
    params;
  let sent = false;
  let failed = false;
  const tableMode = params.tableMode ?? "code";
  const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? text : undefined;
      first = false;
      logVerbose(core, runtime, `Sending media to ${chatId}`);
      const result = await sendMessageOpenzalo(chatId, caption ?? "", {
        profile,
        mediaUrl,
        isGroup,
      });
      if (result.ok) {
        statusSink?.({ lastOutboundAt: Date.now() });
        sent = true;
      } else {
        failed = true;
        runtime.error(`Openzalo media send failed: ${result.error || "Unknown error"}`);
      }
    }
    return { sent, failed };
  }

  if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "openzalo", accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(
      text,
      ZALOUSER_TEXT_LIMIT,
      chunkMode,
    );
    logVerbose(core, runtime, `Sending ${chunks.length} text chunk(s) to ${chatId}`);
    for (const chunk of chunks) {
      const result = await sendMessageOpenzalo(chatId, chunk, { profile, isGroup });
      if (result.ok) {
        statusSink?.({ lastOutboundAt: Date.now() });
        sent = true;
      } else {
        failed = true;
        runtime.error(`Openzalo message send failed: ${result.error || "Unknown error"}`);
      }
    }
  }
  return { sent, failed };
}

export async function monitorOpenzaloProvider(
  options: OpenzaloMonitorOptions,
): Promise<OpenzaloMonitorResult> {
  let { account, config } = options;
  const { abortSignal, statusSink, runtime } = options;

  const core = getOpenzaloRuntime();
  let stopped = false;
  let proc: ChildProcess | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveRunning: (() => void) | null = null;

  try {
    const profile = account.profile;
    const allowFromEntries = (account.config.allowFrom ?? [])
      .map((entry) => normalizeOpenzaloEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");

    if (allowFromEntries.length > 0) {
      const result = await runOpenzca(["friend", "list", "-j"], { profile, timeout: 15000 });
      if (result.ok) {
        const friends = parseJsonOutput<ZcaFriend[]>(result.stdout) ?? [];
        const byName = buildNameIndex(friends, (friend) => friend.displayName);
        const additions: string[] = [];
        const mapping: string[] = [];
        const unresolved: string[] = [];
        for (const entry of allowFromEntries) {
          if (/^\d+$/.test(entry)) {
            additions.push(entry);
            continue;
          }
          const matches = byName.get(entry.toLowerCase()) ?? [];
          const match = matches[0];
          const id = match?.userId ? String(match.userId) : undefined;
          if (id) {
            additions.push(id);
            mapping.push(`${entry}→${id}`);
          } else {
            unresolved.push(entry);
          }
        }
        const allowFrom = mergeAllowlist({ existing: account.config.allowFrom, additions });
        account = {
          ...account,
          config: {
            ...account.config,
            allowFrom,
          },
        };
        summarizeMapping("openzalo users", mapping, unresolved, runtime);
      } else {
        runtime.log?.(`openzalo user resolve failed; using config entries. ${result.stderr}`);
      }
    }

    const groupsConfig = account.config.groups ?? {};
    const groupKeys = Object.keys(groupsConfig).filter((key) => key !== "*");
    if (groupKeys.length > 0) {
      const result = await runOpenzca(["group", "list", "-j"], { profile, timeout: 15000 });
      if (result.ok) {
        const groups = parseJsonOutput<ZcaGroup[]>(result.stdout) ?? [];
        const byName = buildNameIndex(groups, (group) => group.name);
        const mapping: string[] = [];
        const unresolved: string[] = [];
        const nextGroups = { ...groupsConfig };
        for (const entry of groupKeys) {
          const cleaned = normalizeOpenzaloEntry(entry);
          if (/^\d+$/.test(cleaned)) {
            if (!nextGroups[cleaned]) {
              nextGroups[cleaned] = groupsConfig[entry];
            }
            mapping.push(`${entry}→${cleaned}`);
            continue;
          }
          const matches = byName.get(cleaned.toLowerCase()) ?? [];
          const match = matches[0];
          const id = match?.groupId ? String(match.groupId) : undefined;
          if (id) {
            if (!nextGroups[id]) {
              nextGroups[id] = groupsConfig[entry];
            }
            mapping.push(`${entry}→${id}`);
          } else {
            unresolved.push(entry);
          }
        }
        account = {
          ...account,
          config: {
            ...account.config,
            groups: nextGroups,
          },
        };
        summarizeMapping("openzalo groups", mapping, unresolved, runtime);
      } else {
        runtime.log?.(`openzalo group resolve failed; using config entries. ${result.stderr}`);
      }
    }
  } catch (err) {
    runtime.log?.(`openzalo resolve failed; using config entries. ${String(err)}`);
  }

  const mentionDetectionFailureWarnings = new Set<string>();

  const stop = () => {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (proc) {
      proc.kill("SIGTERM");
      proc = null;
    }
    resolveRunning?.();
  };

  const startListener = () => {
    if (stopped || abortSignal.aborted) {
      resolveRunning?.();
      return;
    }

    logVerbose(
      core,
      runtime,
      `[${account.accountId}] starting openzca listener (profile=${account.profile})`,
    );

    void startOpenzcaListener(
      runtime,
      account.profile,
      (msg) => {
        logVerbose(core, runtime, `[${account.accountId}] inbound message`);
        statusSink?.({ lastInboundAt: Date.now() });
        processMessage(
          msg,
          account,
          config,
          core,
          runtime,
          statusSink,
          mentionDetectionFailureWarnings,
        ).catch((err) => {
          runtime.error(`[${account.accountId}] Failed to process message: ${String(err)}`);
        });
      },
      (err) => {
        runtime.error(`[${account.accountId}] openzca listener error: ${String(err)}`);
        if (!stopped && !abortSignal.aborted) {
          logVerbose(core, runtime, `[${account.accountId}] restarting listener in 5s...`);
          restartTimer = setTimeout(startListener, 5000);
        } else {
          resolveRunning?.();
        }
      },
      abortSignal,
    )
      .then((listenerProc) => {
        proc = listenerProc;
      })
      .catch((err) => {
        const listenerError = err instanceof Error ? err : new Error(String(err));
        runtime.error(`[${account.accountId}] openzca listener error: ${String(listenerError)}`);
        if (!stopped && !abortSignal.aborted) {
          logVerbose(core, runtime, `[${account.accountId}] restarting listener in 5s...`);
          restartTimer = setTimeout(startListener, 5000);
        } else {
          resolveRunning?.();
        }
      });
  };

  // Create a promise that stays pending until abort or stop
  const runningPromise = new Promise<void>((resolve) => {
    resolveRunning = resolve;
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });

  startListener();

  // Wait for the running promise to resolve (on abort/stop)
  await runningPromise;

  return { stop };
}
