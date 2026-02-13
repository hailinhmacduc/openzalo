// openzca wrapper types
export type ZcaRunOptions = {
  profile?: string;
  cwd?: string;
  timeout?: number;
};

export type ZcaResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ZcaProfile = {
  name: string;
  label?: string;
  isDefault?: boolean;
};

export type ZcaFriend = {
  userId: string;
  displayName: string;
  avatar?: string;
};

export type ZcaGroup = {
  groupId: string;
  name: string;
  memberCount?: number;
};

export type ZcaMessage = {
  threadId: string;
  msgId?: string;
  cliMsgId?: string;
  type: number;
  content: string;
  timestamp: number;
  metadata?: {
    isGroup: boolean;
    threadName?: string;
    senderName?: string;
    fromId?: string;
  };
};

export type ZcaUserInfo = {
  userId: string;
  displayName: string;
  avatar?: string;
};

export type CommonOptions = {
  profile?: string;
  json?: boolean;
};

export type SendOptions = CommonOptions & {
  group?: boolean;
};

export type ListenOptions = CommonOptions & {
  raw?: boolean;
  keepAlive?: boolean;
  webhook?: string;
  echo?: boolean;
  prefix?: string;
};

export type OpenzaloGroupConfig = {
  allow?: boolean;
  enabled?: boolean;
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  requireMention?: boolean;
};

export type OpenzaloGroupMentionDetectionFailureMode =
  | "allow"
  | "deny"
  | "allow-with-warning";

export type OpenzaloAccountConfig = {
  enabled?: boolean;
  name?: string;
  profile?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, OpenzaloGroupConfig>;
  groupRequireMention?: boolean;
  groupMentionDetectionFailure?: OpenzaloGroupMentionDetectionFailureMode;
  sendFailureNotice?: boolean;
  sendFailureMessage?: string;
  messagePrefix?: string;
  responsePrefix?: string;
};

export type OpenzaloConfig = {
  enabled?: boolean;
  name?: string;
  profile?: string;
  defaultAccount?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, OpenzaloGroupConfig>;
  groupRequireMention?: boolean;
  groupMentionDetectionFailure?: OpenzaloGroupMentionDetectionFailureMode;
  sendFailureNotice?: boolean;
  sendFailureMessage?: string;
  messagePrefix?: string;
  responsePrefix?: string;
  accounts?: Record<string, OpenzaloAccountConfig>;
};

export type ResolvedOpenzaloAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  profile: string;
  authenticated: boolean;
  config: OpenzaloAccountConfig;
};
