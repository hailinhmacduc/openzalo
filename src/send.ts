import { stat } from "node:fs/promises";
import { resolveOpenzcaProfileEnv, runOpenzca, parseJsonOutput } from "./openzca.js";
import { OPENZALO_TEXT_LIMIT } from "./constants.js";

export type OpenzaloSendOptions = {
  profile?: string;
  mediaUrl?: string;
  caption?: string;
  isGroup?: boolean;
  maxChars?: number;
  maxBytes?: number;
};

export type OpenzaloSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

export type OpenzaloActionResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

function resolveMaxChars(options: OpenzaloSendOptions): number {
  const candidate = options.maxChars;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return Math.min(Math.floor(candidate), OPENZALO_TEXT_LIMIT);
  }
  return OPENZALO_TEXT_LIMIT;
}

function clampText(text: string, options: OpenzaloSendOptions): string {
  const maxChars = resolveMaxChars(options);
  return text.slice(0, maxChars);
}

function isHttpUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw);
}

async function checkLocalFileSizeWithinLimit(pathLike: string, maxBytes?: number): Promise<string | null> {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return null;
  }
  const trimmed = pathLike.trim();
  if (!trimmed || isHttpUrl(trimmed)) {
    return null;
  }

  try {
    const meta = await stat(trimmed);
    if (!meta.isFile()) {
      return null;
    }
    if (meta.size > maxBytes) {
      const maxMb = (maxBytes / (1024 * 1024)).toFixed(1);
      const gotMb = (meta.size / (1024 * 1024)).toFixed(1);
      return `Media file is too large (${gotMb} MB). Limit is ${maxMb} MB.`;
    }
    return null;
  } catch {
    // Ignore stat failures (e.g. remote aliases or paths not present at precheck time).
    return null;
  }
}

