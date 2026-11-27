import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { enabledTraceModels, traceAccessTool } from './trace-access-tool.js';
import { SYSTEM_SKILLS } from './http.js';

/** SHA-256 of JSON.stringify({description, inputSchema}) of router_trace_access with no model providers enabled (includes pair_start/pair_poll). */
const MASTER_TOOL_SHA256 = '0d2c42471ede1b9ccbec65c7c24b17772fe4c9763c95e3167a67f756de40a6a0';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('router_trace_access as agents read it', () => {
  it('says nothing about models or keys while no provider is enabled, exactly as before model calls', () => {
    const off = traceAccessTool([]);
    expect(sha256(JSON.stringify(off))).toBe(MASTER_TOOL_SHA256);
    const text = JSON.stringify(off);
    for (const word of ['model_key', 'language model', 'redpill', 'tinfoil', 'replies']) expect(text).not.toContain(word);
    // This test process has no TRACE_MODELS, so the server's own tool list is the same.
    const served = SYSTEM_SKILLS.find(s => s.name === 'router_trace_access')!;
    expect(JSON.stringify({ description: served.description, inputSchema: served.inputSchema })).toBe(text);
  });

  it('offers the model fields, for the enabled providers only, and says the key stays in the agent\'s own log', () => {
    const on = traceAccessTool(['redpill']);
    const schema = on.inputSchema.properties as any;
    expect(schema.model.properties.provider.enum).toEqual(['redpill']);
    expect(schema.model_key.type).toBe('string');
    expect(on.description).toContain('return {ask: prompt}');
    expect(on.description).toContain('(here redpill)');
    expect(on.description).toContain('The key you send stays in your own conversation log, so make a key for this with a small spending limit.');
    expect(on.description).not.toMatch(/\bClaudes?\b/);
    expect((traceAccessTool(['redpill', 'tinfoil']).inputSchema.properties as any).model.properties.provider.enum).toEqual(['redpill', 'tinfoil']);
  });

  it('reads the enabled providers from TRACE_MODELS, ignoring anything that is not an attested provider', () => {
    expect(enabledTraceModels(undefined)).toEqual([]);
    expect(enabledTraceModels('')).toEqual([]);
    expect(enabledTraceModels(' Tinfoil , openai,redpill')).toEqual(['redpill', 'tinfoil']);
    expect(enabledTraceModels('anthropic')).toEqual([]);
  });
});
