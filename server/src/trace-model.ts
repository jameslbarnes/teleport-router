/** Model calls from apps that read a private trace. See docs/trace-app-model-calls.md.
 *
 * An app that wants a language model to read part of a trace says so up front, in a declaration
 * with fixed fields: which provider, which model, how many calls, how much it may send and get
 * back. Router writes the sentences the owner reads from those fields; the requester's own words
 * never appear in them.
 *
 * For now only attested providers are accepted: ones that prove, before anything is sent, that the
 * endpoint runs a known release in confidential compute. The runner checks that proof and sends
 * nothing if it fails. Named labs are a later step.
 *
 * The app never touches the network or the requester's key. It hands the runner a prompt; the
 * runner sends it through the gateway below, which holds the key and enforces the declaration.
 * The requester pays with their own key at the provider. Router keeps that key sealed with a key
 * that exists only inside its enclave (modelKeyVault) and hands it to the runner for one run.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export const ATTESTED_PROVIDERS = ['redpill', 'tinfoil'] as const;
export type AttestedProvider = typeof ATTESTED_PROVIDERS[number];
export type ModelProvider = AttestedProvider;

export const PROVIDER_NAMES: Readonly<Record<ModelProvider, string>> = Object.freeze({ redpill: 'RedPill', tinfoil: 'Tinfoil' });

export const MODEL_LIMITS = Object.freeze({
  calls: 8,
  promptBytes: 256 * 1024,
  replyTokens: 4096,
  /** A reply larger than this fails the call, whatever the token limit said. */
  replyBytes: 64 * 1024,
  /** The longest one call may take; less when the run has less time left. */
  callMs: 60_000,
  /** The longest closing a provider connection may take. */
  closeMs: 3_000,
});

/** Settles with `promise`, or rejects once `ms` have passed, whatever `promise` is doing. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), Math.max(0, ms)); })])
    .finally(() => clearTimeout(timer));
}

/** Reads a response body, stopping and failing as soon as it passes `most` bytes or `ms` milliseconds. */
export async function readBounded(response: Response, most: number, ms: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const read = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > most) throw new Error('too large');
      chunks.push(value);
    }
  })();
  try { await within(read, ms); }
  catch (err) { reader.cancel().catch(() => undefined); throw err; }
  return Buffer.concat(chunks).toString('utf8');
}

/** What an app may do with a model, fixed before the owner approves. Part of what the run's attestation commits to. */
export interface ModelDeclaration {
  provider: ModelProvider;
  model: string;
  /** The most calls the app may make in one run. */
  calls: number;
  /** The most bytes of prompt in one call. */
  prompt_bytes: number;
  /** The most tokens the model may reply with in one call. */
  reply_tokens: number;
}

export class TraceModelError extends Error {}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const FIELDS = ['provider', 'model', 'calls', 'prompt_bytes', 'reply_tokens'];
const whole = (value: unknown, most: number) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= most;

/** Checks a declaration sent with a request. Nothing declared (null or undefined) means the app may not call a model.
 *  Unknown fields are refused, so a field cannot mean something to only one side. */
export function checkModelDeclaration(input: unknown): ModelDeclaration | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new TraceModelError('Declare model use as {provider, model, calls, prompt_bytes, reply_tokens}, or leave it out.');
  for (const key of Object.keys(input)) if (!FIELDS.includes(key)) throw new TraceModelError(`The model declaration has an unknown field: ${key.slice(0, 40)}.`);
  const { provider, model, calls, prompt_bytes, reply_tokens } = input as Record<string, unknown>;
  if (!(ATTESTED_PROVIDERS as readonly unknown[]).includes(provider))
    throw new TraceModelError(`Only attested model providers are accepted: ${ATTESTED_PROVIDERS.join(' or ')}.`);
  if (typeof model !== 'string' || !MODEL_ID.test(model)) throw new TraceModelError('Name the model by its ID at the provider, for example z-ai/glm-5.3.');
  if (!whole(calls, MODEL_LIMITS.calls)) throw new TraceModelError(`Declare between 1 and ${MODEL_LIMITS.calls} model calls.`);
  if (!whole(prompt_bytes, MODEL_LIMITS.promptBytes)) throw new TraceModelError(`Declare a prompt size between 1 byte and ${MODEL_LIMITS.promptBytes / 1024} KB.`);
  if (!whole(reply_tokens, MODEL_LIMITS.replyTokens)) throw new TraceModelError(`Declare a reply size between 1 and ${MODEL_LIMITS.replyTokens} tokens.`);
  return { provider: provider as ModelProvider, model, calls: calls as number, prompt_bytes: prompt_bytes as number, reply_tokens: reply_tokens as number };
}

