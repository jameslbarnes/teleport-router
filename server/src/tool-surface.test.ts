import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SYSTEM_SKILLS, TOOL_DESCRIPTION, SEARCH_TOOL_DESCRIPTION, TOOL_EFFECTS, ROUTER_MCP_VERSION, toolAnnotations } from './http.js';
import { renderPostingRules, POSTING_CADENCE_INSTRUCTIONS } from './posting-rules.js';
import { SHARING_NOTICE_INSTRUCTIONS } from './sharing-receipt.js';

/**
 * Every tool description is prompt text that each connected agent reads. These checks keep that text
 * short, calm, consistent and stated once, so it does not drift back.
 */
const repo = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const count = (text: string, part: string) => text.split(part).length - 1;

describe('the tool surface an agent reads', () => {
  const builtins = SYSTEM_SKILLS.filter(s => s.handlerType === 'builtin');

  it('says what every tool does to the world', () => {
    expect(Object.keys(TOOL_EFFECTS).sort()).toEqual(builtins.map(s => s.name).sort());
    expect(toolAnnotations('router_search').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(toolAnnotations('router_delete_entry').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(toolAnnotations('router_platform_send').annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    // Skill tools post notes, which may leave Router.
    expect(toolAnnotations('skill_anything').annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  it('keeps every privacy rule in the write description', () => {
    for (const rule of ['Names of people', 'Substance use', 'Mental health', 'Family conflict', 'Relationship trouble', 'Work trouble',
      'Money trouble', 'Health:', 'Private sources', 'Private dealings', 'how the person feels about anything, even when it is mild or positive', 'When in doubt, leave it out',
      'Fill in sensitivity_check first', 'even when they told you themselves', 'Do not turn a sensitive topic into a hint or an abstraction']) {
      expect(TOOL_DESCRIPTION, rule).toContain(rule);
    }
  });

  it('tells the truth about who can read a note', () => {
    expect(TOOL_DESCRIPTION).toContain('With no `to` and no saved audience, a note is public');
    expect(TOOL_DESCRIPTION).toContain('An open group is public on the web');
    expect(TOOL_DESCRIPTION).toContain('The privacy rules below apply whatever the audience');
    expect(TOOL_DESCRIPTION).not.toMatch(/every entry you write will be visible to anyone/i);
  });

  it('stays short and calm', () => {
    expect(TOOL_DESCRIPTION.length).toBeLessThan(5200);
    for (const skill of builtins) {
      const text = skill.description + JSON.stringify(skill.inputSchema);
      expect(text, skill.name).not.toContain('⬛');
      // No shouted headings or instructions: a run of three or more capitalised words.
      expect(skill.description, skill.name).not.toMatch(/\b[A-Z]{3,}(?: [A-Z]{2,}){2,}\b/);
    }
  });

  it('speaks to any agent and uses one word per thing', () => {
    for (const skill of builtins) {
      const text = skill.description + JSON.stringify(skill.inputSchema);
      expect(text, skill.name).not.toMatch(/\bClaudes?\b/);
      expect(text, skill.name).not.toMatch(/staging buffer|pending entr|secret key|identity key/i);
    }
    expect(SEARCH_TOOL_DESCRIPTION).not.toMatch(/pseudonym/i);
  });

  it('gives each instruction once', () => {
    for (const rules of [undefined, { mode: 'automatic' as const, audience: 'public' as const, destinations: [], purpose: '', share: '', avoid: '', style: '', instructions: '', schemaVersion: 1 as const, revision: 1, updatedAt: 0 }]) {
      const whatAnAgentReads = `${TOOL_DESCRIPTION}\n\n${renderPostingRules(rules)}`;
      expect(count(whatAnAgentReads, SHARING_NOTICE_INSTRUCTIONS)).toBe(1);
      expect(count(whatAnAgentReads, POSTING_CADENCE_INSTRUCTIONS)).toBe(1);
    }
  });

  it('reports the same version as the plugin manifests', () => {
    for (const manifest of ['plugins/teleport-router/.claude-plugin/plugin.json', 'plugins/teleport-router/.codex-plugin/plugin.json']) {
      expect(JSON.parse(repo(manifest)).version, manifest).toBe(ROUTER_MCP_VERSION);
    }
  });
});
