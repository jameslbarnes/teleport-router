/** A link to an author's own storage, running in the background, as its owner sees it while they wait:
 * whether it is waiting to start or working, and how long each step took. The job stays running until
 * the link itself ends, so a second link for the account cannot start while the first still holds it. */
import { LinkTimeoutError, type LinkStep } from './author-store.js';

/** A link that has not switched storage by then stops without switching; a retry resumes it. */
export const LINK_DEADLINE_MS = 20 * 60_000;

export interface LinkJob {
  status: 'running' | 'complete' | 'failed';
  /** While running: waiting for other work on this account or this storage to finish, or working on the link. */
  phase?: 'waiting' | 'working';
  progress: string;
  started_at: string;
  /** How long each finished step took, in order. */
  steps: { step: LinkStep; seconds: number }[];
  result?: unknown;
  error?: string;
}

export interface LinkRun {
  deadline: number;
  onStep: (step: LinkStep) => void;
  progress: (message: string) => void;
}

const STEP_TEXT: Record<LinkStep, string> = {
  waiting: 'Waiting for Router to finish other work on this account or this storage.',
  checking: 'Checking your storage and its recovery record.',
  encrypting: 'Encrypting records already in your storage.',
  finding: 'Finding your published records.',
  copying: 'Copying your records and reading each one back.',
  reading: 'Reading your storage back before switching to it.',
  saving: 'Switching your account to your storage.',
  cleaning: 'Removing the old copies.',
};
const DONE = 'Encrypted migration verified; your TinyCloud key can recover your records independently.';
const FAILED = 'Migration did not complete. Existing verified data is retained; retry or inspect the storage connection.';
const TIMED_OUT = 'Storage did not finish in time. Nothing was switched and your records are where they were; try again in a few minutes.';

export function startLinkJob(run: (link: LinkRun) => Promise<unknown>,
  { deadlineMs = LINK_DEADLINE_MS, now = Date.now } = {}): LinkJob {
  const started = now();
  const job: LinkJob = { status: 'running', phase: 'waiting', progress: STEP_TEXT.waiting, started_at: new Date(started).toISOString(), steps: [] };
  let step: LinkStep = 'waiting', stepStarted = started;
  const endStep = () => {
    const at = now();
    job.steps.push({ step, seconds: Math.round((at - stepStarted) / 100) / 10 });
    stepStarted = at;
  };
  const finish = (fields: Partial<LinkJob>) => { endStep(); delete job.phase; Object.assign(job, fields); };
  run({
    deadline: started + deadlineMs,
    onStep: next => {
      if (job.status !== 'running' || next === step) return;
      endStep();
      step = next;
      job.phase = next === 'waiting' ? 'waiting' : 'working';
      job.progress = STEP_TEXT[next];
    },
    progress: message => { if (job.status === 'running') job.progress = message; },
  }).then(result => finish({ status: 'complete', result, progress: DONE }),
    // A timeout is only ever raised before the switch, so its message can say nothing was switched.
    err => finish({ status: 'failed', error: err instanceof LinkTimeoutError ? TIMED_OUT : FAILED }));
  return job;
}