export async function sendMessageOpenzalo(
  threadId: string,
  text: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloSendResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";

  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }

  // Handle media sending
  if (options.mediaUrl) {
    return sendMediaOpenzalo(threadId, options.mediaUrl, {
      ...options,
      caption: text || options.caption,
    });
  }

  // Send text message
  const args = ["msg", "send", threadId.trim(), clampText(text, options)];
  if (options.isGroup) {
    args.push("-g");
  }

  try {
    const result = await runOpenzca(args, { profile });

    if (result.ok) {
      return { ok: true, messageId: extractMessageId(result.stdout) };
    }

    return { ok: false, error: result.stderr || "Failed to send message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendTypingOpenzalo(
  threadId: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloSendResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";

  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }

  const args = ["msg", "typing", threadId.trim()];
  if (options.isGroup) {
    args.push("-g");
  }

  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, messageId: extractMessageId(result.stdout) };
    }

    return { ok: false, error: result.stderr || "Failed to send typing event" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendMediaOpenzalo(
  threadId: string,
  mediaUrl: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloSendResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";

  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }

  if (!mediaUrl?.trim()) {
    return { ok: false, error: "No media URL provided" };
  }

  // Determine media type from URL
  const lowerUrl = mediaUrl.toLowerCase();
  let command: string;
  if (lowerUrl.match(/\.(mp4|mov|avi|webm)$/)) {
    command = "video";
  } else if (lowerUrl.match(/\.(mp3|wav|ogg|m4a)$/)) {
    command = "voice";
  } else {
    command = "image";
  }

  const mediaSizeError = await checkLocalFileSizeWithinLimit(mediaUrl, options.maxBytes);
  if (mediaSizeError) {
    return { ok: false, error: mediaSizeError };
  }

  const args = ["msg", command, threadId.trim(), "-u", mediaUrl.trim()];
  if (options.caption) {
    args.push("-m", clampText(options.caption, options));
  }
  if (options.isGroup) {
    args.push("-g");
  }

  try {
    const result = await runOpenzca(args, { profile });

    if (result.ok) {
      return { ok: true, messageId: extractMessageId(result.stdout) };
    }

    return { ok: false, error: result.stderr || `Failed to send ${command}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendImageOpenzalo(
  threadId: string,
  imageUrl: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloSendResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const mediaSizeError = await checkLocalFileSizeWithinLimit(imageUrl, options.maxBytes);
  if (mediaSizeError) {
    return { ok: false, error: mediaSizeError };
  }
  const args = ["msg", "image", threadId.trim(), "-u", imageUrl.trim()];
  if (options.caption) {
    args.push("-m", clampText(options.caption, options));
  }
  if (options.isGroup) {
    args.push("-g");
  }

  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, messageId: extractMessageId(result.stdout) };
    }
    return { ok: false, error: result.stderr || "Failed to send image" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendLinkOpenzalo(
  threadId: string,
  url: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloSendResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = ["msg", "link", threadId.trim(), url.trim()];
  if (options.isGroup) {
    args.push("-g");
  }

  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, messageId: extractMessageId(result.stdout) };
    }
    return { ok: false, error: result.stderr || "Failed to send link" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendReactionOpenzalo(
  params: {
    threadId: string;
    msgId: string;
    cliMsgId: string;
    reaction: string;
  },
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = [
    "msg",
    "react",
    params.msgId.trim(),
    params.cliMsgId.trim(),
    params.threadId.trim(),
    params.reaction.trim(),
  ];
  if (options.isGroup) {
    args.push("-g");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? result.stdout };
    }
    return { ok: false, error: result.stderr || "Failed to react to message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function readRecentMessagesOpenzalo(
  threadId: string,
  options: OpenzaloSendOptions & { count?: number } = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = ["msg", "recent", threadId.trim(), "-j"];
  const count = options.count;
  if (typeof count === "number" && Number.isFinite(count)) {
    const bounded = Math.min(Math.max(Math.trunc(count), 1), 200);
    args.push("-n", String(bounded));
  }
  if (options.isGroup) {
    args.push("-g");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? { raw: result.stdout } };
    }
    return { ok: false, error: result.stderr || "Failed to read recent messages" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteMessageOpenzalo(
  params: {
    threadId: string;
    msgId: string;
    cliMsgId: string;
    uidFrom: string;
    onlyMe?: boolean;
  },
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = [
    "msg",
    "delete",
    params.msgId.trim(),
    params.cliMsgId.trim(),
    params.uidFrom.trim(),
    params.threadId.trim(),
  ];
  if (options.isGroup) {
    args.push("-g");
  }
  if (params.onlyMe) {
    args.push("--only-me");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? result.stdout };
    }
    return { ok: false, error: result.stderr || "Failed to delete message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function unsendMessageOpenzalo(
  params: {
    threadId: string;
    msgId: string;
    cliMsgId: string;
  },
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = ["msg", "undo", params.msgId.trim(), params.cliMsgId.trim(), params.threadId.trim()];
  if (options.isGroup) {
    args.push("-g");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? result.stdout };
    }
    return { ok: false, error: result.stderr || "Failed to unsend message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function editMessageOpenzalo(
  params: {
    threadId: string;
    msgId: string;
    cliMsgId: string;
    message: string;
  },
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = [
    "msg",
    "edit",
    params.msgId.trim(),
    params.cliMsgId.trim(),
    params.threadId.trim(),
    clampText(params.message, options),
  ];
  if (options.isGroup) {
    args.push("-g");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? result.stdout };
    }
    return { ok: false, error: result.stderr || "Failed to edit message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function pinConversationOpenzalo(
  threadId: string,
  options: OpenzaloSendOptions & { pinned: boolean } = { pinned: true },
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  const args = ["msg", options.pinned ? "pin" : "unpin", threadId.trim()];
  if (options.isGroup) {
    args.push("-g");
  }
  try {
    const result = await runOpenzca(args, { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? result.stdout };
    }
    return {
      ok: false,
      error: result.stderr || `Failed to ${options.pinned ? "pin" : "unpin"} conversation`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listPinnedConversationsOpenzalo(
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  try {
    const result = await runOpenzca(["msg", "list-pins", "-j"], { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? { raw: result.stdout } };
    }
    return { ok: false, error: result.stderr || "Failed to list pinned conversations" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getMemberInfoOpenzalo(
  userId: string,
  options: OpenzaloSendOptions = {},
): Promise<OpenzaloActionResult> {
  const profile = options.profile || resolveOpenzcaProfileEnv() || "default";
  try {
    const result = await runOpenzca(["msg", "member-info", userId.trim(), "-j"], { profile });
    if (result.ok) {
      return { ok: true, output: parseJsonOutput(result.stdout) ?? { raw: result.stdout } };
    }
    return { ok: false, error: result.stderr || "Failed to get member info" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function extractMessageId(stdout: string): string | undefined {
  // Try to extract message ID from output
  const match = stdout.match(/message[_\s]?id[:\s]+(\S+)/i);
  if (match) {
    return match[1];
  }
  // Return first word if it looks like an ID
  const firstWord = stdout.trim().split(/\s+/)[0];
  if (firstWord && /^[a-zA-Z0-9_-]+$/.test(firstWord)) {
    return firstWord;
  }
  return undefined;
}
