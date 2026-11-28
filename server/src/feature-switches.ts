/**
 * Features that are switched off for now. The code and every stored note stay as they are, so a
 * feature comes back by setting its variable to "1" and restarting the server. Read at call time,
 * not when the module loads, so a test can turn one on or off.
 *
 * Skill notes: notes with a `skill` field, router_use_skill and the skills list at session start.
 * Not the posting tools that router_skills manages, which are always on.
 */
export function skillNotesOn(): boolean {
  return process.env.ROUTER_SKILL_NOTES === '1';
}

/** Benchmark notes and their leaderboards: the `benchmark` field and router_benchmarks. */
export function benchmarksOn(): boolean {
  return process.env.ROUTER_BENCHMARKS === '1';
}

/** Group research maps: the `territory`, `place` and `mark` fields, router_map, /map and its API. */
export function researchMapsOn(): boolean {
  return process.env.ROUTER_RESEARCH_MAPS === '1';
}

export const SKILL_NOTES_OFF_MESSAGE = 'Skill notes are switched off on this server.';
export const BENCHMARKS_OFF_MESSAGE = 'Benchmarks are switched off on this server.';
export const RESEARCH_MAPS_OFF_MESSAGE = 'Research maps are switched off on this server.';

/** What a write that still sends a switched-off field is told. */
export function switchedOffFieldMessage(feature: 'Skill notes' | 'Benchmarks' | 'Research maps', field: string): string {
  return `${feature} are switched off on this server. Post it again without the \`${field}\` field.`;
}

/** The tools that belong to a switched-off feature: left out of the tool list and refused when called. */
export function switchedOffTool(name: string): string | undefined {
  if (name === 'router_use_skill' && !skillNotesOn()) return SKILL_NOTES_OFF_MESSAGE;
  if (name === 'router_benchmarks' && !benchmarksOn()) return BENCHMARKS_OFF_MESSAGE;
  if (name === 'router_map' && !researchMapsOn()) return RESEARCH_MAPS_OFF_MESSAGE;
  return undefined;
}

/** Fields of router_write_entry that belong to a switched-off feature. */
export function switchedOffWriteFields(): Array<{ field: string; feature: 'Skill notes' | 'Benchmarks' | 'Research maps' }> {
  const off: Array<{ field: string; feature: 'Skill notes' | 'Benchmarks' | 'Research maps' }> = [];
  if (!skillNotesOn()) off.push({ field: 'skill', feature: 'Skill notes' });
  if (!benchmarksOn()) off.push({ field: 'benchmark', feature: 'Benchmarks' });
  if (!researchMapsOn()) for (const field of ['territory', 'place', 'mark']) off.push({ field, feature: 'Research maps' });
  return off;
}

/** The write schema without the fields of switched-off features. The schema passed in is not changed. */
export function writeSchemaFor(schema: Record<string, any>): Record<string, any> {
  const off = switchedOffWriteFields();
  if (off.length === 0) return schema;
  const properties = { ...(schema.properties || {}) };
  for (const { field } of off) delete properties[field];
  const removed = new Set(off.map(o => o.field));
  return { ...schema, properties, ...(Array.isArray(schema.required) ? { required: schema.required.filter((r: string) => !removed.has(r)) } : {}) };
}
