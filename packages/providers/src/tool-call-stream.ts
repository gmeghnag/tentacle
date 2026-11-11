/**
 * Streamed tool-call assembly for OpenAI-compatible endpoints.
 *
 * Extracted from `openai-provider.ts` (AGENTS §7: computation belongs in a pure
 * module) so the one part with real branching — how streamed `tool_calls`
 * deltas are stitched back into calls — is unit-testable and has ONE owner.
 *
 * Two rules, both needed by `docs/fix/deepseek-dsml-leak.md`:
 *
 * 1. An explicit `index` is the wire's own key, always. Servers that send one
 *    keep working exactly as before, including two calls interleaved by index.
 * 2. A delta with NO `index` belongs to the call already running — unless it
 *    carries a DIFFERENT call id. DeepSeek drops (or stops repeating) `index`
 *    mid-call; keying on the raw index then opened a second, nameless call and a
 *    long argument body arrived as two fragments (`invalid JSON arguments` for
 *    the head, `unknown tool:` for the tail).
 */
import type { ToolCall } from "@tentacle/core";

/** One element of a chunk's `delta.tool_calls`, as OpenAI-compatible servers send it. */
export interface WireToolCallDelta {
  /** Position of the call in the turn. Servers are meant to always send it; some omit it. */
  readonly index?: number;
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface Slot {
  id: string;
  name: string;
  args: string;
}

/** Reassembles tool calls streamed incrementally across chunks. */
export class ToolCallAssembler {
  private readonly slots = new Map<number, Slot>();
  /** The call the latest delta touched: an index-less delta's target. */
  private current: number | undefined;
  /** Next free slot number (a delta arriving before any index needs one). */
  private nextKey = 0;

  add(deltas: readonly WireToolCallDelta[]): void {
    for (const d of deltas) {
      const key = this.keyFor(d);
      const slot = this.slot(key);
      if (d.id && slot.id !== d.id) {
        slot.id = d.id;
      }
      const name = d.function?.name;
      if (name && name !== slot.name) {
        // A name is streamed in pieces; some servers restate the whole name on
        // every delta. Appending a restatement would name the call twice, so an
        // exact repeat of what is already accumulated is skipped.
        slot.name += name;
      }
      if (d.function?.arguments) {
        slot.args += d.function.arguments;
      }
      this.current = key;
    }
  }

  drain(): ToolCall[] {
    const out: ToolCall[] = [];
    for (const slot of this.slots.values()) {
      // A call the server never named carries no dispatchable action: it is a
      // fragment, not a call (the registry could only answer `unknown tool:`).
      if (slot.name === "") {
        continue;
      }
      out.push({ id: slot.id || crypto.randomUUID(), name: slot.name, arguments: slot.args });
    }
    this.slots.clear();
    this.current = undefined;
    return out;
  }

  get size(): number {
    return this.slots.size;
  }

  /**
   * The slot a delta belongs to. An explicit `index` is authoritative (two
   * calls may interleave by index). Without one, the delta continues the
   * running call — a different id is the only evidence of a different call.
   */
  private keyFor(d: WireToolCallDelta): number {
    if (d.index !== undefined) {
      return d.index;
    }
    if (this.current === undefined) {
      return this.nextKey;
    }
    const running = this.slots.get(this.current);
    if (running !== undefined && d.id !== undefined && running.id !== "" && d.id !== running.id) {
      return this.nextKey;
    }
    return this.current;
  }

  private slot(key: number): Slot {
    const existing = this.slots.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: Slot = { id: "", name: "", args: "" };
    this.slots.set(key, created);
    if (key >= this.nextKey) {
      this.nextKey = key + 1;
    }
    return created;
  }
}
