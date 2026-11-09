// A pure copy of aepm's template rules (aepm/application.py: configuration, substitute) for the settings the tests render.

export interface Declaration { id: string; type: "string" | "boolean" | "integer"; grammar: string; required: boolean; secret: boolean; default?: string | boolean | number }

const GRAMMARS: Record<string, RegExp> = {
  identifier: /^[A-Za-z][A-Za-z0-9_]{0,63}$/,
  qualified: /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/,
  slug: /^[a-z][a-z0-9-]{0,63}$/,
  label: /^[A-Za-z][A-Za-z0-9 -]{0,63}$/,
  environment: /^[A-Z][A-Z0-9_]{0,63}$/,
  address: /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9_/-]*)?$/,
};
const TOKEN = /\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/g;

export class TemplateError extends Error {}

// The values a template sees: supplied or default, grammar-checked; an optional setting with neither has no value.
export function configuration(declarations: Declaration[], supplied: Record<string, unknown>): Record<string, string | boolean | number> {
  const known = new Map(declarations.map((item) => [item.id, item]));
  for (const key of Object.keys(supplied)) if (!known.has(key)) throw new TemplateError(`unknown-setting ${key}`);
  const result: Record<string, string | boolean | number> = {};
  for (const [key, setting] of known) {
    if (!(key in supplied) && setting.default === undefined) {
      if (setting.required) throw new TemplateError(`required-setting ${key}`);
      continue;
    }
    const value = key in supplied ? supplied[key] : setting.default;
    if (setting.type === "boolean") { if (typeof value !== "boolean") throw new TemplateError(`setting-type ${key}`); }
    else if (setting.type === "integer") { if (!Number.isInteger(value)) throw new TemplateError(`setting-type ${key}`); }
    else if (typeof value !== "string" || !(GRAMMARS[setting.grammar]?.test(value))) throw new TemplateError(`setting-grammar ${key}`);
    result[key] = value as string | boolean | number;
  }
  return result;
}

// Replaces {{setting}} in a source file. A string setting must sit inside a quoted string on its line.
export function substitute(text: string, declarations: Declaration[], values: Record<string, string | boolean | number>): string {
  const known = new Map(declarations.map((item) => [item.id, item]));
  const remainder = text.replace(TOKEN, "");
  if (remainder.includes("{{") || remainder.includes("}}")) throw new TemplateError("template-token");
  return text.replace(TOKEN, (match, key: string, offset: number) => {
    if ((offset > 0 && text[offset - 1] === "{") || (offset + match.length < text.length && text[offset + match.length] === "}")) throw new TemplateError("template-token");
    const setting = known.get(key);
    if (!setting || !(key in values) || setting.secret) throw new TemplateError(`template-setting ${key}`);
    if (setting.type === "string") {
      let quoted: string | null = null;
      let escaped = false;
      for (const char of text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset)) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (quoted) { if (char === quoted) quoted = null; }
        else if (char === "'" || char === '"') quoted = char;
      }
      if (quoted === null) throw new TemplateError(`template-string-position ${key}`);
    }
    return String(values[key]);
  });
}
