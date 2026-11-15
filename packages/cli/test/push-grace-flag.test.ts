/**
 * `serve --push-grace <seconds>` (docs/feat/mobile-push.md Design 6, P8's flag;
 * P10 found it unreachable).
 *
 * The flag was documented, advertised in `ServeLimits.pushGraceSeconds`, read by
 * `parseServeLimits` and consumed by `serve.ts` — but never added to
 * `ARGS.serve`, so `parseArgs` answered `unknown option --push-grace` before any
 * of that could run. Nothing caught it because every test drove the
 * `ServeOptions` field directly instead of the command line a person types.
 *
 * RED before the fix: `parseArgs(["--push-grace","0"], ARGS.serve)` returned
 * `{ok:false,error:"unknown option --push-grace"}` (transcript in the task doc).
 */
import { describe, expect, test } from "bun:test";
import { ARGS, parseArgs, parseServeLimits } from "../src/flags.ts";

function limitsFor(argv: string[]) {
  const parsed = parseArgs(argv, ARGS.serve);
  if (!parsed.ok) {
    throw new Error(`parse failed: ${parsed.error}`);
  }
  return parseServeLimits(parsed);
}

describe("serve --push-grace", () => {
  test("the flag is one `serve` accepts (the defect: it was not)", () => {
    expect(Object.hasOwn(ARGS.serve.values, "push-grace")).toBe(true);
    expect(parseArgs(["--push-grace", "0"], ARGS.serve).ok).toBe(true);
  });

  test("it reaches `ServeLimits.pushGraceSeconds`", () => {
    // `0` is the value the E2E harness uses: push at once, no grace.
    expect(limitsFor(["--push-grace", "0"]).pushGraceSeconds).toBe(0);
    expect(limitsFor(["--push-grace", "7"]).pushGraceSeconds).toBe(7);
    expect(limitsFor(["--push-grace", "3600"]).pushGraceSeconds).toBe(3600);
  });

  test("absent → undefined, so the config's `push.graceSeconds` still applies", () => {
    expect(limitsFor([]).pushGraceSeconds).toBeUndefined();
  });

  test("a value outside 0–3600, or not whole seconds, is refused BEFORE binding", () => {
    // 3601 is the upper bound `push.graceSeconds` itself enforces, so a flag that
    // accepted it would promise a grace no config may hold.
    for (const bad of ["3601", "-1", "1.5", "abc", "", " 5", "5 "]) {
      expect(() => limitsFor(["--push-grace", bad])).toThrow(/--push-grace/);
    }
  });

  test("`--push-grace` with no value is an error, not a silent 0", () => {
    expect(() => limitsFor(["--push-grace"])).toThrow();
  });
});
