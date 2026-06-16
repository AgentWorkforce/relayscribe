import assert from "node:assert";
import { CAPABILITY_REGISTRY } from "./ui-registry";
import { validateUiSpec } from "./validate-ui-spec";

const REGISTRY = CAPABILITY_REGISTRY;

// 1. GenUI's design-post example spec must validate as-is.
const designExample = {
  version: 1,
  workspace: "ws-demo",
  components: [
    { id: "c1", type: "list", title: "Recordings", data: { capability: "data.recordings" }, selectable: true },
    { id: "c2", type: "chart", chart: "bar", title: "Meetings per week",
      data: { capability: "data.recordings", derive: "frequency.week" } },
    { id: "c3", type: "list", title: "Transcript",
      data: { capability: "data.transcript", params: { sessionId: "$selection.sessionId" } } },
    { id: "c4", type: "filter", label: "Search transcripts", field: "query" },
    { id: "c5", type: "list", title: "Transcript matches",
      data: { capability: "data.transcriptSearch", params: { query: "$filter.query" } } },
  ],
};
assert.deepEqual(validateUiSpec(designExample, REGISTRY).ok, true, "design example must pass");

// 2. Fail-closed vectors — every one must be rejected.
const reject = (mutate: (s: any) => void, why: string) => {
  const s = JSON.parse(JSON.stringify(designExample));
  mutate(s);
  const r = validateUiSpec(s, REGISTRY);
  assert.equal(r.ok, false, `must reject: ${why}`);
};

reject((s) => (s.components[0].type = "script"), "unregistered component type");
reject((s) => (s.components[0].data.capability = "shell.exec"), "capability outside registry");
reject((s) => (s.components[0].onClick = "fetch('https://evil')"), "unknown key on component");
reject((s) => (s.components[2].data.url = "https://evil"), "unknown key on data");
reject((s) => (s.components[2].data.params.sessionId = "$workspace.secrets"), "non-selection binding");
reject((s) => (s.components[2].data.params.sessionId = "fixture-session"), "literal data param");
reject((s) => (s.components[2].data.params.extra = "$selection.sessionId"), "undeclared data param");
reject((s) => (delete s.components[2].data.params.sessionId), "missing declared data param");
reject((s) => (s.components[0].title = "<img src=x onerror=alert(1)>"), "markup in title");
reject((s) => (s.components[1].data.derive = "eval"), "unknown derivation");
reject((s) => (s.components[1].data.derive = "frequency.month"), "unsupported derivation");
reject((s) => (s.components[1].chart = "line"), "unsupported chart type");
reject((s) => (s.components[0].data = undefined), "list without data");
reject((s) => (s.components.push(...Array(40).fill(s.components[0]))), "too many components + dup ids");
reject((s) => (s.version = 2), "wrong version");
reject((s) => (s.extra = {}), "unknown top-level key");
reject((s) => (s.components[2].data.params.sessionId = { nested: true }), "non-selection param");

// 3. Empty registry rejects everything with capabilities.
assert.equal(validateUiSpec(designExample, new Set()).ok, false, "empty registry must reject");

// 4. Error reporting: collects multiple reasons, never throws.
const bad = validateUiSpec({ version: 2, workspace: "", components: [{ id: "X!", type: "iframe" }], junk: 1 }, REGISTRY);
assert.equal(bad.ok, false);
if (!bad.ok) assert.ok(bad.errors.length >= 4, `expected >=4 errors, got: ${bad.errors.join(" | ")}`);

console.log("validate-ui-spec: all assertions passed (1 accept, 17 reject vectors, error aggregation)");
