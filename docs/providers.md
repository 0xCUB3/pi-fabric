# External providers

Fabric [captures normal `pi.registerTool()` tools automatically](configuration.md#captured-extension-tools). Extensions use the versioned provider protocol for non-tool capabilities or virtual action catalogs with risk data.

Fabric mounts each non-kernel first-party provider through a pinned component. External providers can use direct registration with a host-owned lifetime. A provider that belongs to a supervised external component calls `context.provide()` for staged publication and rolling replacement. The same component link controls dependency withdrawal.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_PROVIDER_DISCOVER_EVENT,
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricProvider,
  type FabricProviderDiscovery,
} from "pi-fabric/protocol";

export default function extension(pi: ExtensionAPI) {
  const provider: FabricProvider = {
    name: "example",
    description: "Example actions",
    async list() {
      return [];
    },
    async describe() {
      return undefined;
    },
    async invoke() {
      return null;
    },
  };

  pi.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, {
    version: 1,
    provider,
    overwrite: true,
  });

  pi.events.on(FABRIC_PROVIDER_DISCOVER_EVENT, (event: FabricProviderDiscovery) => {
    event.register(provider, { overwrite: true });
  });
}
```

Each provider owns its schemas, its state, and how its actions execute. Pi Fabric validates arguments, enforces the declared risk policy, records nested-call audits, and propagates cancellation. A provider can also enrich the generic [activity surface](interface.md#data-driven-activity) without registering a TUI component:

```ts
async invoke(actionName, args, context) {
  context.activity?.({ type: "entity", id: job.id, kind: "custom", name: job.name });
  context.activity?.({ type: "progress", message: "Indexing package 3/12" });
  context.activity?.({ type: "metrics", tokens: 4200, toolCalls: 9 });
  return job.result;
}
```

## Withdrawing a direct registration

An extension withdraws a provider it registered directly by emitting `FABRIC_PROVIDER_WITHDRAW_EVENT` (`pi-fabric:provider:withdraw:v1`):

```ts
import { FABRIC_PROVIDER_WITHDRAW_EVENT, type FabricProviderWithdrawalV1 } from "pi-fabric/protocol";

pi.events.emit(FABRIC_PROVIDER_WITHDRAW_EVENT, { name: "example" } satisfies FabricProviderWithdrawalV1);
```

Fabric retires the current binding and drops its owner hold, the same path a component lease takes. New calls to `example.*` are refused immediately. Work already admitted and committed capability views that pinned the old generation drain under the [retained-generation rules](provider-capabilities.md#capability-views). The extension owns the provider instance, so Fabric does not call `close()` on withdrawal. Fabric also forgets the registration and does not remount it on reload; an extension that answers `FABRIC_PROVIDER_DISCOVER_EVENT` must stop registering there too. Register again with `FABRIC_PROVIDER_REGISTER_EVENT` at any time.

Optional `generation` pins the withdrawal to one binding: a number matches the binding generation, a string matches the provider binding id (`providerBindingId` in a committed view). Unknown names, generation mismatches, component-owned providers, and managed-host providers are ignored; set `PI_FABRIC_DEBUG=1` to log ignored withdrawals. Component-owned providers withdraw through their component lifecycle.

## Tool placement query

Extensions that need to know where a tool is reachable this turn can ask synchronously with `FABRIC_TOOL_PLACEMENT_EVENT` (`pi-fabric:tool-placement:v1`), so they need not guess from Fabric's mode:

```ts
import {
  FABRIC_TOOL_PLACEMENT_EVENT,
  type FabricToolPlacementRequestV1,
  type FabricToolPlacementResultV1,
} from "pi-fabric/protocol";

