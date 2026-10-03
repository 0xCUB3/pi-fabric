import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fullDefault = vi.hoisted(() => vi.fn());

vi.mock("../src/index.js", () => ({ default: fullDefault }));

const REAL_EXEC_SLOT = Symbol.for("pi-fabric.real-exec.v1");
const PENDING_SESSION_SLOT = Symbol.for("pi-fabric.pending-session.v1");
const FULL_READY_SLOT = Symbol.for("pi-fabric.full-ready.v1");

const clearSlots = (): void => {
  const g = globalThis as unknown as Record<symbol, unknown>;
  delete g[REAL_EXEC_SLOT];
  delete g[PENDING_SESSION_SLOT];
  delete g[FULL_READY_SLOT];
};

type Handler = (event: unknown, context: unknown) => unknown;

const makePi = () => {
  const handlers = new Map<string, Handler[]>();
  const registerTool = vi.fn();
  const registerCommand = vi.fn();
  const pi = {
    registerTool,
    registerCommand,
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    }),
    getAllTools: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
  } as unknown as ExtensionAPI;
  return { pi, handlers, registerTool, registerCommand };
};

beforeEach(() => {
  vi.resetModules();
  clearSlots();
  fullDefault.mockReset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearSlots();
});

describe("extension bootstrap startup", () => {
  it("registers the fabric stub without loading the full extension", async () => {
    vi.stubEnv("PI_FABRIC_EAGER", "0");
    const bootstrap = await import("../src/extension-bootstrap.js");
    const { pi, registerTool, registerCommand } = makePi();
    await bootstrap.default(pi, {});
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[0]).toMatchObject({ name: "fabric_exec" });
    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand.mock.calls[0]?.[0]).toBe("fabric");
    expect(fullDefault).not.toHaveBeenCalled();
  });

  it("loads the full extension eagerly in the background by default", async () => {
    fullDefault.mockImplementation(async () => {});
    const bootstrap = await import("../src/extension-bootstrap.js");
    const { pi } = makePi();
    await bootstrap.default(pi, {});
    await vi.waitFor(() => expect(fullDefault).toHaveBeenCalledTimes(1), { timeout: 15000 });
  });

  it("activates the full extension on first session start and delegates calls", async () => {
    vi.stubEnv("PI_FABRIC_EAGER", "0");
    const realExecute = vi.fn(async () => "real-result");
    fullDefault.mockImplementation(async (pi: ExtensionAPI) => {
      pi.registerTool({ name: "fabric_exec", execute: realExecute } as never);
    });
    const bootstrap = await import("../src/extension-bootstrap.js");
    const { pi, handlers, registerTool } = makePi();
    await bootstrap.default(pi, {});
    const sessionStart = handlers.get("session_start") ?? [];
    expect(sessionStart).toHaveLength(1);
    await sessionStart[0]?.({}, { id: "s1" });
    expect(fullDefault).toHaveBeenCalledTimes(1);
    const stubTool = registerTool.mock.calls[0]?.[0] as unknown as {
      execute: (...args: never[]) => Promise<unknown>;
    };
    await expect(stubTool.execute()).resolves.toBe("real-result");
    expect(realExecute).toHaveBeenCalledTimes(1);
    await sessionStart[0]?.({}, { id: "s2" });
    expect(fullDefault).toHaveBeenCalledTimes(1);
  });

  it("stashes a pending session when activation races session start", async () => {
    vi.stubEnv("PI_FABRIC_EAGER", "0");
    fullDefault.mockImplementation(async () => {});
    const bootstrap = await import("../src/extension-bootstrap.js");
    const { pi, handlers } = makePi();
    await bootstrap.default(pi, {});
    const context = { id: "pending" };
    await handlers.get("session_start")?.[0]?.({}, context);
    const g = globalThis as unknown as Record<symbol, unknown>;
    expect(g[PENDING_SESSION_SLOT]).toMatchObject({ context });
  });
});
