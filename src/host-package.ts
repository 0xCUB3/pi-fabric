import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

const isPiManifest = (manifestPath: string): boolean => {
  if (!existsSync(manifestPath)) return false;
  try {
    return (JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown }).name === PI_PACKAGE_NAME;
  } catch {
    return false; // unreadable or invalid manifest; keep searching
  }
};

const piPackageRootAbove = (startDirectory: string): string | undefined => {
  let directory = startDirectory;
  while (directory !== path.dirname(directory)) {
    if (isPiManifest(path.join(directory, "package.json"))) return directory;
    directory = path.dirname(directory);
  }
  return undefined;
};

const entryDirectory = (): string | undefined => {
  const cliPath = process.argv[1];
  if (!cliPath) return undefined;
  try {
    return path.dirname(realpathSync(cliPath));
  } catch {
    return undefined;
  }
};

// Embedded hosts (pi-web sessiond, SDK embeds) instantiate ExtensionRunner from
// their own node_modules copy while this extension runs from a separate package
// realm. Locating the host's copy through the process entry's module search
// path finds the very package the host runs.
const entryRealmPackageRoot = (directory: string): string | undefined => {
  // The package exports map is ESM-only, so plain resolve() fails with
  // ERR_PACKAGE_PATH_NOT_EXPORTED; resolve.paths() lists the node_modules
  // directories Node would search regardless of exports.
  const searchPaths = createRequire(path.join(directory, "probe.js")).resolve.paths(PI_PACKAGE_NAME);
  for (const searchPath of searchPaths ?? []) {
    if (isPiManifest(path.join(searchPath, PI_PACKAGE_NAME, "package.json"))) {
      return path.join(searchPath, PI_PACKAGE_NAME);
    }
  }
  return undefined;
};

/** node_modules directories Node searches from the host package. */
export const hostModulePaths = (packageRoot: string): string[] =>
  createRequire(path.join(packageRoot, "package.json")).resolve.paths(PI_PACKAGE_NAME) ?? [];

/** NODE_PATH that lets a Bun durable worker fall back to the host's packages. */
export const hostPeerNodePath = (packageRoot: string, current = ""): string =>
  [...hostModulePaths(packageRoot), ...current.split(path.delimiter)].filter(Boolean).join(path.delimiter);

/**
 * Package roots of the running Pi host, most authoritative first:
 * `PI_PACKAGE_DIR`, the package containing the process entry, then the copy
 * the entry's module search path resolves.
 */
export const hostPackageRoots = (): string[] => {
  const directory = entryDirectory();
  return [...new Set(
    [
      process.env.PI_PACKAGE_DIR,
      directory && piPackageRootAbove(directory),
      directory && entryRealmPackageRoot(directory),
    ].filter((root): root is string => typeof root === "string" && Boolean(root)),
  )];
};