let placement: FabricToolPlacementResultV1 | undefined;
pi.events.emit(FABRIC_TOOL_PLACEMENT_EVENT, {
  tools: ["my_tool", "read"],
  reply: (result) => { placement = result; },
} satisfies FabricToolPlacementRequestV1);
// placement === undefined: Fabric is not loaded.
// placement.tools.my_tool: "model" | "program" | "unavailable"
```

The reply is `{ version: 1, mode, tools }`. `mode` is `"full-code"`, `"enforce"` (Schema enforce), or `"orchestration"`. Each tool maps to:

- `model`: declared to the model this turn. Exclusive modes declare only `fabric_exec`; orchestration declares Pi's active set.
- `program`: callable from a `fabric_exec` program, as `pi.<tool>` for Pi core tools or `extensions.<tool>` for captured extension tools. Requires an initialized Fabric runtime and respects child tool allowlists. Schema enforce exposes no `extensions.*` namespace.
- `unavailable`: neither.

`model` wins when both apply. Omitting `tools` reports every tool registered with Pi; at most 1,024 names of up to 256 characters each are accepted. An invalid query gets no reply. Placement describes state at the time of the query. A later mode change, reload, or tool refresh can change it, so query when you need the answer and do not cache it.

## Invocation costs and guarantees

| Access pattern | Work and allocation | Guarantees |
| --- | --- | --- |
| Known direct call, such as `memory.recall(args)` | Avoids an explicit discovery round trip; arguments/results still cross the host bridge | Same registry validation, committed capability binding where applicable, approvals, audit, and cancellation |
| `tools.search` / `tools.describe`, then `tools.call({ ref, args })` | Adds catalog lookup and descriptor transport before the action call | Discovery describes capabilities; it does not grant permission or freeze future authorization |
| Reusing a discovered ref | Avoids rediscovering the name; each invocation still resolves through the registry | A saved name is not a saved approval or a bypass around generation/lifecycle checks |
| Independent calls in `Promise.all` | Overlaps independent work and reduces outer model round trips; each nested call still pays bridge/validation/serialization costs | Calls remain separately governed and observable; `Promise.all` itself adds no transaction, rollback, or sibling cancellation. Normal execution-failure and host-cancellation handling still apply |
| Provider-specific bulk action | Can amortize provider work and transport if the provider implements it | Atomicity, partial results, and cancellation granularity belong to that action's declared contract; Fabric does not infer them |

Return only the evidence the model needs. Intermediate work stays out of the final model
result unless returned, but still follows the existing live activity and bounded audit
policies. Large payloads can dominate local cloning and transport cost even when provider
latency is unchanged. UI read-view caching reduces observation costs only; it never caches
an action's permission decision or substitutes a stale result for a new invocation.

Providers should report current presentation values through `context.activity`. Repeating
the same normalized progress, entity, or metrics value is a UI no-op, not a heartbeat or a
durable event. Actual lifecycle completion and failure still travel through the normal
invocation path. See [incremental activity reads](interface.md#incremental-activity-reads).

## Managed embedded hosts

Trusted embedding code can opt into a closed-world provider authority:

```ts
import piFabric, { FABRIC_MANAGED_HOST_VERSION } from "pi-fabric";

