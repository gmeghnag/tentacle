/**
 * Static style-metric extraction for the mockup kit (docs/feat/mobile-mockup-kit.md
 * Slice 1b). A component's `StyleSheet.create({…})` lives in a `.tsx` that
 * imports react-native, which Bun cannot load, so it is READ, not imported:
 * parsed with the TypeScript compiler API and constant-folded. What folds:
 * literals, unary minus, `+ - * /`, module-level `const`s of the same file,
 * members of the modules the caller hands in (the theme, `motion.ts`), and
 * `StyleSheet.hairlineWidth` / `absoluteFillObject` from one named table.
 * Anything else is UNRESOLVED, reported at its `file:line` — never given a
 * default value.
 */
import { dirname, join, normalize } from "node:path";
import ts from "typescript";

export type Value = number | string | boolean | readonly Value[] | { readonly [k: string]: Value };

export interface Unresolved {
  readonly component: string;
  readonly style: string;
  readonly prop: string;
  readonly file: string;
  readonly line: number;
  readonly source: string;
}

export interface Extracted {
  readonly styles: Record<string, Record<string, Value>>;
  /** The file's foldable module-level SCREAMING_CASE consts (e.g. StepNode's `GUTTER`). */
  readonly consts: Record<string, Value>;
  readonly unresolved: Unresolved[];
}

/**
 * React Native's `StyleSheet` constants, as on the e2e iPhone (@3x): the one
 * place a platform value enters the kit. `hairlineWidth` is 1 device pixel.
 */
export const STYLESHEET_CONSTANTS: Readonly<Record<string, Value>> = {
  hairlineWidth: 1 / 3,
  absoluteFillObject: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
};

export interface ExtractInput {
  /** The manifest id, e.g. `step`. */
  readonly id: string;
  /** Repo-relative path, e.g. `apps/mobile/src/ui/StepNode.tsx` (used to resolve imports). */
  readonly file: string;
  readonly source: string;
  /** Importable modules by repo-relative path (`apps/mobile/src/theme.ts` → its exports). */
  readonly modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** `true`: a missing `StyleSheet.create` throws. `false`: consts only. */
  readonly requireStyles: boolean;
}

type Folded =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly at: ts.Node };

const fail = (at: ts.Node): Folded => ({ ok: false, at });
const ok = (value: Value): Folded => ({ ok: true, value });

function isValue(v: unknown): v is Value {
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
    return true;
  }
  if (Array.isArray(v)) {
    return v.every(isValue);
  }
  return typeof v === "object" && v !== null && Object.values(v).every(isValue);
}

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

