import { describe, it, expect } from 'vitest';
import { normalizeRepo, normalizeTags, labelFilter, matchesLabels } from './note-labels.js';

describe('normalizeRepo', () => {
  it('reduces git remotes to owner/name', () => {
    expect(normalizeRepo('https://github.com/JamesLBarnes/Cue-API.git')).toBe('jameslbarnes/cue-api');
    expect(normalizeRepo('git@github.com:jameslbarnes/cue.git')).toBe('jameslbarnes/cue');
    expect(normalizeRepo('ssh://git@gitlab.example.com/group/sub/project.git')).toBe('sub/project');
    expect(normalizeRepo('https://token@github.com/owner/name/')).toBe('owner/name');
  });

  it('keeps plain names', () => {
    expect(normalizeRepo('Owner/Name')).toBe('owner/name');
    expect(normalizeRepo('  etherea-ai ')).toBe('etherea-ai');
  });

  it('rejects things that are not repository names', () => {
    for (const bad of [undefined, null, 42, '', '   ', 'a b/c', 'owner/<script>', '../..', 'x'.repeat(400)]) {
      expect(normalizeRepo(bad)).toBeUndefined();
    }
  });
});

describe('normalizeTags', () => {
  it('makes lowercase slugs without duplicates', () => {
    expect(normalizeTags(['#Speech Recognition', 'speech_recognition', ' Latency ', 'c++'])).toEqual(['speech-recognition', 'latency', 'c']);
  });

  it('keeps at most eight and ignores non-strings', () => {
    expect(normalizeTags(['a', 1, 'b', null, 'c', 'd', 'e', 'f', 'g', 'h', 'i'] as unknown[])).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('returns undefined when nothing usable is left', () => {
    expect(normalizeTags(['', '###', '   '])).toBeUndefined();
    expect(normalizeTags('cue')).toBeUndefined();
  });
});

describe('labelFilter and matchesLabels', () => {
  const filter = (query: string) => labelFilter(new URLSearchParams(query));

  it('reads comma-separated and repeated parameters', () => {
    expect(filter('repo=cue-api,jameslbarnes/cue&repo=Etherea-AI&tag=Cue,latency')).toEqual({
      repos: ['cue-api', 'jameslbarnes/cue', 'etherea-ai'], tags: ['cue', 'latency'],
    });
  });

  it('matches a bare repo name under any owner, and a full name exactly', () => {
    expect(matchesLabels({ repo: 'jameslbarnes/cue-api' }, filter('repo=cue-api'))).toBe(true);
    expect(matchesLabels({ repo: 'jameslbarnes/cue-api' }, filter('repo=jameslbarnes/cue-api'))).toBe(true);
    expect(matchesLabels({ repo: 'someone/cue-api' }, filter('repo=jameslbarnes/cue-api'))).toBe(false);
    expect(matchesLabels({ repo: 'jameslbarnes/cue-api-pace' }, filter('repo=cue-api'))).toBe(false);
  });

  it('matches any wanted tag', () => {
    expect(matchesLabels({ tags: ['latency', 'cue'] }, filter('tag=cue'))).toBe(true);
    expect(matchesLabels({ tags: ['latency'] }, filter('tag=cue'))).toBe(false);
  });

  it('matches nothing for unlabeled notes or an empty filter', () => {
    expect(matchesLabels({}, filter('repo=cue&tag=cue'))).toBe(false);
    expect(matchesLabels({ repo: 'a/b', tags: ['x'] }, filter(''))).toBe(false);
  });
});
