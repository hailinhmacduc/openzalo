import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setOpenzaloRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getOpenzaloRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Openzalo runtime not initialized");
  }
  return runtime;
}
