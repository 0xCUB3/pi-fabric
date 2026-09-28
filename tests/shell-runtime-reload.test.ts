import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import { FABRIC_SHELL_TIMING_EVENT } from "../src/protocol.js";

describe("shell store runtime reinitialization", () => {
  it("bridges each owning session and closes spans on reload and shutdown", async () => {
    const emit = vi.fn();
    const runtime = new FabricRuntimeState({ events: { emit } } as unknown as ExtensionAPI, new CapturedToolCatalog());
    const context = {
      sessionManager: { getSessionId: () => "owner" },
      ui: { setStatus: () => { throw new Error("context checkpoint"); } },
    } as unknown as ExtensionContext;
    try {
      await expect(runtime.initialize(context)).rejects.toThrow("context checkpoint");
      const old = runtime.shellJobs;
      const a = old.begin("bash", "a"); a.spill();
      await expect(runtime.initialize(context)).rejects.toThrow("context checkpoint");
      const b = runtime.shellJobs.begin("bash", "b"); b.spill();
      await runtime.shutdown();
      expect(emit.mock.calls).toEqual([
        [FABRIC_SHELL_TIMING_EVENT, expect.objectContaining({ sessionId: "owner", taskId: a.id, phase: "started" })],
        [FABRIC_SHELL_TIMING_EVENT, expect.objectContaining({ taskId: a.id, phase: "finished" })],
        [FABRIC_SHELL_TIMING_EVENT, expect.objectContaining({ sessionId: "owner", taskId: b.id, phase: "started" })],
        [FABRIC_SHELL_TIMING_EVENT, expect.objectContaining({ taskId: b.id, phase: "finished" })],
      ]);
    } finally { await runtime.shutdown(); }
  });
  it("retires old job handles and creates a writable store on each initialization attempt", async () => {
    const runtime = new FabricRuntimeState({} as ExtensionAPI, new CapturedToolCatalog());
    // Stop at the first contextual operation, after the real teardown/reset path.
    const context = { ui: { setStatus: () => { throw new Error("context checkpoint"); } } } as unknown as ExtensionContext;
    try {
      const old = runtime.shellJobs;
      const job = old.begin("bash", "old command"); job.spill();
      const events = vi.fn(); old.subscribe(events);
      await expect(runtime.initialize(context)).rejects.toThrow("context checkpoint");
      expect(job.abort.signal.aborted).toBe(true);
      expect(events).not.toHaveBeenCalled();
      expect(runtime.shellJobs).not.toBe(old);
      expect(() => old.begin("bash", "stale caller")).toThrow("closed");
      const next = runtime.shellJobs;
      expect(next.list()).toEqual([]);
      expect(() => next.begin("bash", "new command")).not.toThrow();
      await expect(runtime.initialize(context)).rejects.toThrow("context checkpoint");
      expect(runtime.shellJobs).not.toBe(next);
      expect(() => runtime.shellJobs.begin("bash", "newer command")).not.toThrow();
    } finally { await runtime.shutdown(); }
  });
});
