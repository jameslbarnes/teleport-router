// Owner-side checks of a binding bundle from the sub-container host. These run
// on the grantor's machine before any grant. Pure functions, Node built-ins
// only; server/scripts/subhost-grant.mjs adds the network steps (fetching the
// bundle and checking the TDX signature with Phala's verifier).
//
// What passing means: a TDX quote from this CVM says the boot measurements are
// the approved OS, the measured compose file is the approved template (Router's
// image versions may vary, nothing else), and the report data commits to this
// public key, this container code, this app and the caller's fresh nonce.
import { createHash } from 'node:crypto';
import { bindingPreimage, canonicalJson, codeHash, reportDataFor, sha256Hex, validateSpec } from './host.mjs';

const lf = text => String(text).replace(/\r\n/g, '\n');

/** Offsets in a TDX v4 quote: 48-byte header, then the TD report body. */
export const QUOTE_FIELDS = Object.freeze({ mrtd: 184, mrConfigId: 232, rtmr0: 376, rtmr1: 424, rtmr2: 472, rtmr3: 520 });
const REPORT_DATA = 568;

export function parseQuote(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) throw new Error('quote must be hex');
  const b = Buffer.from(hex, 'hex');
  if (b.length < REPORT_DATA + 64) throw new Error('quote is too short');
  const version = b.readUInt16LE(0);
  const teeType = b.readUInt32LE(4);
  if (version !== 4 || teeType !== 0x81) throw new Error(`not a TDX v4 quote (version ${version}, TEE type 0x${teeType.toString(16)})`);
  const out = { reportData: b.subarray(REPORT_DATA, REPORT_DATA + 64).toString('hex') };
  for (const [name, offset] of Object.entries(QUOTE_FIELDS)) out[name] = b.subarray(offset, offset + 48).toString('hex');
  return out;
}

/** dstack's event digest: SHA-384 of type (u32 LE) ":" event ":" payload bytes. */
export function eventDigest(e) {
  const type = Buffer.alloc(4);
  type.writeUInt32LE(e.event_type >>> 0);
  return createHash('sha384')
    .update(Buffer.concat([type, Buffer.from(':'), Buffer.from(String(e.event), 'utf8'), Buffer.from(':'), Buffer.from(String(e.event_payload), 'hex')]))
    .digest('hex');
}

export function replayRtmr(events, imr) {
  let mr = Buffer.alloc(48);
  for (const e of events.filter(x => x.imr === imr)) {
    let d = Buffer.from(e.digest, 'hex');
    if (d.length < 48) d = Buffer.concat([d, Buffer.alloc(48 - d.length)]);
    mr = createHash('sha384').update(Buffer.concat([mr, d])).digest();
  }
  return mr.toString('hex');
}

function onlyEvent(events, name) {
  const found = events.filter(e => e.imr === 3 && e.event === name);
  if (found.length !== 1) throw new Error(`expected one "${name}" event, found ${found.length}`);
  return String(found[0].event_payload).toLowerCase();
}

/** dstack's compose hash, as its SDK computes it (sorted-key JSON, unused runner fields dropped). */
export function dstackComposeHash(appCompose) {
  const obj = { ...appCompose };
  if (obj.runner === 'bash') delete obj.docker_compose_file;
  if (obj.runner === 'docker-compose') delete obj.bash_script;
  if ('pre_launch_script' in obj && !obj.pre_launch_script) delete obj.pre_launch_script;
  return sha256Hex(canonicalJson(obj));
}

/** Environment names that change how a shell or runtime starts. Never acceptable at boot. */
export const RISKY_ENV_NAMES = /^(BASH_ENV|ENV|BASHOPTS|SHELLOPTS|IFS|PS4|PROMPT_COMMAND|PATH|HOME|TMPDIR|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|NODE_OPTIONS|NODE_PATH|PYTHON[A-Z0-9_]*|PERL[A-Z0-9_]*|RUBY[A-Z0-9_]*|DOCKER_[A-Z0-9_]*|COMPOSE_[A-Z0-9_]*|DSTACK_[A-Z0-9_]*|SUBHOST_[A-Z0-9_]*)$/;

/** The four values CI fills into the template on each deploy. Nothing else may differ. */
export const TEMPLATE_VARIABLES = Object.freeze({
  GIT_SHA: '[0-9a-f]{7,40}',
  IMAGE_DIGEST: 'sha256:[0-9a-f]{64}',
  AGENT_IMAGE_DIGEST: 'sha256:[0-9a-f]{64}',
  DISCORD_IMAGE_DIGEST: 'sha256:[0-9a-f]{64}',
});

/**
 * Checks that a deployed compose file is the template with only the variables
 * above filled in (the way CI's envsubst fills them), and returns their values.
 */
