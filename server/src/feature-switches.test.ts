import { describe, it, expect, afterEach } from 'vitest';
import { skillNotesOn, benchmarksOn, researchMapsOn, switchedOffTool, writeSchemaFor } from './feature-switches.js';

const VARS = ['ROUTER_SKILL_NOTES', 'ROUTER_BENCHMARKS', 'ROUTER_RESEARCH_MAPS'] as const;
const saved = Object.fromEntries(VARS.map(v => [v, process.env[v]]));
const set = (values: Partial<Record<typeof VARS[number], string | undefined>>) => {
  for (const v of VARS) { if (values[v] === undefined) delete process.env[v]; else process.env[v] = values[v]; }
};
afterEach(() => set(saved));

describe('feature switches', () => {
  it('are off unless set to exactly "1", and are read at call time', () => {
    set({});
    expect([skillNotesOn(), benchmarksOn(), researchMapsOn()]).toEqual([false, false, false]);
    for (const value of ['0', 'true', 'on', 'yes', ' 1', '']) {
      set({ ROUTER_SKILL_NOTES: value, ROUTER_BENCHMARKS: value, ROUTER_RESEARCH_MAPS: value });
      expect([skillNotesOn(), benchmarksOn(), researchMapsOn()], JSON.stringify(value)).toEqual([false, false, false]);
    }
    set({ ROUTER_SKILL_NOTES: '1', ROUTER_BENCHMARKS: '1', ROUTER_RESEARCH_MAPS: '1' });
    expect([skillNotesOn(), benchmarksOn(), researchMapsOn()]).toEqual([true, true, true]);
  });

  it('name the tools of a switched-off feature and leave every other tool alone', () => {
    set({});
    expect(switchedOffTool('router_use_skill')).toBe('Skill notes are switched off on this server.');
    expect(switchedOffTool('router_benchmarks')).toBe('Benchmarks are switched off on this server.');
    expect(switchedOffTool('router_map')).toBe('Research maps are switched off on this server.');
    for (const name of ['router_skills', 'router_skills_browse', 'router_skills_clone', 'router_write_entry', 'skill_anything', 'channel_books_review']) {
      expect(switchedOffTool(name), name).toBeUndefined();
    }
    set({ ROUTER_SKILL_NOTES: '1', ROUTER_BENCHMARKS: '1', ROUTER_RESEARCH_MAPS: '1' });
    for (const name of ['router_use_skill', 'router_benchmarks', 'router_map']) expect(switchedOffTool(name), name).toBeUndefined();
  });

  it('take only the switched-off fields out of the write schema, and leave it unchanged when all are on', () => {
    // The shape of router_write_entry's schema; the served schema itself is checked through the server in features-off.integration.test.ts.
    const schema = { type: 'object', properties: Object.fromEntries(['entry', 'client', 'to', 'skill', 'benchmark', 'territory', 'place', 'mark'].map(k => [k, { type: 'string' }])), required: ['entry', 'mark'] };
    const before = JSON.stringify(schema);
    set({});
    const off = writeSchemaFor(schema);
    for (const field of ['skill', 'benchmark', 'territory', 'place', 'mark']) expect(Object.keys(off.properties), field).not.toContain(field);
    expect(Object.keys(off.properties).length).toBe(Object.keys(schema.properties).length - 5);
    expect(off.required).toEqual(['entry']);
    expect(JSON.stringify(schema)).toBe(before);
    set({ ROUTER_BENCHMARKS: '1' });
    expect(Object.keys(writeSchemaFor(schema).properties)).toContain('benchmark');
    expect(Object.keys(writeSchemaFor(schema).properties)).not.toContain('skill');
    set({ ROUTER_SKILL_NOTES: '1', ROUTER_BENCHMARKS: '1', ROUTER_RESEARCH_MAPS: '1' });
    expect(writeSchemaFor(schema)).toBe(schema);
  });
});