/** SHA-256 of the declaration as canonical JSON (keys sorted, no spaces). A run description that allows a model
 *  carries this, so the attestation the owner checks covers what the app may send and where. */
export function modelDeclarationHash(declaration: ModelDeclaration): string {
  const text = `{"calls":${declaration.calls},"model":${JSON.stringify(declaration.model)},"prompt_bytes":${declaration.prompt_bytes},"provider":${JSON.stringify(declaration.provider)},"reply_tokens":${declaration.reply_tokens}}`;
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What the owner is shown about model use. Every sentence is built here from the declaration's fixed fields.
 *  `requester` is the requester's name as Router knows it (a handle, with or without @, or a pen name), not text they wrote. */
export function describeModelUse(declaration: ModelDeclaration | null, requester: string): string[] {
  if (declaration === null) return ['This app cannot call a model or reach the network.'];
  const who = /^[a-z0-9_]{1,30}$/.test(requester) ? '@' + requester : requester;
  const name = PROVIDER_NAMES[declaration.provider];
  return [
    `This app may send parts of the trace to the model ${declaration.model} at ${name}.`,
    `Up to ${declaration.calls} ${declaration.calls === 1 ? 'call' : 'calls'}, each sending at most ${kb(declaration.prompt_bytes)} of the app's choosing and getting back at most ${declaration.reply_tokens} tokens.`,
    `${name} is attested: before sending, the runner checks proof that the endpoint runs in confidential compute, and sends nothing if the check fails.`,
    declaration.provider === 'redpill'
      ? "RedPill's gateway reads the prompt inside its own attested enclave before passing it to the model's enclave."
      : "Tinfoil's release is the one its own public log names; Router has not reviewed it.",
    `What the app sends leaves Router's enclave for ${name}'s. That ${name} keeps none of it is ${name}'s promise; attestation does not prove it.`,
    `Calls are billed to ${who}'s own account at ${name}. The models there are open-weight.`,
    `${who}'s account at ${name} shows when the calls are made and how many tokens they use, so ${who} can tell that the app has run.`,
    `The app's code decides how many calls it makes and how large they are, and ${who}'s account shows those numbers, so running it can tell ${who} a little about the trace even if you withhold the answer.`,
  ];
}
const kb = (bytes: number) => bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 102.4) / 10} KB`;

/** A key the requester made at the provider: 8 to 400 characters, none of them whitespace. */
export const usableModelKey = (key: unknown): key is string => typeof key === 'string' && key.length >= 8 && key.length <= 400 && !/\s/.test(key);

/** A connection to a provider that has already passed its check. Only an attested provider's connector may build one after verifying. */
export interface ModelChannel {
  /** Sends only to the verified endpoint; any other address is refused by the provider's own transport. */
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  baseURL: string;
  /** The release or measurement that was verified, for the run's record. */
  release: string;
  /** The verifier's own one-line verdict. */
  verdict: string;
  /** Extra request fields the provider needs to refuse unverified serving. */
  extraBody?: Record<string, unknown>;
  /** Checks the provider's signed receipt for the call just made, where the provider issues them. Throws if it does not verify. Returns the receipt's ID. */
  confirm?: () => Promise<string>;
  close: () => Promise<void>;
}
/** Verifies the provider and returns a channel, or throws. Nothing has been sent to a model when this throws. */
export type ModelConnector = () => Promise<ModelChannel>;

/** What the run's record keeps about model use. No prompt, reply or key. */
export interface ModelEvidence {
  provider: ModelProvider; model: string; calls: number;
  release: string | null; verdict: string | null; receipts: string[];
}

export interface ModelGateway {
  /** Sends one prompt and returns the model's reply. Throws TraceModelError with a fixed sentence for anything that goes wrong. */
  ask: (prompt: string) => Promise<string>;
  evidence: () => ModelEvidence;
  close: () => Promise<void>;
}

/** Holds the requester's key and enforces the declaration. Errors are fixed sentences: a provider's own error text can
 *  quote the prompt, and must not travel anywhere the trace may not. `timeLeft` is the run's remaining time in
 *  milliseconds; the check before the first call, each call, reading its reply and checking its receipt all end by
 *  the smaller of that and `callMs`, whatever the provider's code is doing. Closing takes at most `closeMs`. */
export function modelGateway(options: { declaration: ModelDeclaration; apiKey: string; connect: ModelConnector; callMs?: number; timeLeft?: () => number; closeMs?: number }): ModelGateway {
  const { declaration, apiKey, connect } = options;
  if (!usableModelKey(apiKey)) throw new TraceModelError('The requester did not supply a usable key for the model provider.');
  const name = PROVIDER_NAMES[declaration.provider];
  const allowed = () => Math.min(options.callMs ?? MODEL_LIMITS.callMs, options.timeLeft?.() ?? Infinity);
  let channel: Promise<ModelChannel> | undefined, calls = 0, closed = false;
  const receipts: string[] = [];
  let verified: { release: string; verdict: string } | null = null;
  const open = () => channel ??= (async () => {
    const connecting = Promise.resolve().then(connect);
    try {
      const c = await within(connecting, allowed());
      verified = { release: c.release, verdict: c.verdict };
      return c;
    } catch {
      // A check that finishes after the deadline still gets closed.
      connecting.then(c => c.close(), () => undefined).catch(() => undefined);
      throw new TraceModelError(`${name} could not be verified, so nothing was sent to it.`);
    }
  })();
  return {
    async ask(prompt) {
      if (closed) throw new TraceModelError('The run has ended.');
      if (typeof prompt !== 'string' || !prompt) throw new TraceModelError('The app asked the model with an empty prompt.');
      if (calls >= declaration.calls) throw new TraceModelError(`The app tried to call the model more than the ${declaration.calls} ${declaration.calls === 1 ? 'time' : 'times'} it declared.`);
      if (Buffer.byteLength(prompt, 'utf8') > declaration.prompt_bytes) throw new TraceModelError(`The app tried to send more than the ${kb(declaration.prompt_bytes)} it declared.`);
      if (allowed() <= 0) throw new TraceModelError('The run ran out of time, so nothing more was sent to the model.');
      const c = await open();
      if (closed) throw new TraceModelError('The run has ended.');
      const ms = allowed();
      if (ms <= 0) throw new TraceModelError('The run ran out of time, so nothing more was sent to the model.');
      // Counted before sending: a call that fails part-way may still have delivered its prompt.
      calls++;
      const until = Date.now() + ms, left = () => until - Date.now();
      let response: Response;
      try {
        // Bounded here too: a transport that ignores the abort signal must not hold the run past its deadline.
        response = await within(Promise.resolve().then(() => c.fetch(`${c.baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ ...c.extraBody, model: declaration.model, messages: [{ role: 'user', content: prompt }], max_tokens: declaration.reply_tokens, stream: false }),
          signal: AbortSignal.timeout(ms),
        })), ms);
      } catch { throw new TraceModelError(`The call to ${name} did not complete.`); }
      if (response.status === 401 || response.status === 403) throw new TraceModelError(`${name} refused the requester's key.`);
      if (response.status === 402 || response.status === 429) throw new TraceModelError(`${name} refused the call: the requester's account is out of credit or over its rate limit.`);
      if (!response.ok) throw new TraceModelError(`${name} refused the call (status ${response.status}).`);
      let text: unknown, cutShort = false;
      try {
        // Read only as much as a reply may hold: the read stops, and the call fails, once it passes the limit.
        const body = await readBounded(response, MODEL_LIMITS.replyBytes * 2, left());
        const choice = JSON.parse(body)?.choices?.[0];
        text = choice?.message?.content;
        cutShort = choice?.finish_reason === 'length';
      } catch { throw new TraceModelError(`${name} sent a reply the runner could not read.`); }
      // A model that reasons before it answers can spend the whole reply size on reasoning and write nothing.
      if (cutShort && (typeof text !== 'string' || !text))
        throw new TraceModelError(`${name}'s reply ran out of its ${declaration.reply_tokens} tokens before any text was written. A model that reasons first needs a larger reply size.`);
      if (typeof text !== 'string') throw new TraceModelError(`${name} sent a reply without text.`);
      if (Buffer.byteLength(text, 'utf8') > MODEL_LIMITS.replyBytes) throw new TraceModelError(`${name} sent a reply larger than ${MODEL_LIMITS.replyBytes / 1024} KB.`);
      if (c.confirm) {
        try { receipts.push(await within(Promise.resolve().then(() => c.confirm!()), left())); }
        catch { throw new TraceModelError(`${name}'s signed receipt for the call did not verify, so its reply was not used.`); }
      }
      return text;
    },
    evidence: () => ({ provider: declaration.provider, model: declaration.model, calls,
      release: verified?.release ?? null, verdict: verified?.verdict ?? null, receipts: [...receipts] }),
    async close() {
      closed = true;
      if (channel) await within(channel.then(c => c.close(), () => undefined), options.closeMs ?? MODEL_LIMITS.closeMs).catch(() => undefined);
    },
  };
}

