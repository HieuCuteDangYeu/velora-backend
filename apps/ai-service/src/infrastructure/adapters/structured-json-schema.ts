import type { StructuredJsonType } from '@ai/domain/interfaces/structured-llm.service.interface';

export class StructuredSchemaViolation extends Error {
  constructor(
    readonly path: string,
    readonly constraint: string,
    readonly expectedType?: StructuredJsonType,
    readonly actualJsonType?: StructuredJsonType,
  ) {
    super('Structured schema violation');
  }
}

export function structuredJsonType(value: unknown): StructuredJsonType {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
}

export function validateStructuredSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): void {
  const type = schema['type'];
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new StructuredSchemaViolation(
        path,
        'type',
        'object',
        structuredJsonType(value),
      );
    const record = value as Record<string, unknown>;
    const properties = (schema['properties'] ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const required = Array.isArray(schema['required'])
      ? (schema['required'] as string[])
      : [];
    const missing = required.find((key) => !(key in record));
    if (missing)
      throw new StructuredSchemaViolation(`${path}.${missing}`, 'required');
    if (
      schema['additionalProperties'] === false &&
      Object.keys(record).some((key) => !(key in properties))
    )
      throw new StructuredSchemaViolation(path, 'additionalProperties');
    for (const [key, propertySchema] of Object.entries(properties))
      if (key in record)
        validateStructuredSchema(record[key], propertySchema, `${path}.${key}`);
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value))
      throw new StructuredSchemaViolation(
        path,
        'type',
        'array',
        structuredJsonType(value),
      );
    if (
      typeof schema['minItems'] === 'number' &&
      value.length < schema['minItems']
    )
      throw new StructuredSchemaViolation(path, 'minItems');
    if (
      typeof schema['maxItems'] === 'number' &&
      value.length > schema['maxItems']
    )
      throw new StructuredSchemaViolation(path, 'maxItems');
    const items = schema['items'];
    if (items && typeof items === 'object')
      value.forEach((item, index) =>
        validateStructuredSchema(
          item,
          items as Record<string, unknown>,
          `${path}[${index}]`,
        ),
      );
    return;
  }
  if (type === 'string' && typeof value !== 'string')
    throw new StructuredSchemaViolation(
      path,
      'type',
      'string',
      structuredJsonType(value),
    );
  if (typeof value === 'string' && type === 'string') {
    if (
      typeof schema['minLength'] === 'number' &&
      value.length < schema['minLength']
    )
      throw new StructuredSchemaViolation(path, 'minLength');
    if (
      typeof schema['maxLength'] === 'number' &&
      value.length > schema['maxLength']
    )
      throw new StructuredSchemaViolation(path, 'maxLength');
  }
  if (type === 'boolean' && typeof value !== 'boolean')
    throw new StructuredSchemaViolation(
      path,
      'type',
      'boolean',
      structuredJsonType(value),
    );
  if (
    (type === 'number' || type === 'integer') &&
    (typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (type === 'integer' && !Number.isInteger(value)))
  )
    throw new StructuredSchemaViolation(
      path,
      'type',
      'number',
      structuredJsonType(value),
    );
  if (typeof value === 'number' && (type === 'number' || type === 'integer')) {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum'])
      throw new StructuredSchemaViolation(path, 'minimum');
    if (typeof schema['maximum'] === 'number' && value > schema['maximum'])
      throw new StructuredSchemaViolation(path, 'maximum');
  }
  const allowed = schema['enum'];
  if (Array.isArray(allowed) && !allowed.includes(value))
    throw new StructuredSchemaViolation(path, 'enum');
}
