import { describe, it, expect, vi, afterEach } from 'vitest';
import { startLinkJob, type LinkRun } from './author-link-job.js';
import { LinkTimeoutError } from './author-store.js';

const settle = () => new Promise(r => setTimeout(r, 0));

describe('A storage link as its owner sees it while waiting', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('shows waiting, then working, and how long each step took', async () => {
    let clock = 0; let link!: LinkRun; let finish!: (v: unknown) => void;
    const job = startLinkJob(run => { link = run; return new Promise(r => { finish = r; }); }, { now: () => clock });
    expect(job).toMatchObject({ status: 'running', phase: 'waiting', steps: [] });
    link.onStep('waiting'); // a repeated step is not a new one
    clock = 4000; link.onStep('checking');
    expect(job).toMatchObject({ phase: 'working', progress: expect.stringContaining('Checking') });
    clock = 4500; link.onStep('copying'); link.progress('Verified 1/2 records');
    expect(job.progress).toBe('Verified 1/2 records');
    clock = 7000; finish({ copied: 2 }); await settle();
    expect(job).toMatchObject({ status: 'complete', result: { copied: 2 },
      steps: [{ step: 'waiting', seconds: 4 }, { step: 'checking', seconds: 0.5 }, { step: 'copying', seconds: 2.5 }] });
    expect(job).not.toHaveProperty('phase');
  });

  it('gives the link a deadline', () => {
    let given = 0;
    startLinkJob(run => { given = run.deadline; return new Promise(() => {}); }, { deadlineMs: 5000, now: () => 1000 });
    expect(given).toBe(6000);
  });

  it('stays running until the link itself ends, so a second link for the account cannot start meanwhile', async () => {
    vi.useFakeTimers();
    let finish!: (v: unknown) => void;
    const job = startLinkJob(() => new Promise(r => { finish = r; }), { deadlineMs: 1000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job.status).toBe('running');
    finish({ copied: 0 }); await vi.advanceTimersByTimeAsync(0);
    expect(job).toMatchObject({ status: 'complete', result: { copied: 0 } });
  });

  it('says plainly when storage did not answer in time, and keeps other failures general', async () => {
    const slow = startLinkJob(async () => { throw new LinkTimeoutError('Storage did not answer a listing within 60 s.'); });
    const broken = startLinkJob(async () => { throw new Error('internal detail'); });
    await settle();
    expect(slow).toMatchObject({ status: 'failed', error: expect.stringContaining('in time') });
    expect(broken).toMatchObject({ status: 'failed', error: expect.stringContaining('did not complete') });
    expect(broken.error).not.toContain('internal detail');
  });
});