/** One turn of an app: it finishes with an answer or an error, or asks the model one thing. The same shape as trace-app's AppStepResult. */
export type AppStep = { ok: true; answer: string } | { ok: false; error: string } | { ask: string };
export type ModelRunResult = { ok: true; answer: string; evidence: ModelEvidence | null } | { ok: false; error: string; evidence: ModelEvidence | null };

/** Runs an app that may ask a model. `step` runs the sandboxed code from the start with the replies so far and
 *  returns what it wants next; the sandbox itself stays without network or timers. The app sees replies only as
 *  arguments, and the model sees only the prompts the app returned. The gateway is closed when this returns. */
export async function runWithModel(step: (replies: readonly string[]) => Promise<AppStep>, gateway: ModelGateway | null): Promise<ModelRunResult> {
  const replies: string[] = [];
  try {
    for (;;) {
      const next = await step([...replies]);
      if ('ask' in next) {
        if (!gateway) return { ok: false, error: 'The app asked for a model but declared none.', evidence: null };
        try { replies.push(await gateway.ask(next.ask)); }
        catch (err) { return { ok: false, error: err instanceof TraceModelError ? err.message : 'The model call failed.', evidence: gateway.evidence() }; }
        continue;
      }
      return next.ok ? { ok: true, answer: next.answer, evidence: gateway?.evidence() ?? null } : { ok: false, error: next.error, evidence: gateway?.evidence() ?? null };
    }
  } finally { await gateway?.close(); }
}

