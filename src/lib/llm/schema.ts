/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Structured Output
 *  A small runtime validator plus the JSON-extraction rules models
 *  actually need (fenced blocks, prose preambles, trailing chatter).
 * ═══════════════════════════════════════════════════════════════
 */

import type { SchemaNode } from './types';

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

/* ─────────────────────────────────────────────────────────────
   Extraction
   ───────────────────────────────────────────────────────────── */

const FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * Pulls the first JSON value out of a model response. Models routinely wrap
 * JSON in fences or bracket it with prose, and failing the whole run over that
 * wastes a step that produced perfectly good data.
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates: string[] = [];

  const fenced = FENCE.exec(text);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);

  const balanced = firstBalancedSpan(text);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch {
      // Try the next candidate.
    }
  }
  return { ok: false, error: 'No parseable JSON found in model output.' };
}

/** Scans for the first balanced `{...}` or `[...]`, ignoring braces inside strings. */
function firstBalancedSpan(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/* ─────────────────────────────────────────────────────────────
   Validation
   ───────────────────────────────────────────────────────────── */

export function validate<T = unknown>(value: unknown, schema: SchemaNode): ValidationResult<T> {
  const errors: string[] = [];
  check(value, schema, '$', errors);
  return errors.length === 0
    ? { ok: true, value: value as T, errors: [] }
    : { ok: false, errors };
}

function check(value: unknown, schema: SchemaNode, path: string, errors: string[]): void {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return void errors.push(`${path}: expected string, got ${typeName(value)}`);
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`${path}: expected one of ${schema.enum.join(', ')}, got "${value}"`);
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${path}: shorter than ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${path}: longer than ${schema.maxLength} characters`);
      }
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return void errors.push(`${path}: expected number, got ${typeName(value)}`);
      }
      if (schema.integer && !Number.isInteger(value)) errors.push(`${path}: expected an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path}: below minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${path}: above maximum ${schema.maximum}`);
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeName(value)}`);
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) return void errors.push(`${path}: expected array, got ${typeName(value)}`);
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path}: expected at least ${schema.minItems} items, got ${value.length}`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path}: expected at most ${schema.maxItems} items, got ${value.length}`);
      }
      value.forEach((item, index) => check(item, schema.items, `${path}[${index}]`, errors));
      return;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return void errors.push(`${path}: expected object, got ${typeName(value)}`);
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record) || record[key] === undefined || record[key] === null) {
          errors.push(`${path}.${key}: required`);
        }
      }
      for (const [key, child] of Object.entries(schema.properties)) {
        if (key in record && record[key] !== undefined && record[key] !== null) {
          check(record[key], child, `${path}.${key}`, errors);
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in schema.properties)) errors.push(`${path}.${key}: unexpected property`);
        }
      }
    }
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/* ─────────────────────────────────────────────────────────────
   Prompting
   ───────────────────────────────────────────────────────────── */

/** Renders a schema as the compact shape description that goes into a prompt. */
export function describeSchema(schema: SchemaNode, indent = 0): string {
  const pad = '  '.repeat(indent);
  switch (schema.type) {
    case 'object': {
      const required = new Set(schema.required ?? []);
      const lines = Object.entries(schema.properties).map(([key, child]) => {
        const flag = required.has(key) ? '' : '?';
        const note = child.description ? `  // ${child.description}` : '';
        return `${pad}  "${key}"${flag}: ${describeSchema(child, indent + 1)}${note}`;
      });
      return `{\n${lines.join('\n')}\n${pad}}`;
    }
    case 'array':
      return `${describeSchema(schema.items, indent)}[]`;
    case 'string':
      return schema.enum ? schema.enum.map((v) => `"${v}"`).join(' | ') : 'string';
    default:
      return schema.type;
  }
}
