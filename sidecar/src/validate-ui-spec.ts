/**
 * Render-time validator for generated UI specs (fail-closed).
 *
 * The LLM's output is DATA. This module is the architectural safety boundary:
 * a spec renders only if every component is a known type, references only
 * registered capabilities, carries no unknown keys, and binds nothing but
 * `$selection.<field>`. Anything else → rejected with reasons; the renderer
 * shows the error and renders nothing from the spec.
 *
 * Zero dependencies. Same shape as the BuildSpec validator: collect ALL
 * errors, never throw, boolean verdict + reasons.
 */

export type UiAction = { capability: string; params?: Record<string, unknown> };
export type UiData = { capability: string; derive?: string; params?: Record<string, unknown> };
export type UiComponent = {
  id: string;
  type: "button" | "list" | "chart" | "filter" | "text";
  label?: string;
  title?: string;
  text?: string;
  chart?: "bar";
  selectable?: boolean;
  action?: UiAction;
  data?: UiData;
  field?: string; // filter only: which $selection field it sets
};
export type UiSpec = { version: 1; workspace: string; components: UiComponent[] };
type CapabilitySchema = { params?: Record<string, unknown> };
type CapabilityRegistry = ReadonlySet<string> | Record<string, CapabilitySchema>;

const MAX_COMPONENTS = 32;
const MAX_TEXT = 200;
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SELECTION_RE = /^\$selection\.[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const FILTER_RE = /^\$filter\.[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const DERIVES = new Set(["frequency.day", "frequency.week"]);

// Exact allowed keys per component type — extra keys are rejected, not ignored.
const KEYS: Record<UiComponent["type"], ReadonlySet<string>> = {
  button: new Set(["id", "type", "label", "action"]),
  list: new Set(["id", "type", "title", "data", "selectable"]),
  chart: new Set(["id", "type", "title", "chart", "data"]),
  filter: new Set(["id", "type", "label", "field", "data"]),
  text: new Set(["id", "type", "text"]),
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safeText(v: unknown, what: string, errors: string[]): void {
  if (v === undefined) return;
  if (typeof v !== "string") return void errors.push(`${what} must be a string`);
  if (v.length === 0 || v.length > MAX_TEXT) return void errors.push(`${what} length must be 1..${MAX_TEXT}`);
  // No markup, no control chars: labels/titles are rendered as textContent
  // anyway, but a spec carrying them is malformed by contract.
  if (/[<>\x00-\x1f]/.test(v)) errors.push(`${what} contains forbidden characters`);
}

function isCapabilitySet(registry: CapabilityRegistry): registry is ReadonlySet<string> {
  return typeof (registry as { has?: unknown }).has === "function";
}

function registryHas(registry: CapabilityRegistry, capability: string): boolean {
  return isCapabilitySet(registry) ? registry.has(capability) : Object.prototype.hasOwnProperty.call(registry, capability);
}

function registryParams(registry: CapabilityRegistry, capability: string): ReadonlySet<string> | undefined {
  if (isCapabilitySet(registry)) return undefined;
  return new Set(Object.keys(registry[capability]?.params ?? {}));
}

function checkParams(
  params: unknown,
  capability: string,
  allowed: ReadonlySet<string> | undefined,
  where: string,
  errors: string[],
  options: { allowFilterBinding?: boolean } = {},
): void {
  if (params === undefined) return;
  if (!isRecord(params)) return void errors.push(`${where}.params must be an object`);
  for (const [k, v] of Object.entries(params)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k)) errors.push(`${where}.params key '${k}' invalid`);
    if (allowed && !allowed.has(k)) errors.push(`${where}.params.${k} is not declared by capability '${capability}'`);
    const validBinding = typeof v === "string" && (SELECTION_RE.test(v) || (options.allowFilterBinding && FILTER_RE.test(v)));
    if (!validBinding) {
      errors.push(`${where}.params.${k} must be a ${options.allowFilterBinding ? "$selection.<field> or $filter.<field>" : "$selection.<field>"} binding`);
    }
  }
  if (allowed) {
    for (const required of allowed) {
      if (!(required in params)) errors.push(`${where}.params.${required} is required`);
    }
  }
}

export function validateUiSpec(
  input: unknown,
  registry: CapabilityRegistry,
): { ok: true; spec: UiSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["spec must be a JSON object"] };

  for (const key of Object.keys(input)) {
    if (!["version", "workspace", "components"].includes(key)) errors.push(`unknown top-level key '${key}'`);
  }
  if (input.version !== 1) errors.push("version must be 1");
  if (typeof input.workspace !== "string" || input.workspace.length === 0 || input.workspace.length > 64) {
    errors.push("workspace must be a non-empty string (<=64 chars)");
  }
  if (!Array.isArray(input.components)) {
    errors.push("components must be an array");
    return { ok: false, errors };
  }
  if (input.components.length === 0) errors.push("components must not be empty");
  if (input.components.length > MAX_COMPONENTS) errors.push(`components exceeds max of ${MAX_COMPONENTS}`);

  const seenIds = new Set<string>();
  input.components.forEach((c, i) => {
    const where = `components[${i}]`;
    if (!isRecord(c)) return void errors.push(`${where} must be an object`);

    const type = c.type as UiComponent["type"];
    if (typeof type !== "string" || !(type in KEYS)) {
      return void errors.push(`${where}.type '${String(c.type)}' is not a registered component type`);
    }
    for (const key of Object.keys(c)) {
      if (!KEYS[type].has(key)) errors.push(`${where} ('${type}') has unknown key '${key}'`);
    }

    if (typeof c.id !== "string" || !ID_RE.test(c.id)) errors.push(`${where}.id must match ${ID_RE}`);
    else if (seenIds.has(c.id)) errors.push(`${where}.id '${c.id}' is duplicated`);
    else seenIds.add(c.id);

    safeText(c.label, `${where}.label`, errors);
    safeText(c.title, `${where}.title`, errors);
    safeText(c.text, `${where}.text`, errors);
    if (c.selectable !== undefined && typeof c.selectable !== "boolean") errors.push(`${where}.selectable must be boolean`);
    if (type === "chart" && c.chart !== "bar") errors.push(`${where}.chart must be 'bar'`);
    if (type === "filter") safeText(c.field, `${where}.field`, errors);
    if (type === "filter" && c.field === undefined) errors.push(`${where}.field is required for filters`);

    if (type === "button") {
      if (!isRecord(c.action)) errors.push(`${where}.action is required for buttons`);
      else {
        for (const key of Object.keys(c.action)) {
          if (!["capability", "params"].includes(key)) errors.push(`${where}.action has unknown key '${key}'`);
        }
        if (typeof c.action.capability !== "string" || !registryHas(registry, c.action.capability)) {
          errors.push(`${where}.action.capability '${String(c.action.capability)}' is not in the capability registry`);
        }
        const capability = typeof c.action.capability === "string" ? c.action.capability : "";
        checkParams(c.action.params, capability, registryParams(registry, capability), `${where}.action`, errors);
      }
    }

    if (c.data !== undefined) {
      if (!isRecord(c.data)) errors.push(`${where}.data must be an object`);
      else {
        for (const key of Object.keys(c.data)) {
          if (!["capability", "derive", "params"].includes(key)) errors.push(`${where}.data has unknown key '${key}'`);
        }
        if (typeof c.data.capability !== "string" || !registryHas(registry, c.data.capability)) {
          errors.push(`${where}.data.capability '${String(c.data.capability)}' is not in the capability registry`);
        }
        const capability = typeof c.data.capability === "string" ? c.data.capability : "";
        checkParams(c.data.params, capability, registryParams(registry, capability), `${where}.data`, errors, { allowFilterBinding: true });
        if (c.data.derive !== undefined && (typeof c.data.derive !== "string" || !DERIVES.has(c.data.derive))) {
          errors.push(`${where}.data.derive '${String(c.data.derive)}' is not a known derivation`);
        }
      }
    }
    if ((type === "list" || type === "chart") && c.data === undefined) {
      errors.push(`${where} ('${type}') requires data`);
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, spec: input as UiSpec };
}
