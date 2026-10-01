import { randomBytes } from "node:crypto";
import type { MeshIdentity, MeshStateEntry, MeshStore } from "../mesh/store.js";

// Durable pending decisions (approvals, questions, escalations) kept in the
// project mesh under `decisions/<id>`. Every transition is a mesh
// compare-and-swap from `open`, so two answerers (a TUI dialog, the
// `pi-fabric decisions` CLI, a supervising program) cannot both win. Expiry is
// applied lazily by whichever reader first observes a passed deadline.

export type DecisionKind = "approval" | "question" | "escalation";
export type DecisionInput = "text" | "confirm" | "select" | "editor";
export type DecisionStatus = "open" | "answered" | "expired" | "cancelled";
export type DecisionHolder = "root" | "user" | `supervisor:${string}`;

export interface DecisionOption {
  id: string;
  label: string;
}

export interface DecisionAnswer {
  optionId?: string;
  text?: string;
  answeredBy: string;
  via: string;
  at: number;
}

export interface DecisionRecord {
  id: string;
  kind: DecisionKind;
  title: string;
  body?: string;
  options?: DecisionOption[];
  input?: DecisionInput;
  raisedBy: { participantId: string; runId?: string; sessionId?: string };
  holder: DecisionHolder;
  createdAt: number;
  deadline?: number;
  onExpire: "cancel" | "default";
  defaultOptionId?: string;
  status: DecisionStatus;
  answer?: DecisionAnswer;
}

export interface DecisionRaiseInput {
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  options?: unknown;
  input?: unknown;
  holder?: unknown;
  deadline?: unknown;
  timeoutMs?: unknown;
  onExpire?: unknown;
  defaultOptionId?: unknown;
}

export const DECISION_PREFIX = "decisions/";
export const DECISIONS_TOPIC = "fabric.decisions";
export const MAX_DECISION_TITLE_CHARS = 200;
export const MAX_DECISION_BODY_CHARS = 4_000;
export const MAX_DECISION_TEXT_CHARS = 4_000;
export const MAX_DECISION_OPTIONS = 12;
export const MAX_DECISION_DEADLINE_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_OPEN_DECISIONS = 200;
const MAX_STORED_DECISIONS = 500;
const RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DECISION_ID = /^dec_[A-Za-z0-9_-]{8,64}$/;
const PARTICIPANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const KINDS = new Set(["approval", "question", "escalation"]);
const INPUTS = new Set(["text", "confirm", "select", "editor"]);
const STATUSES = new Set(["open", "answered", "expired", "cancelled"]);
const CONFIRM_OPTIONS: DecisionOption[] = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
];

const casConflict = (error: unknown): boolean =>
  error instanceof Error && /compare-and-swap failed/.test(error.message);

const boundedText = (value: unknown, label: string, max: number, required = false): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new Error(`Decision ${label} must be a${required ? " non-empty" : ""} string`);
  }
  if (value.length > max) throw new Error(`Decision ${label} exceeds ${max} characters`);
  return value;
};

export const assertDecisionId = (value: unknown): string => {
  if (typeof value !== "string" || !DECISION_ID.test(value)) {
    throw new Error(`Invalid decision id: ${JSON.stringify(value)}`);
  }
  return value;
};

export const decisionHolderValue = (value: unknown): DecisionHolder => {
  if (value === undefined) return "user";
  if (value === "root" || value === "user") return value;
  if (typeof value === "string" && value.startsWith("supervisor:") && PARTICIPANT_ID.test(value.slice(11))) {
    return value as DecisionHolder;
  }
  throw new Error('Decision holder must be "root", "user", or "supervisor:<participantId>"');
};

const optionsValue = (value: unknown): DecisionOption[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DECISION_OPTIONS) {
    throw new Error(`Decision options must be 1..${MAX_DECISION_OPTIONS} entries`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const option = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : {};
    if (typeof option.id !== "string" || !OPTION_ID.test(option.id)) {
      throw new Error(`Invalid decision option id: ${JSON.stringify(option.id)}`);
    }
    if (seen.has(option.id)) throw new Error(`Duplicate decision option id: ${option.id}`);
    seen.add(option.id);
    const label = boundedText(option.label, "option label", MAX_DECISION_TITLE_CHARS, true)!;
    return { id: option.id, label };
  });
};

