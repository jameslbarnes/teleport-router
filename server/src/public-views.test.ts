import {it,expect} from 'vitest';
import {isPublicNotebookEntry,channelView} from './public-views.js';
import type {JournalEntry,Channel} from './storage.js';
const entry:JournalEntry={id:'a',pseudonym:'a',client:'code',content:'text',timestamp:1};
it('excludes addressed and AI-only writing from public previews and summary prompts, including legacy fields',()=>{
  expect(isPublicNotebookEntry(entry)).toBe(true);
  for(const fields of [{to:['@friend']},{to:['#group']},{channel:'old-group'},{aiOnly:true},{humanVisible:false},{visibility:'ai-only'},{visibility:'private'}])
    expect(isPublicNotebookEntry({...entry,...fields} as JournalEntry)).toBe(false);
});
it('never exposes a stored delegation when returning a channel',()=>{
  const channel={id:'group',store:{kind:'tinycloud',prefix:'groups/group/',delegation:'secret-grant',space:'space'}} as Channel;
  expect(channelView(channel)?.store).toEqual({kind:'tinycloud',prefix:'groups/group/',space:'space'});
  expect(channel.store?.delegation).toBe('secret-grant');
});
