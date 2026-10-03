// Thin extension entry for fast Pi startup.
// The full Fabric extension (src/index.ts) statically pulls about 60 modules
// (entropy, compaction, UI renderers, runtimes). Evaluating that graph costs
// roughly 380ms of import plus 320ms of factory work on the startup path.
// This bootstrap keeps the startup graph to two tiny static imports
// (jev auth, typebox schema). It registers a compatible fabric_exec stub
// plus the fabric command immediately, then loads the full implementation
// in the background and swaps the stub for the real tool.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricManagedHostOptions } from "./managed-host.js";

export const FABRIC_MANAGED_HOST_VERSION = 1;
export type { FabricManagedHostOptions } from "./managed-host.js";

const REAL_EXEC_SLOT = Symbol.for("pi-fabric.real-exec.v1");
const PENDING_SESSION_SLOT = Symbol.for("pi-fabric.pending-session.v1");
const FULL_READY_SLOT = Symbol.for("pi-fabric.full-ready.v1");

type FullModule = typeof import("./index.js");

const getGlobal = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

function fullReady(): Promise<FullModule> {
  const existing = getGlobal()[FULL_READY_SLOT] as Promise<FullModule> | undefined;
  if (existing) return existing;
  const pending = import("./index.js") as Promise<FullModule>;
  getGlobal()[FULL_READY_SLOT] = pending;
  pending.catch(() => {
    if (getGlobal()[FULL_READY_SLOT] === pending) delete getGlobal()[FULL_READY_SLOT];
  });
  return pending;
}

async function getRealExecTool(): Promise<{ execute: (...args: never[]) => unknown }> {
  await fullReady();
  for (let i = 0; i < 100; i++) {
    const real = getGlobal()[REAL_EXEC_SLOT] as { execute: (...args: never[]) => unknown } | undefined;
    if (real) return real;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Fabric is still loading; please retry this call.");
}

const STUB_DESCRIPTION = "Execute type-checked TypeScript through Fabric configured executor for Pi core tools, MCP, Fabric providers, discovery, and extensions. QuickJS is isolated by default; the optional Node/Bun process is an unsafe trusted-code escape hatch. In full code mode, and always in Schema enforce mode, this is the exclusive model tool path.";

export default async function piFabricBootstrap(pi: ExtensionAPI, options: { managedHost?: FabricManagedHostOptions } = {}): Promise<void> {
  let activated = false;
  let activating: Promise<void> | undefined;
  const ensureFull = (pendingSession?: { event: unknown; context: unknown }): Promise<void> => {
    if (pendingSession && !getGlobal()[PENDING_SESSION_SLOT]) getGlobal()[PENDING_SESSION_SLOT] = pendingSession;
    const origRegisterTool = pi.registerTool.bind(pi);
    const wrappedRegisterTool = ((tool: unknown) => {
      const named = tool as { name?: unknown };
      if (named && named.name === "fabric_exec") getGlobal()[REAL_EXEC_SLOT] = tool;
      return (origRegisterTool as (t: unknown) => unknown)(tool);
    }) as typeof pi.registerTool;
    activating ??= (async () => {
      const full = await fullReady();
      (pi as { registerTool: unknown }).registerTool = wrappedRegisterTool;
      try {
        await full.default(pi, options);
      } finally {
        (pi as { registerTool: unknown }).registerTool = origRegisterTool;
      }
      activated = true;
    })().catch((error: unknown) => {
      activating = undefined;
      console.warn(`[pi-fabric] background activation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return activating;
  };
  const stubTool = {
    name: "fabric_exec",
    exposure: "model-only",
    label: "Fabric",
    description: STUB_DESCRIPTION,
    promptSnippet: "Pi core tools, MCP, Fabric providers, discovery, and extensions",
    promptGuidelines: ["Batch independent operations in one fabric_exec program. Return only the compact final value."],
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "TypeScript function body. Top-level await and return are supported." },
        payloads: { type: "object" },
        resultFormat: { type: "string" },
        agentBudget: { type: "number" },
        timeoutMs: { type: "number" },
        display: { type: "string" },
      },
      required: ["code"],
    },
    prepareArguments: (args: unknown) => args,
    execute: async (...args: never[]) => {
      const real = await getRealExecTool();
      return real.execute(...args);
    },
  };
  pi.registerTool(stubTool as never);
  pi.registerCommand("fabric", {
    description: "Open Fabric dashboard, chat or tasks, arm prewalk, reload, or manage agents and actors",
    handler: async () => {
      await ensureFull();
      return "Fabric finished loading; please re-run the fabric subcommand.";
    },
  } as never);
  pi.on("session_start", async (event, context) => {
    if (activated) return;
    await ensureFull({ event, context: context as ExtensionContext });
  });
  if (process.env.PI_FABRIC_EAGER !== "0") void ensureFull();
}
