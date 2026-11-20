/**
 * THE CI LITERAL CHECK, PROVEN TO BITE (ticket #219 AC 2; spec #214 decision
 * 13 and user story 47; ADR-0037 as amended).
 *
 * "I want CI to fail on a rep-facing literal outside the copy package, so
 * that the rule holds as the UI grows" (user story 47). rep-web does not
 * exist yet, so the check has nothing to sweep today — which is exactly the
 * state in which a check quietly stops meaning anything (#84, ADR-0028
 * doctrine). This suite is what makes today's green a result: it plants a
 * rep-web that DOES hold a literal and requires the script to fail on it,
 * and plants the same page reading its words from `@dito/copy` and requires
 * the script to pass.
 *
 * IT DRIVES THE SCRIPT, NOT A COPY OF ITS RULE. `scripts/copy-check.mjs` is
 * what CI runs and what the day rep-web lands has to keep working, so the
 * test spawns it and reads its exit code — the way `resetAndMigrate` drives
 * `scripts/migrate.sh` rather than reimplementing a migration.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const CHECK = path.join(REPO, "scripts/copy-check.mjs");

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stub rep-web holding the given sources, keyed by repo-relative-ish path. */
function plant(files: Readonly<Record<string, string>>): string {
  const app = mkdtempSync(path.join(tmpdir(), "dito-copy-check-"));
  made.push(app);
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(app, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source, "utf8");
  }
  return app;
}

