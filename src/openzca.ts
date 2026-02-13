import { spawn, type SpawnOptions } from "node:child_process";
import { stripAnsi } from "openclaw/plugin-sdk";
import type { ZcaResult, ZcaRunOptions } from "./types.js";

const PRIMARY_OPENZCA_BINARY = process.env.OPENZCA_BINARY?.trim() || "openzca";
const DEFAULT_TIMEOUT = 30000;

type ErrorWithCode = Error & { code?: string | number };
type ZcaChildProcess = ReturnType<typeof spawn>;
type OpenzcaSpawnResult = { proc: ZcaChildProcess; binary: string };

export function resolveOpenzcaProfileEnv(): string | undefined {
  const fromOpenzca = process.env.OPENZCA_PROFILE?.trim();
  if (fromOpenzca) {
    return fromOpenzca;
  }
  return process.env.ZCA_PROFILE?.trim();
}

function resolveOpenzcaBinaries(): string[] {
  const primary = PRIMARY_OPENZCA_BINARY || "openzca";
  return [primary];
}

function isNotFoundError(error: unknown): boolean {
  const code = (error as ErrorWithCode)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function createOpenzcaProcess(
  binary: string,
  args: string[],
  options: SpawnOptions,
): Promise<ZcaChildProcess> {
  return new Promise((resolve, reject) => {
    let proc: ZcaChildProcess;

    try {
      proc = spawn(binary, args, options);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const onSpawn = () => {
      proc.removeListener("error", onError);
      resolve(proc);
    };

    const onError = (error: Error) => {
      proc.removeListener("spawn", onSpawn);
      reject(error);
    };

    proc.once("spawn", onSpawn);
    proc.once("error", onError);
  });
}

async function spawnOpenzcaProcess(
  args: string[],
  options: SpawnOptions,
): Promise<OpenzcaSpawnResult> {
  const candidates = resolveOpenzcaBinaries();
  let lastError: Error | null = null;

  for (const binary of candidates) {
    try {
      const proc = await createOpenzcaProcess(binary, args, options);
      return { proc, binary };
    } catch (error) {
      if (isNotFoundError(error)) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error(`No working openzca binary found. Tried: ${candidates.join(", ")}`);
}

function buildArgs(args: string[], options?: ZcaRunOptions): string[] {
  const result: string[] = [];
  const profile = options?.profile || resolveOpenzcaProfileEnv();
  if (profile) {
    result.push("--profile", profile);
  }
  result.push(...args);
  return result;
}

export async function runOpenzca(args: string[], options?: ZcaRunOptions): Promise<ZcaResult> {
  const fullArgs = buildArgs(args, options);
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: options?.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    };

    spawnOpenzcaProcess(fullArgs, spawnOpts)
      .then(({ proc }) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
        }, timeout);

        proc.stdout?.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on("close", (code) => {
          clearTimeout(timer);
          if (timedOut) {
            resolve({
              ok: false,
              stdout,
              stderr: stderr || "Command timed out",
              exitCode: code ?? 124,
            });
            return;
          }
          resolve({
            ok: code === 0,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: code ?? 1,
          });
        });

        proc.on("error", (err) => {
          clearTimeout(timer);
          resolve({
            ok: false,
            stdout: "",
            stderr: err.message,
            exitCode: 1,
          });
        });
      })
      .catch((err) => {
        resolve({
          ok: false,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        });
      });
  });
}

export function runOpenzcaInteractive(args: string[], options?: ZcaRunOptions): Promise<ZcaResult> {
  const fullArgs = buildArgs(args, options);

  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: options?.cwd,
      env: { ...process.env },
      stdio: "inherit",
    };

    spawnOpenzcaProcess(fullArgs, spawnOpts)
      .then(({ proc }) => {
        proc.on("close", (code) => {
          resolve({
            ok: code === 0,
            stdout: "",
            stderr: "",
            exitCode: code ?? 1,
          });
        });

        proc.on("error", (err) => {
          resolve({
            ok: false,
            stdout: "",
            stderr: err.message,
            exitCode: 1,
          });
        });
      })
      .catch((err) => {
        resolve({
          ok: false,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        });
      });
  });
}

export async function checkOpenzcaInstalled(): Promise<boolean> {
  const result = await runOpenzca(["--version"], { timeout: 5000 });
  return result.ok;
}

export type OpenzcaStreamingOptions = ZcaRunOptions & {
  onData?: (data: string) => void;
  onError?: (err: Error) => void;
};

export async function runOpenzcaStreaming(
  args: string[],
  options?: OpenzcaStreamingOptions,
): Promise<{ proc: ReturnType<typeof spawn>; promise: Promise<ZcaResult> }> {
  const fullArgs = buildArgs(args, options);

  const spawnOpts: SpawnOptions = {
    cwd: options?.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  };

  let stdout = "";
  let stderr = "";
  const { proc } = await spawnOpenzcaProcess(fullArgs, spawnOpts);

  const promise = new Promise<ZcaResult>((resolve) => {
    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      options?.onData?.(text);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      options?.onError?.(err);
      resolve({
        ok: false,
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });

  return { proc, promise };
}

export function parseJsonOutput<T>(stdout: string): T | null {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    const cleaned = stripAnsi(stdout);

    try {
      return JSON.parse(cleaned) as T;
    } catch {
      const lines = cleaned.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("{") || line.startsWith("[")) {
          const jsonCandidate = lines.slice(i).join("\n").trim();
          try {
            return JSON.parse(jsonCandidate) as T;
          } catch {
            continue;
          }
        }
      }
      return null;
    }
  }
}
