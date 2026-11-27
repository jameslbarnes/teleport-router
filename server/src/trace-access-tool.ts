/** The router_trace_access tool as agents read it. When this server lets apps call no model, the description and
 *  schema say nothing about models, so an agent never puts a paid key into its tool call to be refused. */
import { ATTESTED_PROVIDERS, type AttestedProvider } from './trace-model.js';

/** The attested providers this server lets apps call, from TRACE_MODELS (for example "redpill,tinfoil"). Unset or empty: none. */
export function enabledTraceModels(value: string | undefined = process.env.TRACE_MODELS): AttestedProvider[] {
  const named = (value || '').split(',').map(p => p.trim().toLowerCase());
  return ATTESTED_PROVIDERS.filter(p => named.includes(p));
}

const BEFORE = 'Ask to run a small app on the private trace behind a note you can read. You never get the trace: the owner, or an agent the owner set up to do it, reads your app\'s code, runs it in an attested enclave, reads its answer and decides whether to release that answer to you. The app is JavaScript defining function analyze(trace, info) that returns a string of at most 8 KB; it has no network, files or timers, 256 MB and 10 seconds. trace is JSON text: {kind: "router-post-trace", entry_id, agent ("claude-code" or "codex"), session_id, posted_at, records}, where records are the session\'s log entries in that agent\'s own format, cleaned of credentials (for agent "claude-code", {type: "user" or "assistant", timestamp, message: {role, content}}, content being text or a list of {type: "text", text}, {type: "tool_use", name, input} and {type: "tool_result", content, is_error when it failed}; an assistant message also has model and usage, its token counts); info is {entry_id, bytes}. Try the function with plain Node on a small trace of that shape before sending it. The released answer comes back from status as answer_text. To have it sealed to a key of your own instead, so that Router cannot read it, give answer_public_key.';
const AFTER = ' Use withdraw to take a request back (needed before sending a different app). Use inbox for requests to you (with each app\'s code, so you can review it for your person), decline or withhold to refuse. To authorize this machine\'s owner tool in the browser without handling recovery files, use pair_start with its agent_public_key and pair_poll with pair_token (returns ciphertext only the local tool can open). A pointer alone grants no access.';

export function traceAccessTool(providers: readonly AttestedProvider[]) {
  const models = providers.length > 0;
  const description = BEFORE + (models
    ? ' An app can also ask a language model: declare model {provider, model, calls, prompt_bytes, reply_tokens} and give model_key, then analyze(trace, info, replies) may return {ask: prompt}; the runner sends the prompt and runs the function again from the start with the reply added to replies (empty at first).'
      + ` Only attested providers are accepted (here ${providers.join(' or ')}), and the calls are billed to your own key there.`
      + ' The key you send stays in your own conversation log, so make a key for this with a small spending limit. The owner sees the declaration, and Router never shows or logs the key.'
    : '') + AFTER;
  const inputSchema = { type: 'object', properties: {
    action: { type: 'string', enum: ['request', 'inbox', 'status', 'withdraw', 'decline', 'withhold', 'pair_start', 'pair_poll'] },
    entry_id: { type: 'string' },
    agent_public_key: { type: 'string', description: 'For pair_start: compressed secp256k1 public key printed by the local owner tool (pair-init).' },
    pair_token: { type: 'string', description: 'For pair_poll: the pairing token returned by pair_start.' },
    app: { type: 'object', description: 'Required when requesting.', properties: {
      code: { type: 'string', description: 'JavaScript defining function analyze(trace, info), returning a string. At most 32 KB.' },
      purpose: { type: 'string', description: 'One line, at most 280 characters: what the app is for. The owner reads it.' },
    }, required: ['code', 'purpose'] },
    answer_public_key: { type: 'string', description: 'Optional: 0x02 or 0x03 followed by 64 hex digits. The answer is then sealed to this key, which Router cannot open; keep the private key. Without it, status returns the released answer as answer_text.' },
    ...(models ? {
      model: { type: 'object', description: 'Optional, when requesting: what the app may do with a model. Unknown fields are refused.', properties: {
        provider: { type: 'string', enum: [...providers], description: 'An attested provider: the runner checks its proof of confidential compute before sending anything.' },
        model: { type: 'string', description: 'The model ID at that provider.' },
        calls: { type: 'integer', minimum: 1, maximum: 8 },
        prompt_bytes: { type: 'integer', minimum: 1, maximum: 262144, description: 'The most bytes one prompt may hold.' },
        reply_tokens: { type: 'integer', minimum: 1, maximum: 4096, description: 'The most tokens one reply may hold, reasoning included: a model that reasons first needs a few hundred even for a short answer.' },
      }, required: ['provider', 'model', 'calls', 'prompt_bytes', 'reply_tokens'] },
      model_key: { type: 'string', description: 'Required exactly when model is given: your own API key at that provider, made for this with a small spending limit. It stays in your conversation log. Router seals it at once and passes it to one run only.' },
    } : {}),
    request_id: { type: 'string' }, revision: { type: 'string', description: 'Required when declining or withholding.' },
  }, required: ['action'] };
  return { description, inputSchema };
}