export function extractStyles(input: ExtractInput): Extracted {
  const { id, file, source, modules } = input;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts = new Map<string, ts.Expression>();
  const imports = new Map<string, { module: string; name: string | "*" }>();
  const creates: ts.ObjectLiteralExpression[] = [];

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const module = spec.startsWith(".") ? normalize(join(dirname(file), spec)) : spec;
      const b = st.importClause?.namedBindings;
      if (b && ts.isNamedImports(b)) {
        for (const el of b.elements) {
          imports.set(el.name.text, { module, name: (el.propertyName ?? el.name).text });
        }
      } else if (b && ts.isNamespaceImport(b)) {
        imports.set(b.name.text, { module, name: "*" });
      }
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.initializer === undefined) {
          continue;
        }
        const init = d.initializer;
        if (
          ts.isCallExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          ts.isIdentifier(init.expression.expression) &&
          init.expression.expression.text === "StyleSheet" &&
          init.expression.name.text === "create"
        ) {
          const arg = init.arguments[0];
          if (arg && ts.isObjectLiteralExpression(arg)) {
            creates.push(arg);
          }
          continue;
        }
        if (st.declarationList.flags & ts.NodeFlags.Const) {
          consts.set(d.name.text, init);
        }
      }
    }
  }

  const folding = new Set<string>();
  const fold = (e: ts.Expression): Folded => {
    if (ts.isNumericLiteral(e)) {
      return ok(Number(e.text));
    }
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      return ok(e.text);
    }
    if (e.kind === ts.SyntaxKind.TrueKeyword) {
      return ok(true);
    }
    if (e.kind === ts.SyntaxKind.FalseKeyword) {
      return ok(false);
    }
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
      return fold(e.expression);
    }
    if (ts.isPrefixUnaryExpression(e)) {
      const v = fold(e.operand);
      if (!v.ok || typeof v.value !== "number") {
        return v.ok ? fail(e) : v;
      }
      if (e.operator === ts.SyntaxKind.MinusToken) {
        return ok(-v.value);
      }
      return e.operator === ts.SyntaxKind.PlusToken ? v : fail(e);
    }
    if (ts.isBinaryExpression(e)) {
      const l = fold(e.left);
      const r = fold(e.right);
      if (!l.ok) {
        return l;
      }
      if (!r.ok) {
        return r;
      }
      const a = l.value;
      const b = r.value;
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken && typeof a === "string" && typeof b === "string") {
        return ok(a + b);
      }
      if (typeof a !== "number" || typeof b !== "number") {
        return fail(e);
      }
      if (op === ts.SyntaxKind.PlusToken) return ok(a + b);
      if (op === ts.SyntaxKind.MinusToken) return ok(a - b);
      if (op === ts.SyntaxKind.AsteriskToken) return ok(a * b);
      if (op === ts.SyntaxKind.SlashToken) return ok(a / b);
      return fail(e);
    }
    if (ts.isIdentifier(e)) {
      const local = consts.get(e.text);
      if (local !== undefined) {
        if (folding.has(e.text)) {
          return fail(e);
        }
        folding.add(e.text);
        const v = fold(local);
        folding.delete(e.text);
        return v.ok ? v : fail(e);
      }
      const imp = imports.get(e.text);
      const mod = imp ? modules[imp.module] : undefined;
      if (imp && mod) {
        const v = imp.name === "*" ? mod : mod[imp.name];
        return isValue(v) ? ok(v) : fail(e);
      }
      return fail(e);
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const key = ts.isPropertyAccessExpression(e)
        ? e.name.text
        : ts.isStringLiteral(e.argumentExpression) || ts.isNumericLiteral(e.argumentExpression)
          ? e.argumentExpression.text
          : undefined;
      if (key === undefined) {
        return fail(e);
      }
      if (
        ts.isIdentifier(e.expression) &&
        e.expression.text === "StyleSheet" &&
        imports.get("StyleSheet")?.module === "react-native"
      ) {
        const v = STYLESHEET_CONSTANTS[key];
        return v === undefined ? fail(e) : ok(v);
      }
      const base = fold(e.expression);
      if (!base.ok) {
        return base;
      }
      const obj = base.value;
      if (typeof obj !== "object" || obj === null || !Object.hasOwn(obj, key)) {
        return fail(e);
      }
      return ok((obj as Record<string, Value>)[key] as Value);
    }
    if (ts.isArrayLiteralExpression(e)) {
      const out: Value[] = [];
      for (const el of e.elements) {
        const v = ts.isSpreadElement(el) ? fail(el) : fold(el);
        if (!v.ok) {
          return v;
        }
        out.push(v.value);
      }
      return ok(out);
    }
    if (ts.isObjectLiteralExpression(e)) {
      const out: Record<string, Value> = {};
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) {
          const v = fold(p.expression);
          if (!v.ok) {
            return v;
          }
          if (typeof v.value !== "object" || Array.isArray(v.value)) {
            return fail(p);
          }
          Object.assign(out, v.value);
        } else if (ts.isPropertyAssignment(p)) {
          const name = propName(p.name);
          const v = name === undefined ? fail(p) : fold(p.initializer);
          if (!v.ok || name === undefined) {
            return v.ok ? fail(p) : v;
          }
          out[name] = v.value;
        } else if (ts.isShorthandPropertyAssignment(p)) {
          const v = fold(p.name);
          if (!v.ok) {
            return v;
          }
          out[p.name.text] = v.value;
        } else {
          return fail(p);
        }
      }
      return ok(out);
    }
    return fail(e);
  };

  const unresolved: Unresolved[] = [];
  const miss = (style: string, prop: string, at: ts.Node): void => {
    unresolved.push({
      component: id,
      style,
      prop,
      file,
      line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1,
      source: at.getText(sf),
    });
  };

  if (creates.length === 0 && input.requireStyles) {
    throw new Error(`manifest: ${id} → ${file}: no StyleSheet.create`);
  }
  if (creates.length > 1) {
    throw new Error(
      `manifest: ${id} → ${file}: ${creates.length} StyleSheet.create (expected one)`,
    );
  }
  const styles: Record<string, Record<string, Value>> = {};
  for (const p of creates[0]?.properties ?? []) {
    const style = ts.isPropertyAssignment(p) ? propName(p.name) : undefined;
    if (!ts.isPropertyAssignment(p) || style === undefined) {
      miss("*", "*", p);
      continue;
    }
    const out: Record<string, Value> = {};
    styles[style] = out;
    if (!ts.isObjectLiteralExpression(p.initializer)) {
      const v = fold(p.initializer);
      if (v.ok && typeof v.value === "object" && !Array.isArray(v.value)) {
        Object.assign(out, v.value);
      } else {
        miss(style, "*", v.ok ? p.initializer : v.at);
      }
      continue;
    }
    for (const q of p.initializer.properties) {
      if (ts.isSpreadAssignment(q)) {
        const v = fold(q.expression);
        if (v.ok && typeof v.value === "object" && !Array.isArray(v.value)) {
          Object.assign(out, v.value);
        } else {
          miss(style, "...", q);
        }
        continue;
      }
      const prop = ts.isPropertyAssignment(q) ? propName(q.name) : undefined;
      if (!ts.isPropertyAssignment(q) || prop === undefined) {
        miss(style, "*", q);
        continue;
      }
      const v = fold(q.initializer);
      if (v.ok) {
        out[prop] = v.value;
      } else {
        miss(style, prop, q);
      }
    }
  }

  const constOut: Record<string, Value> = {};
  for (const [name, init] of consts) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      continue;
    }
    const v = fold(init);
    if (v.ok) {
      constOut[name] = v.value;
    }
  }
  return { styles, consts: constOut, unresolved };
}
