/**
 * comparison/bench-v2/spread-probe.ts — subprocess harness for the F13
 * spread-push repro, invoked by fix-matrix.ts as a FRESH process per engine:
 *
 *   bun run comparison/bench-v2/spread-probe.ts <new|old>
 *
 * It clears a very large keyed array (N items -> []). The OLD engine emitted the
 * removal ops with `patches.push(...removalPatches)`; spread arguments ride the
 * call stack, so past a runtime-specific arg cap this throws an UNCATCHABLE-in-
 * caller RangeError and the process exits non-zero — which is exactly why it
 * must run in a child so it cannot abort the matrix. The NEW engine emits with a
 * plain loop and completes. On success it prints a JSON line { ok, len, first }.
 */
import * as NEW from "../../src/index";
import * as OLD from "fjsp-v040";

const which = process.argv[2];
const N = 800_000;
const users = new Array(N);
for (let i = 0; i < N; i++) users[i] = { id: `u${i}`, name: `n${i}` };
const schema = {
  type: "object",
  properties: {
    users: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
  },
};

if (which === "new") {
  const plan = NEW.buildPlan({ schema: schema as never });
  const patch = new NEW.JsonSchemaPatcher({ plan }).execute({
    original: { users },
    modified: { users: [] },
  }) as { path: string }[];
  process.stdout.write(
    `${JSON.stringify({ ok: true, len: patch.length, first: patch[0]?.path })}\n`,
  );
} else if (which === "old") {
  const plan = (OLD as any).buildPlan({ schema });
  const patch = new (OLD as any).JsonSchemaPatcher({ plan }).execute({
    original: { users },
    modified: { users: [] },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, len: patch.length, first: patch[0]?.path })}\n`);
} else {
  console.error("usage: spread-probe.ts <new|old>");
  process.exit(2);
}
