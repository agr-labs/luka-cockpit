// A deliberately small schema validator.
//
// It validates; it never coerces and never clamps. A joint value outside its
// limit is a refusal with the binding limit in the error, not a silent rewrite:
// an audit trail that records a different number than the client sent is worse
// than no audit trail.
//
// Supported keywords: type, required, properties, additionalProperties,
// allowedKeys, minProperties, maxProperties, min, max, exclusiveMin/Max,
// minLength, maxLength, pattern, enum, items, minItems, maxItems, integer.

const TYPES = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

export function validate(schema, value, path = '$') {
  const errors = [];
  walk(schema, value, path, errors);
  return errors;
}

function err(errors, path, keyword, message, extra = {}) {
  errors.push({ path, keyword, message, ...extra });
}

function walk(schema, value, path, errors) {
  if (schema === undefined || schema === null) return;

  if (schema.type) {
    const check = TYPES[schema.type];
    if (!check || !check(value)) {
      err(errors, path, 'type', `expected ${schema.type}`, {
        expected: schema.type,
        actual: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
      });
      return; // further checks are meaningless against the wrong type
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    err(errors, path, 'enum', `must be one of: ${schema.enum.join(', ')}`, { allowed: schema.enum });
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof schema.min === 'number' && value < schema.min) {
      err(errors, path, 'minimum', `must be >= ${schema.min}`, { limit: 'minimum', bound: schema.min, value });
    }
    if (typeof schema.max === 'number' && value > schema.max) {
      err(errors, path, 'maximum', `must be <= ${schema.max}`, { limit: 'maximum', bound: schema.max, value });
    }
    if (typeof schema.exclusiveMin === 'number' && value <= schema.exclusiveMin) {
      err(errors, path, 'exclusiveMinimum', `must be > ${schema.exclusiveMin}`, {
        limit: 'exclusiveMinimum', bound: schema.exclusiveMin, value,
      });
    }
    if (typeof schema.exclusiveMax === 'number' && value >= schema.exclusiveMax) {
      err(errors, path, 'exclusiveMaximum', `must be < ${schema.exclusiveMax}`, {
        limit: 'exclusiveMaximum', bound: schema.exclusiveMax, value,
      });
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      err(errors, path, 'minLength', `must be at least ${schema.minLength} characters`, { limit: 'minLength', bound: schema.minLength });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      err(errors, path, 'maxLength', `must be at most ${schema.maxLength} characters`, { limit: 'maxLength', bound: schema.maxLength });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      err(errors, path, 'pattern', `must match ${schema.pattern}`, { limit: 'pattern', bound: schema.pattern });
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      err(errors, path, 'format', 'must be an ISO-8601 timestamp');
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      err(errors, path, 'minItems', `must contain at least ${schema.minItems} item(s)`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      err(errors, path, 'maxItems', `must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.items) value.forEach((v, i) => walk(schema.items, v, `${path}[${i}]`, errors));
  }

  if (TYPES.object(value)) {
    const keys = Object.keys(value);
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      err(errors, path, 'minProperties', `must set at least ${schema.minProperties} field(s)`);
    }
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
      err(errors, path, 'maxProperties', `must set at most ${schema.maxProperties} field(s)`);
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) err(errors, `${path}.${key}`, 'required', 'is required', { field: key });
    }
    if (schema.allowedKeys && !schema.properties && !schema.allowAnyKeys) {
      for (const key of keys) {
        if (!schema.allowedKeys.includes(key)) {
          err(errors, `${path}.${key}`, 'additionalProperties', `unknown field; allowed: ${schema.allowedKeys.join(', ')}`, { field: key });
        }
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) walk(sub, value[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of keys) {
        if (!known.has(key)) {
          err(errors, `${path}.${key}`, 'additionalProperties', 'unknown field', { field: key });
        }
      }
    }
  }
}

/** Compact "a.b must be <= 1" strings for logs and UI. */
export function summarizeErrors(errors, limit = 3) {
  const parts = errors.slice(0, limit).map((e) => `${e.path} ${e.message}`);
  if (errors.length > limit) parts.push(`+${errors.length - limit} more`);
  return parts.join('; ');
}