/** Validate raise arguments into an open record; throws on any malformed field. */
export const buildDecisionRecord = (
  input: DecisionRaiseInput,
  raisedBy: DecisionRecord["raisedBy"],
  now = Date.now(),
): DecisionRecord => {
  const kind = input.kind ?? "question";
  if (typeof kind !== "string" || !KINDS.has(kind)) {
    throw new Error('Decision kind must be "approval", "question", or "escalation"');
  }
  const title = boundedText(input.title, "title", MAX_DECISION_TITLE_CHARS, true)!;
  const body = boundedText(input.body, "body", MAX_DECISION_BODY_CHARS);
  let options = optionsValue(input.options);
  if (input.input !== undefined && (typeof input.input !== "string" || !INPUTS.has(input.input))) {
    throw new Error('Decision input must be "text", "confirm", "select", or "editor"');
  }
  const mode = (input.input as DecisionInput | undefined) ?? (options ? "select" : "text");
  if (mode === "confirm") options ??= CONFIRM_OPTIONS.map((option) => ({ ...option }));
  if (mode === "select" && !options) throw new Error('Decision input "select" requires options');
  if ((mode === "text" || mode === "editor") && options) {
    throw new Error(`Decision input "${mode}" does not take options`);
  }
  if (input.deadline !== undefined && input.timeoutMs !== undefined) {
    throw new Error("Pass either deadline or timeoutMs, not both");
  }
  let deadline: number | undefined;
  if (input.timeoutMs !== undefined) {
    if (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs) ||
        input.timeoutMs < 1_000 || input.timeoutMs > MAX_DECISION_DEADLINE_MS) {
      throw new Error(`Decision timeoutMs must be 1000..${MAX_DECISION_DEADLINE_MS}`);
    }
    deadline = now + Math.floor(input.timeoutMs);
  } else if (input.deadline !== undefined) {
    if (typeof input.deadline !== "number" || !Number.isFinite(input.deadline) ||
        input.deadline <= now || input.deadline > now + MAX_DECISION_DEADLINE_MS) {
      throw new Error("Decision deadline must be a future epoch-ms time within 30 days");
    }
    deadline = Math.floor(input.deadline);
  }
  const onExpire = input.onExpire ?? "cancel";
  if (onExpire !== "cancel" && onExpire !== "default") {
    throw new Error('Decision onExpire must be "cancel" or "default"');
  }
  let defaultOptionId: string | undefined;
  if (input.defaultOptionId !== undefined) {
    if (typeof input.defaultOptionId !== "string" || !options?.some((option) => option.id === input.defaultOptionId)) {
      throw new Error(`Decision defaultOptionId must name one of the options`);
    }
    defaultOptionId = input.defaultOptionId;
  }
  if (onExpire === "default" && (!defaultOptionId || deadline === undefined)) {
    throw new Error('Decision onExpire "default" requires defaultOptionId and a deadline');
  }
  return {
    id: `dec_${randomBytes(12).toString("base64url")}`,
    kind: kind as DecisionKind,
    title,
    ...(body !== undefined ? { body } : {}),
    ...(options ? { options } : {}),
    input: mode,
    raisedBy: structuredClone(raisedBy),
    holder: decisionHolderValue(input.holder),
    createdAt: now,
    ...(deadline !== undefined ? { deadline } : {}),
    onExpire,
    ...(defaultOptionId ? { defaultOptionId } : {}),
    status: "open",
  };
};

const isDecisionRecord = (value: unknown): value is DecisionRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.title === "string" &&
    typeof record.status === "string" && STATUSES.has(record.status) &&
    typeof record.createdAt === "number";
};

export interface DecisionAnswerInput {
  optionId?: unknown;
  text?: unknown;
}