/** Runs the check over one app tree. */
function check(app: string, ...flags: string[]): { code: number; out: string } {
  const run = spawnSync(process.execPath, [CHECK, `--app=${app}`, ...flags], {
    encoding: "utf8",
  });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

describe("the copy check (ticket #219 AC 2)", () => {
  it("fails on a planted rep-facing string in a rep-web page", () => {
    const app = plant({
      "app/inicio/page.tsx":
        'export default function Inicio() {\n  return <h2>Esperan tu visto bueno</h2>;\n}\n',
    });
    const { code, out } = check(app);
    expect(code).toBe(1);
    expect(out).toContain("app/inicio/page.tsx");
    expect(out).toContain("Esperan tu visto bueno");
  });

  it("passes when the same page reads its words from the package", () => {
    const app = plant({
      "app/inicio/page.tsx": [
        'import { CHROME } from "@dito/copy";',
        "",
        "export default function Inicio() {",
        '  return <h2>{CHROME["feed.waiting"]}</h2>;',
        "}",
      ].join("\n"),
    });
    const { code, out } = check(app);
    expect(code).toBe(0);
    expect(out).toContain("0 offender");
  });

  it("catches Spanish written without its orthography, as the twin sweep does", () => {
    const app = plant({
      "app/conexiones/page.tsx":
        'const AVISO = "no se pudo conectar tu numero";\nexport default AVISO;\n',
    });
    expect(check(app).code).toBe(1);
  });

  it("never mistakes a comment quoting Spanish for a literal", () => {
    // rep-web's own comments will quote «Esperan tu visto bueno» to explain
    // which card a page renders, and a check that could not tell a comment
    // from a constant would push that reasoning out of the code.
    const app = plant({
      "app/inicio/page.tsx": [
        "// The heading «Esperan tu visto bueno» is CHROME's, not this file's.",
        "/* And «Enviar» is the draft card's button. */",
        'import { CHROME } from "@dito/copy";',
        "",
        'export const heading = CHROME["feed.waiting"];',
      ].join("\n"),
    });
    expect(check(app).code).toBe(0);
  });

  it("does not read a key, a class list or English as rep-facing copy", () => {
    // The other direction, which is what makes the rule usable: a page is
    // full of strings that are not copy.
    const app = plant({
      "app/inicio/page.tsx": [
        'import { CHROME } from "@dito/copy";',
        "",
        'export const key = "feed.waiting";',
        'export const css = "flex items-center gap-2";',
        'export const note = "the feed renders posts newest first";',
        'export const heading = CHROME[key as "feed.waiting"];',
      ].join("\n"),
    });
    expect(check(app).code).toBe(0);
  });

  it("says so, and does not pass silently, over an app that is not there", () => {
    // A DIRECTORY THAT DOES NOT EXIST, and a temp path rather than
    // `apps/rep-web`, which is a real app (#221): a check that runs over
    // nothing has to SAY so rather than print a green nobody can interpret,
    // and that claim needs a genuinely absent tree to be about.
    const { code, out } = check(path.join(tmpdir(), "dito-no-such-app"));
    expect(code).toBe(0);
    expect(out).toContain("0 file");
    expect(out).toContain("proves nothing");
  });

  it("refuses to pass over a missing app under --require-app", () => {
    // The flag CI's step carries (#221), so the "scanned nothing" case is a
    // red build rather than a pass.
    const { code, out } = check(
      path.join(tmpdir(), "dito-no-such-app"),
      "--require-app",
    );
    expect(code).toBe(1);
    expect(out).toContain("--require-app");
  });

  it("does not read a generic in a plain module as text a page renders", () => {
    // THE POSITION RULES ARE `.tsx`-ONLY — `repFacing` in
    // `scripts/copy-check.mjs` argues why. This is the half that proves it.
    const app = plant({
      "src/sessions.ts": [
        "import type pg from \"pg\";",
        "",
        "export interface RepSession {",
        "  readonly seatId: string;",
        "}",
        "",
        "export async function readSession(",
        "  db: pg.ClientBase,",
        "  token: string,",
        "): Promise<RepSession | undefined> {",
        "  const rows = await db.query<{ seat_id: string }>(",
        "    \"SELECT seat_id FROM sessions WHERE token_sha256 = $1\",",
        "    [token],",
        "  );",
        "  const row = rows.rows[0];",
        "  return row === undefined ? undefined : { seatId: row.seat_id };",
        "}",
      ].join("\n"),
    });
    const { code, out } = check(app);
    expect(out).not.toContain("OFFENDER");
    expect(code).toBe(0);
  });

  it("still catches a Spanish sentence sitting in a plain module", () => {
    // The other direction of the same gating: what a `.ts` module loses is
    // the POSITION rules, and it keeps both language rules — so a sentence
    // parked in a constant for a page to render is still an offender.
    const app = plant({
      "src/microcopy.ts":
        'export const REFUSED = "Pídele otro código a quien te invitó.";\n',
    });
    const { code, out } = check(app);
    expect(code).toBe(1);
    expect(out).toContain("src/microcopy.ts");
  });

  it("does not read a component's own early return as text it wraps", () => {
    // A COMPONENT THAT REFUSES FIRST writes `}` then `return (` then a tag,
    // and that middle run carries none of the four code-only characters — so
    // it read as text an element wraps (#221's link page drew it). `CODE_TAIL`
    // is the fence: a run ending in an opening parenthesis is code.
    const app = plant({
      "app/entrar/page.tsx": [
        'import { redirect } from "next/navigation";',
        'import { CHROME } from "@dito/copy";',
        "",
        "export default function Entrar({ ok }: { ok: boolean }) {",
        "  if (!ok) {",
        '    redirect("/otra");',
        "  }",
        "  return (",
        '    <main>{CHROME["login.title"]}</main>',
        "  );",
        "}",
      ].join("\n"),
    });
    const { code, out } = check(app);
    expect(out).not.toContain("OFFENDER");
    expect(code).toBe(0);
  });

  it("is green over the real rep-web, with the allowlist still empty", () => {
    // TICKET #221 AC 5, from the check's own side: "the copy CI check is
    // green over rep-web; no rep-facing literal outside the package". The CI
    // step is one line in a workflow and this file is where the rule is
    // proven to bite, so the claim is made in both places.
    const { code, out } = check(path.join(REPO, "apps/rep-web"), "--require-app");
    expect(out).not.toContain("OFFENDER");
    expect(code).toBe(0);
    expect(out).toContain("allowlist: 0 entry");
  });

  it("fails on a label a rendering attribute carries", () => {
    // The one place the JSX-text rule cannot reach: a word rendered from
    // inside a tag, with no accent for the orthography rule to catch.
    const app = plant({
      "app/clientes/page.tsx": [
        "export default function Clientes() {",
        '  return <input placeholder="Buscar" />;',
        "}",
      ].join("\n"),
    });
    const { code, out } = check(app);
    expect(code).toBe(1);
    expect(out).toContain("Buscar");
  });

  it("fails on a literal standing where a page's text stands (Codex r1)", () => {
    // POSITION, NOT LANGUAGE. «Enviar» is one accent-free word, so neither
    // Spanish rule can see it — and `<button>{"Enviar"}</button>` is the
    // same button with the same word in it as `<button>Enviar</button>`.
    // Three shapes in one page: a literal child, a braced attribute value,
    // and text that follows an interpolation rather than an opening tag.
    const app = plant({
      "app/page.tsx": [
        'import { CHROME } from "@dito/copy";',
        "",
        "export default function Inicio() {",
        "  return (",
        "    <div>",
        '      <button>{"Enviar"}</button>',
        '      <input placeholder={"Buscar"} />',
        '      <p>{CHROME["nav.inicio"]} y algo mas aqui</p>',
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    });
    const { code, out } = check(app);
    expect(code).toBe(1);
    for (const missed of ["Enviar", "Buscar", "y algo mas aqui"]) {
      expect(out, missed).toContain(missed);
    }
  });

  it("fails on a fragment, on text before an expression, and on a conditional label (Codex r2)", () => {
    // THREE MORE ORDINARY PAGE SHAPES, each needing a rule of its own.
    // `<p>Hola {name}</p>` puts the words BEFORE the expression, so the run
    // ends at a brace rather than at a tag; `<>Enviar</>` is a fragment,
    // whose opener carries no name; and `{ok ? "Enviar" : "Cancelar"}` is a
    // button label that depends on state, which is why a literal sits
    // inside an expression rather than alone in one.
    const app = plant({
      "app/page.tsx": [
        'import { CHROME } from "@dito/copy";',
        "",
        "export default function Inicio({ ok, name }: { ok: boolean; name: string }) {",
        "  return (",
        "    <div>",
        "      <p>Hola {name}</p>",
        "      <>Enviar</>",
        '      <button>{ok ? "Enviar" : "Cancelar"}</button>',
        '      <span>{CHROME["nav.inicio"]}</span>',
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    });
    const { code, out } = check(app);
    expect(code).toBe(1);
    for (const missed of ["Hola", "Enviar", "Cancelar"]) {
      expect(out, missed).toContain(missed);
    }
    // ...and the keyed span in the same file is NOT an offender, which is
    // what says the four rules read position rather than everything.
    expect(out).not.toContain("nav.inicio");
  });

  it("reads every spelling of a rendered literal, and no key (Codex r3)", () => {
    // ONE PAGE, SIX EXPRESSIONS, TWO OFFENDERS. A template literal and an
    // `&&` label are text a rep reads; a key — including the conditional
    // key this rule exists to make possible — a class list and a call's
    // argument are not, and the same walk is what tells them apart.
    const app = plant({
      "app/page.tsx": [
        'import { CHROME } from "@dito/copy";',
        "",
        "export default function Inicio({ ok, at }: { ok: boolean; at: Date }) {",
        "  return (",
        '    <div className={ok ? "flex gap-2" : "grid"}>',
        "      <button>{`Enviar`}</button>",
        '      <button>{ok && "Descartar"}</button>',
        '      <span>{CHROME[ok ? "draft.send" : "draft.dismiss"]}</span>',
        '      <span>{CHROME["nav.inicio"]}</span>',
        '      <time>{formatDate(at, "long")}</time>',
        "    </div>",
        "  );",
        "}",
        "",
        "declare function formatDate(at: Date, style: string): string;",
      ].join("\n"),
    });
    const { code, out } = check(app);
    expect(code).toBe(1);
    expect(out).toContain("Enviar");
    expect(out).toContain("Descartar");
    for (const legitimate of [
      "draft.send",
      "draft.dismiss",
      "nav.inicio",
      "flex gap-2",
      "long",
    ]) {
      expect(out, legitimate).not.toContain(legitimate);
    }
  });

  it("does not read a type annotation or a generic as text a page renders", () => {
    // The false positives the three fences exist for: `>` and `<` are also
    // operators and TypeScript's generics, and a page is full of both.
    const app = plant({
      "app/inicio/page.tsx": [
        'import { CHROME } from "@dito/copy";',
        "",
        "const rows: Array<string> = [];",
        "export const some = (a: number, b: number) => a < b && b > a;",
        "export const items = rows.map((row) => <li key={row}>{CHROME[\"nav.inicio\"]}</li>);",
        // A DESTRUCTURED PROPS TYPE, which is the shape a brace sits on both
        // sides of — `}: Props) {` — and the reason that one run is held to
        // a wider filter than the rest (Codex r2).
        "export function Card({ ok }: { ok: boolean }) {",
        "  return <li>{ok}</li>;",
        "}",
      ].join("\n"),
    });
    const { code, out } = check(app);
    expect(code, out).toBe(0);
  });

  it("still names what the rule cannot see", () => {
    // RECORDED RATHER THAN CLOSED, the way the rep-side sweep records its
    // own blind spots. An accent-free label bound to a constant and
    // rendered through an interpolation is invisible to all three rules:
    // the literal reads as neither Spanish nor prose, the JSX run is an
    // expression, and no attribute carries it. What holds it meanwhile is
    // that rep-web is a NEW app whose every string is a key from day one,
    // so such a constant would be a new line in a diff. Closing it means
    // constant-folding a TypeScript program rather than scanning it.
    const app = plant({
      "app/inicio/page.tsx": [
        'const LABEL = "Enviar";',
        "export default function Inicio() {",
        "  return <button>{LABEL}</button>;",
        "}",
      ].join("\n"),
    });
    expect(check(app).code).toBe(0);
    // ...and the same shape one step along: a literal inside a JSX
    // EXPRESSION rather than standing alone in one. `{ok ? "Yes" : "No"}`
    // is two accent-free labels the position rule cannot claim, because
    // what follows the brace is code. The Spanish ones would be caught by
    // the orthography rule; these would not.
    // ...and one the rules now DO catch, so the limit above is exactly the
    // one recorded and not a family: a conditional's branches are copy
    // (Codex r2), and only a literal reached through a variable is not.
    const ternary = plant({
      "app/inicio/page.tsx": [
        "export default function Inicio({ ok }: { ok: boolean }) {",
        '  return <span>{ok ? "Yes" : "No"}</span>;',
        "}",
      ].join("\n"),
    });
    expect(check(ternary).code).toBe(1);
    // A MIDDLE RUN CARRYING A COLON OR A PARENTHESIS is the price of the
    // wider filter on the brace-to-brace shape: `<p>{a} (sin confirmar)
    // {b}</p>` reads as the type annotation it cannot be told from.
    const middle = plant({
      "app/inicio/page.tsx": [
        "export default function Inicio({ a, b }: { a: string; b: string }) {",
        "  return <p>{a} (sin confirmar) {b}</p>;",
        "}",
      ].join("\n"),
    });
    expect(check(middle).code).toBe(0);
  });

  it("carries the rep-side sweep's two rules character for character", () => {
    // THE COPY IS DELIBERATE AND THE DRIFT IS NOT (the two-axis review's
    // Standards axis). Neither rule may be imported: a list of Spanish words
    // in a swept `src` would be the first offender the sweep next door
    // found, so `composed-language.test.ts` reproduces the owner twin's and
    // this script reproduces the rep side's — three copies, each on the
    // right side of the fence it guards.
    //
    // What that costs is drift, and this is the payment: the orthography
    // class and the function-word list are compared as TEXT against the
    // sweep that owns them, so a word added there and forgotten here is a
    // red build rather than a rule that quietly stopped agreeing with
    // itself. The scanner cannot be compared this way — one is typed and one
    // is not — and that remains recorded on this ticket.
    const sweep = readFileSync(
      path.join(REPO, "packages/twin-runtime/src/composed-language.test.ts"),
      "utf8",
    );
    const script = readFileSync(CHECK, "utf8");
    const orthography = /const ES_MX = (\/\[[^\n]*)/u;
    const words = /const ES_MX_FUNCTION_WORDS = \[([\s\S]*?)\];/u;
    expect(orthography.exec(script)?.[1]).toBe(orthography.exec(sweep)?.[1]);
    expect(words.exec(script)?.[1]).toBe(words.exec(sweep)?.[1]);
    // ...and neither pattern matched nothing, which would make the two
    // assertions above `undefined === undefined`.
    expect(orthography.exec(script)?.[1]).toContain("¿");
    expect(words.exec(script)?.[1]).toContain("tengo");
  });

  it("ships with an empty allowlist, and says how many entries it has", () => {
    // The allowlist is the record of what rep-web is still allowed to hold.
    // It is empty because rep-web holds nothing at all, and the count is in
    // the report so a future entry is a number a reviewer sees change.
    const { out } = check(plant({}));
    expect(out).toContain("allowlist: 0 entry(ies)");
  });
});
