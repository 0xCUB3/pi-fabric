// Offline integration against the actual installed SDK and compiled extension.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const scratch = await mkdtemp(path.join(root, ".tmp/pi99-sdk-"));
for (const name of Object.keys(process.env)) if (name.startsWith("PI_FABRIC_")) delete process.env[name];
process.env.PI_CODING_AGENT_DIR = scratch;
process.env.PI_FABRIC_AGENT_DIR = path.join(scratch, "exports");
const host = await import("@earendil-works/pi-coding-agent");
const ai = await import("@earendil-works/pi-ai");
const { Type } = await import("typebox");
assert.equal(host.VERSION, "0.99.0");
assert.equal(typeof host.ExtensionRunner.prototype.getAllRegisteredTools, "function");
assert.equal(typeof host.ExtensionRunner.prototype.createToolContext, "function");
const hostEntry = await realpath(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const hostManifest = JSON.parse(await readFile(path.resolve(path.dirname(hostEntry), "../package.json"), "utf8"));
assert.equal(hostManifest.version, "0.99.0");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let scenarios = 0;
try {
  for (const [mode, fullCodeMode, schemaMode] of [["on", true, "off"], ["only", true, "off"], ["only", false, "enforce"]]) {
    const cwd = path.join(scratch, `session-${scenarios}`);
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(scratch, "fabric.json"), JSON.stringify({
      fullCodeMode, schema: { mode: schemaMode }, capture: { keepVisible: ["fixture_echo"] },
      approvals: { read: "allow", write: "allow", execute: "allow" },
      mcp: { enabled: false }, mesh: { enabled: false }, memory: { enabled: false },
      agents: { enabled: false }, entropy: { enabled: false, compile: false }, ui: { enabled: false },
    }));
    const settingsManager = host.SettingsManager.inMemory({
      defaultTools: ["+codemode", "+tool_search"], defaultProjectTrust: "never",
      compaction: { enabled: false }, retry: { enabled: false },
    });
    const requests = [], events = [], errors = [];
    let api, toolContext, nextCode, calls = 0, preparations = 0;
    const fixtureTool = (name, exposure = "direct") => ({
      name, label: name, description: "Offline proxy fixture", exposure,
      parameters: Type.Object({ value: Type.String() }), outputSchema: Type.Object({ value: Type.String() }),
      async execute(_id, args, _signal, onUpdate, ctx) {
        toolContext = ctx; calls++;
        if (args.value === "mutate") api.setActiveTools(["read", "codemode", "tool_search"]);
        onUpdate?.({ content: [{ type: "text", text: "progress" }], details: {} });
        return { content: [{ type: "text", text: `echo:${args.value}` }], structuredContent: { value: args.value }, details: { value: args.value } };
      },
    });
    const loader = new host.DefaultResourceLoader({
      cwd, agentDir: scratch, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [path.join(root, "dist/index.js")], agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [host.createCodemodeExtension({ mode }), host.createToolSearchExtension(), host.createMcpExtension(), (pi) => {
        api = pi;
        pi.registerTool(fixtureTool("fixture_echo"));
        pi.registerTool(fixtureTool("fixture_deferred", "deferred"));
        pi.registerTool(fixtureTool("fixture_hidden", "hidden"));
        pi.registerTool({
          name: "fixture_prepare", label: "Prepared", description: "Prepare exactly once", parameters: Type.Object({ value: Type.String() }),
          prepareArguments(args) { preparations++; return { value: `${args.value}!` }; },
          async execute(_id, args, _signal, _update, ctx) {
            assert.equal(typeof ctx.executeTool, "function");
            return { content: [{ type: "text", text: args.value }], details: {} };
          },
        });
        pi.registerMcpServer("fixture", { command: process.execPath, args: [path.join(root, "tests/fixtures/pi99-mcp.mjs")], exposure: "codemode" });
        pi.on("tool_call", (event) => {
          events.push(event);
          if (event.toolName === "fixture_echo" && event.input.value === "block") return { block: true, reason: "fixture denied" };
          if (event.toolName === "fixture_echo" && event.input.value === "rewrite") event.input.value = "rewritten";
        });
        pi.on("tool_result", (event) => {
          events.push(event);
          if (event.toolName === "fixture_echo" && !event.isError) return { content: [{ type: "text", text: "redacted" }], structuredContent: { value: "redacted" } };
        });
        pi.on("session_start", () => pi.registerTool(fixtureTool("fixture_start")));
        pi.registerProvider("offline-pi99", {
          api: "offline-pi99", apiKey: "offline-fixture", baseUrl: "http://invalid.local",
          models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
          streamSimple(model, context) {
            requests.push(context);
            assert.deepEqual(ai.getCurrentTools(context.messages).map((tool) => tool.name), ["fabric_exec"]);
            assert.ok(ai.getCurrentSystemPrompt(context.messages).includes("fabric_exec"));
            const code = nextCode; nextCode = undefined;
            const message = { role: "assistant", content: code ? [{ type: "toolCall", id: `outer-${requests.length}`, name: "fabric_exec", arguments: { code } }] : [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "pending", timestamp: Date.now() };
            const stream = ai.createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            message.stopReason = code ? "toolUse" : "stop";
            stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); return stream;
          },
        });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await host.ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, modelsStorePath: path.join(cwd, "models-cache.json"), refreshOnCreate: false });
    const { session } = await host.createAgentSession({ cwd, agentDir: scratch, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: host.SessionManager.inMemory(cwd) });
    session.extensionRunner.onError((error) => errors.push(error));
    try {
      await session.bindExtensions({});
      const model = modelRuntime.getModel("offline-pi99", "fixture"); assert.ok(model);
      await session.setModel(model);
      assert.equal(session.getToolDefinition("fabric_exec").exposure, "model-only");
      assert.equal(session.getAllTools().find((t) => t.name === "fixture_hidden").exposure, "hidden");
      await session.prompt("Verify initial loadout.");
      assert.ok(session.getAllTools().some((t) => t.name === "mcp__fixture__echo"), "native MCP connected");
      api.registerTool(fixtureTool("fixture_late"));
      api.setActiveTools(["read", "fixture_echo", "fixture_late", "codemode", "tool_search", "mcp__fixture__echo"]);
      await session.prompt("Verify explicit replacement without fabric_exec is repaired.");
      if (fullCodeMode) {
        nextCode = 'const a = await extensions.fixture_echo({value:"rewrite"}); const b = await extensions.fixture_deferred({value:"deferred"}); const c = await extensions.mcp__fixture__echo({value:"native"}); const d = await extensions.tool_search({query:"fixture_deferred"}); return {a,b,c,d};';
        await session.prompt("Exercise captured tools through fabric_exec.");
        const result = session.messages.findLast((m) => m.role === "toolResult" && m.toolName === "fabric_exec");
        assert.equal(result?.isError, false, JSON.stringify(result));
        assert.match(JSON.stringify(result.content), /redacted/);
        assert.match(JSON.stringify(result.content), /mcp:native/);
        assert.equal(calls, 2);
        assert.ok(api.getActiveTools().includes("fixture_deferred"), "native tool_search activated the deferred tool");
        assert.equal(typeof toolContext.executeTool, "function");
        assert.ok(toolContext.tools.some((t) => t.name === "fixture_echo"));
        assert.ok(events.some((e) => e.toolName === "fixture_echo" && e.parentToolCallId?.startsWith("outer-")));
        assert.ok(result.nestedCalls?.calls?.length >= 3, JSON.stringify(result.nestedCalls));
        nextCode = 'return await extensions.fixture_prepare({value:"once"});';
        await session.prompt("Prepare captured arguments once, before approval and execution.");
        assert.equal(preparations, 1);
        assert.match(JSON.stringify(session.messages.findLast((m) => m.role === "toolResult")?.content), /once!/);
        nextCode = 'return await pi.bash({command:"printf shell-output; exit 7",settle:true});';
        await session.prompt("Settle native structured nonzero exit through Fabric.");
        const shellResult = session.messages.findLast((m) => m.role === "toolResult");
        assert.equal(shellResult?.isError, false, JSON.stringify(shellResult));
        assert.match(JSON.stringify(shellResult.content), /shell-output/);
        assert.match(JSON.stringify(shellResult.content), /exitCode[^0-9]*7/);
        nextCode = 'return await extensions.fixture_echo({value:"block"});';
        await session.prompt("Exercise native permission rejection.");
        assert.equal(calls, 2);
        assert.equal(session.messages.findLast((m) => m.role === "toolResult")?.isError, true);
        api.registerTool(fixtureTool("fixture_deferred", "hidden"));
        nextCode = 'return await extensions.fixture_deferred({value:"withdrawn"});';
        await session.prompt("Withdrawn tool must not execute.");
        assert.equal(calls, 2);
        assert.equal(session.messages.findLast((m) => m.role === "toolResult")?.isError, true);
      }
      if (fullCodeMode) {
        nextCode = 'return await extensions.fixture_echo({value:"mutate"});';
        await session.prompt("Reassert ownership after a mid-turn setActiveTools removes Fabric.");
        assert.equal(calls, 3);
        assert.equal(session.messages.findLast((m) => m.role === "toolResult")?.isError, false);
      }
      const oldRunner = session.extensionRunner;
      await session.reload();
      assert.notEqual(session.extensionRunner, oldRunner);
      await session.prompt("Verify reload retains one model tool.");
      assert.deepEqual(errors, []);
      assert.ok(requests.length >= 3);
      scenarios++;
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
  }
  await writeFile(path.join(scratch, "fabric.json"), JSON.stringify({ fullCodeMode: true, approvals: { read: "allow", write: "allow", execute: "allow" }, mcp: { enabled: false }, mesh: { enabled: false }, memory: { enabled: false }, agents: { enabled: false }, entropy: { compile: false }, ui: { enabled: false } }));
  const cli = path.resolve(path.dirname(hostEntry), "..", hostManifest.bin.pi);
  const cliRun = promisify(execFile)(process.execPath, [cli, "--mode", "json", "--no-session", "--no-extensions", "-e", path.join(root, "dist/index.js"), "-e", path.join(root, "tests/fixtures/pi99-cli-extension.mjs"), "-e", "builtin:codemode", "-e", "builtin:tool-search", "--tools", "read,bash,fabric_exec,codemode,tool_search", "--provider", "offline-cli", "--model", "fixture", "-p", "Offline smoke"], { cwd: scratch, timeout: 30_000, maxBuffer: 4_000_000, env: process.env });
  // Print mode reads piped stdin before starting; close it (no fixture input).
  cliRun.child.stdin.end();
  const { stdout, stderr } = await cliRun;
  assert.match(stdout, /cli-capture-ok/); assert.match(stdout, /cli-smoke-ok/);
  assert.ok(!stderr.includes("Failed to load extension"), stderr);
  const cliEvents = stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  assert.ok(cliEvents.some((event) => event.type === "tool_execution_end" && event.toolName === "fabric_exec" && !event.isError));
  console.log(JSON.stringify({ version: host.VERSION, hostEntry, scenarios, exclusive: true, proxy: true, reload: true, cli: true }));
} finally { await rm(scratch, { recursive: true, force: true }); }