/** Validate an answer against an open record; returns the answer payload. */
export const validateDecisionAnswer = (
  record: DecisionRecord,
  input: DecisionAnswerInput,
): { optionId?: string; text?: string } => {
  const text = boundedText(input.text, "answer text", MAX_DECISION_TEXT_CHARS);
  if (record.options) {
    if (typeof input.optionId !== "string" || !record.options.some((option) => option.id === input.optionId)) {
      throw new Error(
        `Decision ${record.id} needs optionId, one of: ${record.options.map((option) => option.id).join(", ")}`,
      );
    }
    return { optionId: input.optionId, ...(text !== undefined ? { text } : {}) };
  }
  if (input.optionId !== undefined) throw new Error(`Decision ${record.id} has no options; answer with text`);
  if (text === undefined) throw new Error(`Decision ${record.id} needs a text answer`);
  return { text };
};

export class DecisionStore {
  constructor(
    readonly mesh: MeshStore,
    readonly identity: MeshIdentity,
    readonly now: () => number = Date.now,
  ) {}

  async raise(input: DecisionRaiseInput, raisedBy?: Partial<DecisionRecord["raisedBy"]>): Promise<DecisionRecord> {
    const record = buildDecisionRecord(input, {
      participantId: raisedBy?.participantId ?? this.identity.id,
      ...(raisedBy?.runId ? { runId: raisedBy.runId } : {}),
      ...((raisedBy?.sessionId ?? this.identity.sessionId)
        ? { sessionId: (raisedBy?.sessionId ?? this.identity.sessionId)! }
        : {}),
    }, this.now());
    const entries = await this.#entries();
    if (entries.filter((entry) => entry.record.status === "open").length >= MAX_OPEN_DECISIONS) {
      throw new Error(`Too many open decisions (limit ${MAX_OPEN_DECISIONS}); answer or cancel some first`);
    }
    await this.#prune(entries);
    // ifVersion 0 only succeeds for a key that has never existed.
    await this.mesh.put({ key: DECISION_PREFIX + record.id, value: record, identity: this.identity, ifVersion: 0 });
    await this.#notify("decision.raised", record);
    return structuredClone(record);
  }

