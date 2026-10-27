import { z } from 'zod';

// Strip unexpected fields before a stress agent response reaches the browser.
const Text = (max: number) => z.string().max(max);
const Values = z.record(z.string().max(30), z.union([z.number(), z.boolean()]));

const Field = z.object({
  key: Text(30),
  label: Text(80),
  type: z.enum(['number', 'boolean']),
  unit: Text(20).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  disabled: z.boolean().optional(),
});
const Scenario = z.object({
  id: Text(20),
  title: Text(60),
  description: Text(300),
  fields: z.array(Field).max(10),
  presets: z
    .array(z.object({ id: Text(20), label: Text(40), values: Values }))
    .max(6),
});
const RunSchema = z.object({
  id: z.string().uuid(),
  scenario: z.enum(['chat', 'sockets', 'calls', 'mixed']),
  params: Values,
  status: z.enum(['running', 'stopping', 'passed', 'failed', 'cancelled']),
  phase: Text(60),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  estimatedSeconds: z.number().finite().nonnegative(),
  reason: Text(300).nullable(),
  metrics: z
    .array(
      z.object({
        label: Text(60),
        value: Text(60),
        bad: z.boolean().optional(),
      }),
    )
    .max(10),
  failures: z.array(Text(300)).max(20),
});
const StateSchema = z.object({
  available: z.literal(true),
  busy: z.boolean(),
  scenarios: z.array(Scenario).max(10),
  active: RunSchema.nullable(),
  recent: z.array(RunSchema).max(5),
});
export const StressRunsResponseSchema = z.union([StateSchema, RunSchema]);
