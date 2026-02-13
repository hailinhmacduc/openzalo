import type { ZcaUserInfo } from "./types.js";
import { runOpenzca, parseJsonOutput } from "./openzca.js";

export interface OpenzaloProbeResult {
  ok: boolean;
  user?: ZcaUserInfo;
  error?: string;
}

export async function probeOpenzalo(
  profile: string,
  timeoutMs?: number,
): Promise<OpenzaloProbeResult> {
  const result = await runOpenzca(["me", "info", "-j"], {
    profile,
    timeout: timeoutMs,
  });

  if (!result.ok) {
    return { ok: false, error: result.stderr || "Failed to probe" };
  }

  const user = parseJsonOutput<ZcaUserInfo>(result.stdout);
  if (!user) {
    return { ok: false, error: "Failed to parse user info" };
  }
  return { ok: true, user };
}