// --- The requester's key, at rest in Router -------------------------------------------------

/** A requester's key for the provider, sealed. Only Router's enclave can open it, and only for the request, revision and declaration it was sealed for. */
export interface SealedModelKey { iv: string; tag: string; data: string }
/** What a sealed key is bound to. */
export interface ModelKeyBinding { requestId: string; revision: string; modelHash: string }

/** AES-256-GCM under a key derived from a secret that exists only inside Router's enclave. The associated data binds
 *  the request's ID, its revision and the declaration's hash, so a sealed key cannot be moved to another request, or
 *  opened for another version or declaration of the same one. */
export function modelKeyVault(secret: Uint8Array) {
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), 'teleport-router/model-key/v1', 32));
  const tagKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), 'teleport-router/model-key-tag/v1', 32));
  const bound = (b: ModelKeyBinding) => Buffer.from(JSON.stringify(['teleport-router/model-key/v1', b.requestId, b.revision, b.modelHash]), 'utf8');
  return {
    seal(apiKey: string, binding: ModelKeyBinding): SealedModelKey {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(bound(binding));
      const data = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
      return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
    },
    /** Throws a fixed sentence if the sealed key is missing, altered or sealed for another request, revision or declaration. */
    open(sealed: SealedModelKey | undefined, binding: ModelKeyBinding): string {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed!.iv, 'base64url'), { authTagLength: 16 });
        decipher.setAAD(bound(binding));
        decipher.setAuthTag(Buffer.from(sealed!.tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(sealed!.data, 'base64url')), decipher.final()]).toString('utf8');
      } catch { throw new TraceModelError("The requester's key for the model provider could not be opened."); }
    },
    /** A keyed hash that recognises the same key sent again for the same request, after the key itself has been dropped.
     *  It cannot be turned back into the key, and means nothing without the enclave's secret. */
    tag(apiKey: string, binding: ModelKeyBinding): string {
      return createHmac('sha256', tagKey).update(bound(binding)).update('\n').update(apiKey, 'utf8').digest('base64url');
    },
  };
}
export type ModelKeyVault = ReturnType<typeof modelKeyVault>;
