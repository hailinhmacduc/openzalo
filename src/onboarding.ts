import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  promptAccountId,
  promptChannelAccessConfig,
} from "openclaw/plugin-sdk";
import type { ZcaFriend, ZcaGroup } from "./types.js";
import {
  listOpenzaloAccountIds,
  resolveDefaultOpenzaloAccountId,
  resolveOpenzaloAccountSync,
  checkZcaAuthenticated,
} from "./accounts.js";
import { runOpenzca, runOpenzcaInteractive, checkOpenzcaInstalled, parseJsonOutput } from "./openzca.js";

const channel = "openzalo" as const;

function setOpenzaloDmPolicy(
  cfg: OpenClawConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
): OpenClawConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.openzalo?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      openzalo: {
        ...cfg.channels?.openzalo,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as OpenClawConfig;
}

async function noteOpenzaloHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Zalo Personal Account login via QR code.",
      "",
      "Prerequisites:",
      "1) Install openzca",
      "2) You'll scan a QR code with your Zalo app",
      "",
      "Docs: https://openzca.com/",
    ].join("\n"),
    "Zalo Personal Setup",
  );
}

async function promptOpenzaloAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveOpenzaloAccountSync({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const parseInput = (raw: string) =>
    raw
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

  const resolveUserId = async (input: string): Promise<string | null> => {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }
    const ok = await checkOpenzcaInstalled();
    if (!ok) {
      return null;
    }
    const result = await runOpenzca(["friend", "find", trimmed], {
      profile: resolved.profile,
      timeout: 15000,
    });
    if (!result.ok) {
      return null;
    }
    const parsed = parseJsonOutput<ZcaFriend[]>(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [];
    const match = rows[0];
    if (!match?.userId) {
      return null;
    }
    if (rows.length > 1) {
      await prompter.note(
        `Multiple matches for "${trimmed}", using ${match.displayName ?? match.userId}.`,
        "Zalo Personal allowlist",
      );
    }
    return String(match.userId);
  };

  while (true) {
    const entry = await prompter.text({
      message: "Openzalo allowFrom (username or user id)",
      placeholder: "Alice, 123456789",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseInput(String(entry));
    const results = await Promise.all(parts.map((part) => resolveUserId(part)));
    const unresolved = parts.filter((_, idx) => !results[idx]);
    if (unresolved.length > 0) {
      await prompter.note(
        `Could not resolve: ${unresolved.join(", ")}. Use numeric user ids or ensure openzca is available.`,
        "Zalo Personal allowlist",
      );
      continue;
    }
    const merged = [
      ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
      ...(results.filter(Boolean) as string[]),
    ];
    const unique = [...new Set(merged)];
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          openzalo: {
            ...cfg.channels?.openzalo,
            enabled: true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      } as OpenClawConfig;
    }

    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        openzalo: {
          ...cfg.channels?.openzalo,
          enabled: true,
          accounts: {
            ...cfg.channels?.openzalo?.accounts,
            [accountId]: {
              ...cfg.channels?.openzalo?.accounts?.[accountId],
              enabled: cfg.channels?.openzalo?.accounts?.[accountId]?.enabled ?? true,
              dmPolicy: "allowlist",
              allowFrom: unique,
            },
          },
        },
      },
    } as OpenClawConfig;
  }
}

function setOpenzaloGroupPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  groupPolicy: "open" | "allowlist" | "disabled",
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        openzalo: {
          ...cfg.channels?.openzalo,
          enabled: true,
          groupPolicy,
        },
      },
    } as OpenClawConfig;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      openzalo: {
        ...cfg.channels?.openzalo,
        enabled: true,
        accounts: {
          ...cfg.channels?.openzalo?.accounts,
          [accountId]: {
            ...cfg.channels?.openzalo?.accounts?.[accountId],
            enabled: cfg.channels?.openzalo?.accounts?.[accountId]?.enabled ?? true,
            groupPolicy,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function setOpenzaloGroupAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  groupKeys: string[],
): OpenClawConfig {
  const groups = Object.fromEntries(groupKeys.map((key) => [key, { allow: true }]));
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        openzalo: {
          ...cfg.channels?.openzalo,
          enabled: true,
          groups,
        },
      },
    } as OpenClawConfig;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      openzalo: {
        ...cfg.channels?.openzalo,
        enabled: true,
        accounts: {
          ...cfg.channels?.openzalo?.accounts,
          [accountId]: {
            ...cfg.channels?.openzalo?.accounts?.[accountId],
            enabled: cfg.channels?.openzalo?.accounts?.[accountId]?.enabled ?? true,
            groups,
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function resolveOpenzaloGroups(params: {
  cfg: OpenClawConfig;
  accountId: string;
  entries: string[];
}): Promise<Array<{ input: string; resolved: boolean; id?: string }>> {
  const account = resolveOpenzaloAccountSync({ cfg: params.cfg, accountId: params.accountId });
  const result = await runOpenzca(["group", "list", "-j"], {
    profile: account.profile,
    timeout: 15000,
  });
  if (!result.ok) {
    throw new Error(result.stderr || "Failed to list groups");
  }
  const groups = (parseJsonOutput<ZcaGroup[]>(result.stdout) ?? []).filter((group) =>
    Boolean(group.groupId),
  );
  const byName = new Map<string, ZcaGroup[]>();
  for (const group of groups) {
    const name = group.name?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const list = byName.get(name) ?? [];
    list.push(group);
    byName.set(name, list);
  }

  return params.entries.map((input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      return { input, resolved: false };
    }
    if (/^\d+$/.test(trimmed)) {
      return { input, resolved: true, id: trimmed };
    }
    const matches = byName.get(trimmed.toLowerCase()) ?? [];
    const match = matches[0];
    return match?.groupId
      ? { input, resolved: true, id: String(match.groupId) }
      : { input, resolved: false };
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Zalo Personal",
  channel,
  policyKey: "channels.openzalo.dmPolicy",
  allowFromKey: "channels.openzalo.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.openzalo?.dmPolicy ?? "pairing") as "pairing",
  setPolicy: (cfg, policy) => setOpenzaloDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : resolveDefaultOpenzaloAccountId(cfg);
    return promptOpenzaloAllowFrom({
      cfg: cfg,
      prompter,
      accountId: id,
    });
  },
};

export const openzaloOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const ids = listOpenzaloAccountIds(cfg);
    let configured = false;
    for (const accountId of ids) {
      const account = resolveOpenzaloAccountSync({ cfg: cfg, accountId });
      const isAuth = await checkZcaAuthenticated(account.profile);
      if (isAuth) {
        configured = true;
        break;
      }
    }
    return {
      channel,
      configured,
      statusLines: [`Zalo Personal: ${configured ? "logged in" : "needs QR login"}`],
      selectionHint: configured ? "recommended · logged in" : "recommended · QR login",
      quickstartScore: configured ? 1 : 15,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    // Check openzca is installed
    const openzcaInstalled = await checkOpenzcaInstalled();
    if (!openzcaInstalled) {
      await prompter.note(
        [
          "The `openzca` binary was not found in PATH.",
          "",
          "Install openzca, then re-run onboarding:",
          "Docs: https://openzca.com/",
        ].join("\n"),
        "Missing Dependency",
      );
      return { cfg, accountId: DEFAULT_ACCOUNT_ID };
    }

    const openzaloOverride = accountOverrides.openzalo?.trim();
    const defaultAccountId = resolveDefaultOpenzaloAccountId(cfg);
    let accountId = openzaloOverride ? normalizeAccountId(openzaloOverride) : defaultAccountId;

    if (shouldPromptAccountIds && !openzaloOverride) {
      accountId = await promptAccountId({
        cfg: cfg,
        prompter,
        label: "Zalo Personal",
        currentId: accountId,
        listAccountIds: listOpenzaloAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    const account = resolveOpenzaloAccountSync({ cfg: next, accountId });
    const alreadyAuthenticated = await checkZcaAuthenticated(account.profile);

    if (!alreadyAuthenticated) {
      await noteOpenzaloHelp(prompter);

      const wantsLogin = await prompter.confirm({
        message: "Login via QR code now?",
        initialValue: true,
      });

      if (wantsLogin) {
        await prompter.note(
          "A QR code will appear in your terminal.\nScan it with your Zalo app to login.",
          "QR Login",
        );

        // Run interactive login
        const result = await runOpenzcaInteractive(["auth", "login"], {
          profile: account.profile,
        });

        if (!result.ok) {
          await prompter.note(`Login failed: ${result.stderr || "Unknown error"}`, "Error");
        } else {
          const isNowAuth = await checkZcaAuthenticated(account.profile);
          if (isNowAuth) {
            await prompter.note("Login successful!", "Success");
          }
        }
      }
    } else {
      const keepSession = await prompter.confirm({
        message: "Zalo Personal already logged in. Keep session?",
        initialValue: true,
      });
      if (!keepSession) {
        await runOpenzcaInteractive(["auth", "logout"], { profile: account.profile });
        await runOpenzcaInteractive(["auth", "login"], { profile: account.profile });
      }
    }

    // Enable the channel
    if (accountId === DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          openzalo: {
            ...next.channels?.openzalo,
            enabled: true,
            profile: account.profile !== "default" ? account.profile : undefined,
          },
        },
      } as OpenClawConfig;
    } else {
      next = {
        ...next,
        channels: {
          ...next.channels,
          openzalo: {
            ...next.channels?.openzalo,
            enabled: true,
            accounts: {
              ...next.channels?.openzalo?.accounts,
              [accountId]: {
                ...next.channels?.openzalo?.accounts?.[accountId],
                enabled: true,
                profile: account.profile,
              },
            },
          },
        },
      } as OpenClawConfig;
    }

    if (forceAllowFrom) {
      next = await promptOpenzaloAllowFrom({
        cfg: next,
        prompter,
        accountId,
      });
    }

    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Zalo groups",
      currentPolicy: account.config.groupPolicy ?? "open",
      currentEntries: Object.keys(account.config.groups ?? {}),
      placeholder: "Family, Work, 123456789",
      updatePrompt: Boolean(account.config.groups),
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setOpenzaloGroupPolicy(next, accountId, accessConfig.policy);
      } else {
        let keys = accessConfig.entries;
        if (accessConfig.entries.length > 0) {
          try {
            const resolved = await resolveOpenzaloGroups({
              cfg: next,
              accountId,
              entries: accessConfig.entries,
            });
            const resolvedIds = resolved
              .filter((entry) => entry.resolved && entry.id)
              .map((entry) => entry.id as string);
            const unresolved = resolved
              .filter((entry) => !entry.resolved)
              .map((entry) => entry.input);
            keys = [...resolvedIds, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
            if (resolvedIds.length > 0 || unresolved.length > 0) {
              await prompter.note(
                [
                  resolvedIds.length > 0 ? `Resolved: ${resolvedIds.join(", ")}` : undefined,
                  unresolved.length > 0
                    ? `Unresolved (kept as typed): ${unresolved.join(", ")}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
                "Zalo groups",
              );
            }
          } catch (err) {
            await prompter.note(
              `Group lookup failed; keeping entries as typed. ${String(err)}`,
              "Zalo groups",
            );
          }
        }
        next = setOpenzaloGroupPolicy(next, accountId, "allowlist");
        next = setOpenzaloGroupAllowlist(next, accountId, keys);
      }
    }

    return { cfg: next, accountId };
  },
};
