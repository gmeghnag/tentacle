/** A fake `ShareStarter`: what was created, opened, stopped and discarded. */
import type { ShareHooks, ShareStarter } from "../../src/session-previews.ts";

export function fakeSharer() {
  const opened: ShareHooks[] = [];
  const stopped: number[] = [];
  const discarded: number[] = [];
  let created = 0;
  let refusal: string | undefined;
  let held: Promise<void> | undefined;
  const url = (index: number): string => `https://app${index}.apps.example.so/`;
  const starter: ShareStarter = {
    domain: "apps.example.so",
    async create() {
      await held;
      if (refusal !== undefined) return { ok: false, reason: refusal };
      const index = created++;
      return {
        ok: true,
        url: url(index),
        open(hooks) {
          opened.push(hooks);
          return {
            stop: async () => {
              stopped.push(index);
            },
          };
        },
        discard: async () => {
          discarded.push(index);
        },
      };
    },
  };
  return {
    ...starter,
    opened,
    stopped,
    discarded,
    url,
    refuse(reason: string): void {
      refusal = reason;
    },
    /** Make `create` wait until the returned function is called. */
    hold(): () => void {
      let release = (): void => {};
      held = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}
