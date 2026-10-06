// Worker-only: keep module hooks out of Fabric's registration graph.
import module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostModulePaths } from "../host-package.js";

/**
 * Pi-managed installs omit host peers (`@earendil-works/pi-coding-agent`,
 * `pi-agent-core`, `pi-ai`, ...), so a standalone durable worker cannot import
 * them by name. Resolve what this install lacks from the running host Pi at
 * `packageRoot`, the way NODE_PATH would. Node ignores NODE_PATH for ESM, so it
 * gets a resolve hook. Bun has no resolve hooks but reads NODE_PATH at
 * startup, so the launcher sets it through `hostPeerNodePath`.
 */
export const installHostPeerFallback = (packageRoot: string): void => {
  // Nested Fabric managers in this worker locate the same host.
  process.env.PI_PACKAGE_DIR ??= packageRoot;
  if (process.versions.bun) {
    // Bun has already read NODE_PATH. Hand tool subprocesses the caller's value.
    const prefix = hostModulePaths(packageRoot);
    const parts = (process.env.NODE_PATH ?? "").split(path.delimiter);
    if (prefix.length > 0 && prefix.every((entry, index) => parts[index] === entry)) {
      const rest = parts.slice(prefix.length).join(path.delimiter);
      if (rest) process.env.NODE_PATH = rest;
      else delete process.env.NODE_PATH;
    }
    return;
  }
  const hostParentURL = pathToFileURL(path.join(packageRoot, "package.json")).href;
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if ((error as { code?: unknown }).code !== "ERR_MODULE_NOT_FOUND") throw error;
        try {
          return nextResolve(specifier, { ...context, parentURL: hostParentURL });
        } catch {
          throw error;
        }
      }
    },
  });
};