if (FABRIC_MANAGED_HOST_VERSION !== 1) throw new Error("Unsupported managed host");
await piFabric(pi, { managedHost: { providers: ["agents", "memory", "compact"] } });
// Register all three host-owned implementations using the v1 registration event before activation.
```

This option is a factory capability, not a project/global setting or an event field. Without it,
reserved provider names still reject registration even with `overwrite: true`. Host-listed names
must be exact members of `agents`, `memory`, `compact`, `schema`, `state`, `mesh`, or `mcp`.
All listed implementations must register before activation. Re-publishing the same object is
idempotent; changing an implementation after activation requires a new host. Providers belong to
one host lifetime, and `close()` is awaited once after final publication withdrawal.

Managed mode ignores ambient configuration and fixes execution to full-code TypeScript QuickJS.
Native MCP, agent spawning, mesh, filesystem memory discovery, schema effects, speculative work,
prewalk, repairs, entropy compilation, and model-visible component control are unavailable.
A supplied memory implementation remains discoverable without enabling native memory scanning.
Every pinned component activation/reload uses the same host replacement; it cannot resurrect a
native provider. Non-core providers omitted from the host list expose no actions. Pi core calls
require captured overrides, instantiate no native tools, and do not apply native shell/worktree
interception. The embedding host must supply every desired override through its authorized broker.
Missing or withdrawn overrides fail closed.

The host remains responsible for OS isolation, resource loading, broker authorization and
cancellation, and for exposing only trusted extension code. This option does not sandbox arbitrary
host-side extensions. In particular, do not auto-load plugins from the agent's computer snapshot.

## Effect semantics and scoped acquisition

Action descriptors can declare effect semantics. Descriptor hashes and committed component and actor views carry this metadata. Omitting it is the conservative choice. Read-risk actions then resolve as commutative `none`, and every other risk resolves as unknown-order `emission`.

Actions with `kind: "scoped"` must implement `provider.acquire()` and return `{ value, dispose }`. Components call these actions through `context.acquire()`. That path validates arguments, pins the provider generation, and registers a single-shot disposer in the component scope. Ordinary `invoke()` stays available for `none`, `transactional`, and `emission` actions. A component that declares the `revertible` guarantee can normally call only `none` and `transactional` actions. Fabric rejects emissions from it.

The `resources` field names the affected resource classes, and `ordering` is `commutative`, `ordered`, or `unknown`. Fabric records concurrent non-read calls with an unknown footprint, along with overlapping non-commutative resources, in `audits[].effectConflicts`. Revertible components reject those calls. Fabric never reorders calls based on provider claims. These fields carry scheduling and lifecycle semantics. They do not replace authorization, and `risk` continues to drive approval policy. Providers whose descriptors can change in place may implement `subscribeCatalog(listener)`. Fabric then re-resolves dependent component targets and unsubscribes when that provider generation closes. See [components and committed capabilities](components.md).

## Nested `tool_result` proxy

Results from MCP, agent, memory, state, schema, mesh, components, compact, and external providers pass through Pi's `tool_result` middleware before Fabric enforces `maxNestedResultChars`. A user extension can then externalize or replace an oversized provider result before that result crosses into QuickJS.

A proxied event carries:

- `toolName` holding the fully qualified Fabric ref, such as `mcp.github.search`;
- a `toolCallId` that starts with `FABRIC_NESTED_TOOL_CALL_ID_PREFIX`;
- text `content` holding the raw string result or a JSON projection;
- `details` matching `FabricToolResultProxyDetailsV1`, whose `result` is the exact host-side structured value.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_NESTED_TOOL_CALL_ID_PREFIX,
  readFabricToolResultProxyDetailsV1,
} from "pi-fabric/protocol";

export default function resultGuard(pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    if (!event.toolCallId.startsWith(FABRIC_NESTED_TOOL_CALL_ID_PREFIX)) return;
    const proxy = readFabricToolResultProxyDetailsV1(event.details);
    if (!proxy || proxy.ref !== event.toolName) return;

    const serialized =
      typeof proxy.result === "string"
        ? proxy.result
        : (JSON.stringify(proxy.result) ?? String(proxy.result));
    if (serialized.length <= 6_144) return;

    const artifact = await persistPrivately(serialized);
    const replacement = {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: `${serialized.slice(0, 3_000)}\n…`,
      artifact,
    };
    return {
      content: [{ type: "text", text: replacement.preview }],
      details: { ...proxy, result: replacement },
    };
  });
}
```

If you change only `content`, the nested sandbox value becomes the patched text. To keep a structured replacement, return the proxy envelope in `details` with a changed `result`, as in the example above. When both fields are patched, a valid changed `details.result` takes precedence. Returning `isError: true` fails the nested provider invocation.

Pi core tools and captured extension tools skip this generic proxy, because they already replay their native `tool_call`, `tool_result`, and `tool_execution_*` lifecycle. Nested shell calls still emit their native identity: `pi.bash()` uses `toolName: "bash"`/`isBashToolResult()`, while `pi.powershell()` uses `toolName: "powershell"`/`isPowerShellToolResult()`. Proxied events act as middleware only. They create no separate persisted tool-result messages.