  async get(id: string): Promise<DecisionRecord | undefined> {
    const entry = this.mesh.get(DECISION_PREFIX + assertDecisionId(id));
    if (!entry || !isDecisionRecord(entry.value)) return undefined;
    return (await this.#expire(entry)).record;
  }

  async list(filter: { status?: DecisionStatus; holder?: string; limit?: number } = {}): Promise<DecisionRecord[]> {
    const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)));
    return (await this.#entries())
      .map((entry) => entry.record)
      .filter((record) =>
        (!filter.status || record.status === filter.status) &&
        (!filter.holder || record.holder === filter.holder))
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  /** CAS open -> answered. Fails when the decision is missing or no longer open. */
  async answer(
    id: string,
    input: DecisionAnswerInput,
    by: { answeredBy: string; via: string },
  ): Promise<DecisionRecord> {
    return this.#transition(id, (record) => ({
      ...record,
      status: "answered",
      answer: { ...validateDecisionAnswer(record, input), answeredBy: by.answeredBy, via: by.via, at: this.now() },
    }));
  }

  async cancel(id: string, by: { answeredBy: string; via: string }): Promise<DecisionRecord> {
    return this.#transition(id, (record) => ({
      ...record,
      status: "cancelled",
      answer: { answeredBy: by.answeredBy, via: by.via, at: this.now() },
    }));
  }

  /**
   * Resolve when the decision leaves `open` (answer, expiry, cancel) or the
   * wait times out; a timed-out wait returns the still-open record.
   */
  async wait(id: string, options: { timeoutMs?: number; signal?: AbortSignal; pollMs?: number } = {}): Promise<DecisionRecord> {
    const started = this.now();
    let pollMs = Math.max(10, options.pollMs ?? 200);
    while (true) {
      options.signal?.throwIfAborted();
      const record = await this.get(id);
      if (!record) throw new Error(`Unknown decision: ${id}`);
      if (record.status !== "open") return record;
      const now = this.now();
      if (options.timeoutMs !== undefined && now - started >= options.timeoutMs) return record;
      const remaining = [
        options.timeoutMs !== undefined ? started + options.timeoutMs - now : Infinity,
        record.deadline !== undefined ? record.deadline - now : Infinity,
        pollMs,
      ];
      await abortableDelay(Math.max(1, Math.min(...remaining)), options.signal);
      pollMs = Math.min(1_000, Math.ceil(pollMs * 1.5));
    }
  }

  async #transition(id: string, next: (record: DecisionRecord) => DecisionRecord): Promise<DecisionRecord> {
    const key = DECISION_PREFIX + assertDecisionId(id);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const entry = this.mesh.get(key);
      if (!entry || !isDecisionRecord(entry.value)) throw new Error(`Unknown decision: ${id}`);
      const { record, version } = await this.#expire(entry);
      if (record.status !== "open") throw new Error(`Decision ${id} is ${record.status}, not open`);
      const updated = next(record);
      try {
        await this.mesh.put({ key, value: updated, identity: this.identity, ifVersion: version });
      } catch (error) {
        if (casConflict(error)) continue;
        throw error;
      }
      await this.#notify(`decision.${updated.status}`, updated);
      return structuredClone(updated);
    }
    throw new Error(`Decision ${id} changed concurrently; read it again`);
  }

  async #expire(entry: MeshStateEntry): Promise<{ record: DecisionRecord; version: number }> {
    let current = entry;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const record = current.value as DecisionRecord;
      if (record.status !== "open" || record.deadline === undefined || this.now() < record.deadline) {
        return { record: structuredClone(record), version: current.version };
      }
      const expired: DecisionRecord = {
        ...record,
        status: "expired",
        ...(record.onExpire === "default" && record.defaultOptionId
          ? { answer: { optionId: record.defaultOptionId, answeredBy: "deadline", via: "expiry", at: this.now() } }
          : {}),
      };
      try {
        const written = await this.mesh.put({ key: current.key, value: expired, identity: this.identity, ifVersion: current.version });
        await this.#notify("decision.expired", expired);
        return { record: expired, version: written.version };
      } catch (error) {
        if (!casConflict(error)) throw error;
        const reread = this.mesh.get(current.key);
        if (!reread || !isDecisionRecord(reread.value)) throw new Error(`Unknown decision: ${record.id}`);
        current = reread;
      }
    }
    throw new Error(`Decision ${(entry.value as DecisionRecord).id} changed concurrently; read it again`);
  }

  async #entries(): Promise<Array<{ entry: MeshStateEntry; record: DecisionRecord }>> {
    const result: Array<{ entry: MeshStateEntry; record: DecisionRecord }> = [];
    for (const entry of this.mesh.listAll(DECISION_PREFIX)) {
      if (!isDecisionRecord(entry.value)) continue;
      result.push({ entry, record: (await this.#expire(entry)).record });
    }
    return result;
  }

  // Resolved records are history: keep them a week, and never let them crowd
  // out new decisions past the store bound.
  async #prune(entries: Array<{ entry: MeshStateEntry; record: DecisionRecord }>): Promise<void> {
    const now = this.now();
    const resolved = entries
      .filter(({ record }) => record.status !== "open")
      .sort((left, right) => (left.record.answer?.at ?? left.record.createdAt) - (right.record.answer?.at ?? right.record.createdAt));
    let excess = entries.length + 1 - MAX_STORED_DECISIONS;
    for (const { entry, record } of resolved) {
      const old = now - (record.answer?.at ?? record.createdAt) > RESOLVED_RETENTION_MS;
      if (!old && excess <= 0) break;
      await this.mesh.delete({ key: entry.key, ifVersion: entry.version }).catch(() => undefined);
      excess -= 1;
    }
  }

  async #notify(kind: string, record: DecisionRecord): Promise<void> {
    try {
      await this.mesh.publish({
        topic: DECISIONS_TOPIC,
        kind,
        from: this.identity,
        data: { id: record.id, kind: record.kind, holder: record.holder, status: record.status, title: record.title },
      });
    } catch {
      // Notification is a wake hint; the decision record is authoritative.
    }
  }
}

const abortableDelay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
