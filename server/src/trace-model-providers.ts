/** Connectors for model providers that prove, before anything is sent, that they run in confidential compute.
 *  Each uses the provider's own verifier, loaded only in the trace runner. See docs/trace-app-model-calls.md.
 */
import { randomBytes } from 'node:crypto';
import { TraceModelError, type AttestedProvider, type ModelConnector } from './trace-model.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** RedPill's confidential-only gateway. It serves a model only from a provider it has verified, and signs a receipt for each call. */
export const REDPILL_BASE_URL = 'https://tee.redpill.ai/v1';

/** `acceptedReleases` are the sha256 hashes of the gateway releases Router accepts (RedPill publishes each with at least
 *  three days' notice). Without one, the check would prove only that some attested release is running, so none is refused. */
export function redpillConnector(acceptedReleases: readonly string[]): ModelConnector {
  if (!acceptedReleases.length || !acceptedReleases.every(hash => HEX64.test(hash)))
    throw new TraceModelError('RedPill needs a list of accepted gateway releases (sha256, lowercase hex).');
  return async () => {
    const { connectAci } = await import('@phala/aci-verifier/runtime');
    // Verifies the TDX quote to Intel's root, the binding of the gateway's keys to it, and the release; then pins TLS to an attested key.
    const aci = await connectAci({
      baseURL: REDPILL_BASE_URL,
      policy: { acceptedComposeHashes: acceptedReleases },
      serving: { requireVerified: true, requireReceipt: true },
    });
    const verdict = aci.identity.transcript.verdict;
    if (!verdict.verified) { await aci.close(); throw new TraceModelError('RedPill did not verify.'); }
    return {
      fetch: (input, init) => aci.fetch(input, init),
      baseURL: aci.baseURL,
      release: aci.identity.composeHash,
      verdict: verdict.line,
      extraBody: { provider: { aci_verified: true } },
      async confirm() {
        const audit = await aci.verifyReceipt();
        if (!audit.transcript.verdict.verified) throw new TraceModelError('receipt not verified');
        return audit.receiptId;
      },
      close: () => aci.close(),
    };
  };
}

/** Tinfoil. Its client checks the enclave's attestation against the release named in Tinfoil's public transparency log.
 *  The 'tls' transport then sends each whole request, headers and the requester's key included, over TLS pinned to the
 *  key the attestation names; it fails if the attestation names none. (The default 'ehbp' transport seals only the body,
 *  and sends the headers over ordinary HTTPS.) It issues no receipts. A fresh cache secret for each run keeps the
 *  provider's prompt cache from being shared between runs. */
export function tinfoilConnector(): ModelConnector {
  return async () => {
    const { SecureClient } = await import('tinfoil');
    const client = new SecureClient({ transport: 'tls', userCacheSecret: randomBytes(32).toString('hex') });
    await client.ready();
    const document = client.getVerificationDocument();
    const baseURL = client.getBaseURL();
    if (!document.securityVerified || !baseURL) throw new TraceModelError('Tinfoil did not verify.');
    return {
      fetch: (input, init) => client.fetch(input, init),
      baseURL,
      release: document.releaseDigest,
      verdict: `verified against ${document.configRepo}`,
      close: async () => { client.reset(); },
    };
  };
}

/** The connector for an attested provider, from the runner's settings. */
export function attestedConnector(provider: AttestedProvider, settings: { redpillReleases?: readonly string[] }): ModelConnector {
  return provider === 'redpill' ? redpillConnector(settings.redpillReleases ?? []) : tinfoilConnector();
}