export function matchTemplate(template, deployed) {
  const text = lf(template);
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const seen = new Set();
  let pattern = '^';
  let last = 0;
  for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = m[1] || m[2];
    if (!(name in TEMPLATE_VARIABLES)) throw new Error(`the template uses an unexpected variable: ${name}`);
    pattern += escape(text.slice(last, m.index));
    pattern += seen.has(name) ? `\\k<${name}>` : `(?<${name}>${TEMPLATE_VARIABLES[name]})`;
    seen.add(name);
    last = m.index + m[0].length;
  }
  pattern += `${escape(text.slice(last))}$`;
  const match = new RegExp(pattern).exec(lf(deployed));
  if (!match) throw new Error('the deployed compose file is not the approved template');
  return { ...match.groups };
}

/**
 * Checks a bundle against what the grantor approved. Throws on the first
 * failure; returns the facts it established.
 *   expected: { nonce, spec, template, approved: { app_ids, manifests, pre_launch_script_sha256, os } }
 */
export function verifyBundle(bundle, expected) {
  if (!bundle || bundle.version !== 1) throw new Error('unsupported bundle version');

  // The container: the spec it runs is the one approved, so its code hash is too.
  const spec = validateSpec(expected.spec);
  const hash = codeHash(spec);
  if (canonicalJson(validateSpec(bundle.spec)) !== canonicalJson(spec)) throw new Error('the container runs a different spec than the approved one');
  if (bundle.code_hash !== hash) throw new Error(`code hash ${bundle.code_hash} is not the approved ${hash}`);

  // The quote and its event log agree.
  const quote = parseQuote(bundle.quote);
  const events = bundle.event_log;
  if (!Array.isArray(events)) throw new Error('the bundle has no event log');
  for (const e of events.filter(x => x.imr === 3)) {
    if (eventDigest(e) !== String(e.digest).toLowerCase()) throw new Error(`event "${e.event}" does not match its digest`);
  }
  if (replayRtmr(events, 3) !== quote.rtmr3) throw new Error('RTMR3 in the quote does not match the event log');

  // The OS: boot measurements match an approved dstack image.
  const osImageHash = onlyEvent(events, 'os-image-hash');
  const os = (expected.approved.os || []).find(o => o.os_image_hash === osImageHash
    && o.mrtd === quote.mrtd && o.rtmr0 === quote.rtmr0 && o.rtmr1 === quote.rtmr1 && o.rtmr2 === quote.rtmr2);
  if (!os) throw new Error(`the OS measurements (image ${osImageHash}) are not an approved set`);

  // The compose file: measured, and the approved template apart from Router's image versions.
  const measuredCompose = onlyEvent(events, 'compose-hash');
  if (typeof bundle.app_compose !== 'string') throw new Error('the bundle has no app-compose file');
  const appCompose = JSON.parse(bundle.app_compose);
  if (sha256Hex(bundle.app_compose) !== measuredCompose && dstackComposeHash(appCompose) !== measuredCompose)
    throw new Error('the app-compose file is not the one measured at boot');
  const mrConfigCarriesCompose = quote.mrConfigId === `01${measuredCompose}${'0'.repeat(30)}`;
  if (!mrConfigCarriesCompose && !/^0+$/.test(quote.mrConfigId)) throw new Error('MRCONFIGID names a different compose hash');
  if (appCompose.runner !== 'docker-compose') throw new Error('the CVM does not run a compose file');
  const routerVersions = matchTemplate(expected.template, appCompose.docker_compose_file);
  const preLaunch = sha256Hex(appCompose.pre_launch_script || '');
  if (!(expected.approved.pre_launch_script_sha256 || []).includes(preLaunch)) throw new Error(`pre-launch script ${preLaunch} is not approved`);
  // Every other field of the deploy manifest must equal an approved set exactly,
  // including which secrets the operator may inject at boot: dstack hands them to
  // the root startup shell, so a name like BASH_ENV would let the operator run code.
  const manifest = { ...appCompose };
  delete manifest.docker_compose_file;
  delete manifest.pre_launch_script;
  for (const name of manifest.allowed_envs || []) {
    if (RISKY_ENV_NAMES.test(String(name))) throw new Error(`the deploy manifest lets the operator set ${name} at boot`);
  }
  if (!(expected.approved.manifests || []).some(m => canonicalJson(m) === canonicalJson(manifest)))
    throw new Error('the deploy manifest (secret names, features, key settings) is not an approved one');

  // The binding: this key, this code, this app, this nonce.
  const appId = onlyEvent(events, 'app-id');
  if (!(expected.approved.app_ids || []).includes(appId)) throw new Error(`app ${appId} is not the approved CVM`);
  const publicKey = bundle.container?.public_key;
  const preimage = bindingPreimage({ appId, name: spec.name, codeHash: hash, publicKey, nonce: expected.nonce });
  if (bundle.preimage !== preimage) throw new Error('the binding text is not what this check expects');
  if (reportDataFor(preimage) !== quote.reportData) throw new Error('the quote does not carry this binding');

  return { appId, codeHash: hash, publicKey, osImageHash, composeHash: measuredCompose, mrConfigCarriesCompose, preLaunch, routerVersions, runtime: bundle.runtime, quote };
}
