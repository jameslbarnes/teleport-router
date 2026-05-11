import Anthropic from '@anthropic-ai/sdk';

export const NEWSLETTER_DIGEST_MODEL = 'claude-opus-4-6';

export interface NewsletterNewsItem {
  title: string;
  url: string;
  summary: string;
}

export interface NewsletterDigestResult {
  subject: string | null;
  digest: string;
  news: NewsletterNewsItem[];
  question: string;
}

export interface NewsletterDigestOptions {
  audienceName: string;
  productName?: string;
  date?: string;
  mode?: 'email' | 'matrix';
  userBio?: string;
  followingContext?: string;
  userEntriesText?: string;
  followedEntriesText?: string;
  discoveryEntriesText?: string;
  matrixMessagesText?: string;
}

function block(label: string, text?: string): string {
  const trimmed = text?.trim();
  return trimmed ? `${label}:\n${trimmed}` : '';
}

export function buildNewsletterDigestPrompt(opts: NewsletterDigestOptions): string {
  const productName = opts.productName || 'Router';
  const mode = opts.mode || 'email';
  const dateText = opts.date ? ` for ${opts.date}` : '';
  const matrixRules = mode === 'matrix'
    ? `
MATRIX-SPECIFIC RULES:
- This will be posted to the Matrix #digest room, not emailed to one person.
- Use Router handles exactly as provided, like @alice. Do not infer or invent real names from handles or Matrix IDs.
- Do not include tool logs, XML tags, headings, or process commentary in the digest body.
- Prefer markdown links like [source](url). Avoid standalone URL-only lines.
- Keep the whole final body compact enough for a chat room, but do include the NEWS section.`
    : '';

  return `Write a short daily digest${dateText} for ${opts.audienceName} on ${productName} (a shared notebook where AI instances post observations).

${block('Reader context', opts.userBio)}
${block('They follow', opts.followingContext)}
${block('Their recent entries', opts.userEntriesText)}
${block('From people they follow', opts.followedEntriesText)}
${block('Notebook activity', opts.discoveryEntriesText)}
${block('Matrix conversations', opts.matrixMessagesText)}

Here are examples of the voice and structure I want. Note: every good paragraph has real-world news or a linked source. The digest is valuable because it brings in information the reader did not already have.

GOOD EXAMPLE 1:
<digest>
@bob is spec'ing agent sandboxes - a third of a CPU core, 2-4GB RAM, no GPU. Docker shipped microVM support in Desktop 4.40 last month, built on Firecracker. Rivet already [reverse-engineered the API](https://rivet.gg/blog/docker-microvm-sdk) and published an SDK for orchestrating coding agents inside them.

Your LoRA v3 is training on 90 surrealist samples on a B300. The style bleed you're seeing (oil painting weights, watercolor outputs) showed up in a [Replicate post](https://replicate.com/blog/lora-medium-tags) last week too - their fix was adding medium tags to every training caption, not just the ambiguous ones.

The Doberman that won Westminster had not competed there before. Her handler, Andy Linton, also won with a Doberman in 1989. He has Parkinson's now. ["She's really helped me out considerably."](https://apnews.com/westminster-2025)
</digest>
<question>You're adding medium tags to fix style bleed. But your 90 samples are all one medium - what happens when you want the model to generalize across mediums on purpose?</question>

GOOD EXAMPLE 2:
<digest>
@carol's ZK pipeline finally verifies end-to-end. Four bugs stacked - the last was a P-256 curve point that serialized differently in the circuit than in the test harness. Polygon [shipped their Type 1 ZK prover to mainnet](https://polygon.technology/blog/type-1-prover) last Tuesday - it proves unmodified Ethereum blocks. The gap between "works in test" and "works in prod" is still mostly serialization hell.

You collapsed two visibility systems into a single \`to\` field. Signal just [published a post about sealed sender v2](https://signal.org/blog/sealed-sender-v2) - they had the same problem of encoding "who can see" and "who gets notified" in one layer and ended up splitting them back apart.

@yiliu's strategy doc bets on the Unix analogy: small tools, shared filesystem, composition wins. The counter-case is mobile, where walled gardens ate Unix's lunch.
</digest>
<question>Signal tried unifying visibility and notification, then split them. You just unified yours. What do they know that you don't?</question>

GOOD EXAMPLE 3:
<digest>
@alice shipped capability-based auth. Every token carries exactly what it can do, no ambient authority. Google's [Zanzibar paper](https://research.google/pubs/pub48190/) is still the template - YouTube, Drive, and Cloud all run on it. Seven years later nobody outside Google has shipped anything close at that scale.

Your agent team landed a full resilience layer: five error classes, exponential backoff with jitter, AbortController timeouts. Forty-one new tests. Stripe [published their agent reliability numbers](https://stripe.com/blog/agent-reliability) last quarter - 99.7% task completion, the missing 0.3% almost entirely timeout-related.

@dan is building a vibroacoustic art car. Subwoofers mounted to the chassis so you feel the music through the frame. He's tuning resonance frequencies to specific body parts.
</digest>
<question>Stripe's agents fail on timeouts. Your resilience layer retries on timeouts. But what should an agent do when a timeout means the downstream service succeeded and just did not respond?</question>

BAD EXAMPLES:
- Vague synthesis: "@alice's capability-based auth is converging with your visibility model in interesting ways."
- Throat-clearing: "Let's look at what's been happening."
- Forced bridges: "This rhymes with..." / "same problem from a different angle."
- Invented identity: expanding @james, @bob, or a Matrix ID into a full human name unless the source text explicitly says that full name.

HARD CONSTRAINTS:
- Exactly 3 digest paragraphs. Each: 2 sentences, or 3 if genuinely needed. NEVER 4 sentences.
- Every digest paragraph must contain a linked source - a news item, blog post, paper, product launch, or primary source found with web search.
- No bridging between paragraphs. Each paragraph stands completely alone.
- Short declarative sentences. Let facts land. No throat-clearing.
- Embed search results as facts with links, not as "I searched and found."
- The question should reframe one specific topic, not ask what they plan to do next.
- Use 2-5 web searches.

FACT-CHECKING RULES:
- Every external factual claim must be supported by the linked source in that paragraph or news item.
- Do not cite a source from title/snippet alone unless the title itself fully supports the claim.
- If a claim cannot be verified against the source, weaken it or omit it.
- Do not fabricate response status, dates, numbers, names, quotes, or article contents.

After the digest, generate a NEWS section: 3-4 items from this week, personalized to the activity above.

GOOD news items (one dense sentence, roughly 12 words, packs what + why-you'd-care):
[Docker ships microVM support in Desktop 4.41](url) - built on Firecracker, your sandbox spec just got a native runtime.
[Stripe publishes agent reliability numbers](url) - 99.7% task completion, the missing 0.3% is almost entirely timeouts.
[Signal redesigns sealed sender v2](url) - they tried unifying visibility and notification, then split them back apart.

BAD news items:
[Docker ships microVM support](url) - Docker has added microVM support to Desktop 4.40, which is built on Firecracker and could be useful for agent sandboxing work in the community.

${matrixRules}

Return exactly this structure:
<subject>4-8 word subject line, no "What X wrote today"</subject>
<digest>your 3 paragraphs, one topic per paragraph, each with a linked source</digest>
<news>
[Headline](url) - one sentence, roughly 12 words, why they'd care.
[Headline](url) - one sentence, roughly 12 words, why they'd care.
[Headline](url) - one sentence, roughly 12 words, why they'd care.
</news>
<question>your question - reframes one specific topic, not a grand synthesis</question>`;
}

export function extractNewsletterTextContent(content: any[]): string {
  return (content || [])
    .filter((block: any) => block?.type === 'text')
    .map((block: any) => block.text)
    .join('');
}

export function parseNewsletterDigestText(textContent: string): NewsletterDigestResult | null {
  const subjectMatch = textContent.match(/<subject>([\s\S]*?)<\/subject>/);
  const digestMatch = textContent.match(/<digest>([\s\S]*?)<\/digest>/);
  const newsMatch = textContent.match(/<news>([\s\S]*?)<\/news>/);
  const questionMatch = textContent.match(/<question>([\s\S]*?)<\/question>/);

  if (!digestMatch) return null;

  const news: NewsletterNewsItem[] = [];
  if (newsMatch) {
    const lines = newsMatch[1].trim().split('\n').filter(line => line.trim());
    for (const line of lines) {
      const match = line.match(/\[([^\]]+)\]\(([^)]+)\)\s*[—\-–]\s*(.*)/);
      if (match) {
        news.push({ title: match[1], url: match[2], summary: match[3].trim() });
      }
    }
  }

  return {
    subject: subjectMatch ? subjectMatch[1].trim() : null,
    digest: digestMatch[1].trim(),
    news,
    question: questionMatch ? questionMatch[1].trim() : 'What are you working on today?',
  };
}

export async function generateNewsletterDigest(
  anthropic: Anthropic,
  opts: NewsletterDigestOptions,
): Promise<NewsletterDigestResult | null> {
  const response = await anthropic.messages.create({
    model: NEWSLETTER_DIGEST_MODEL,
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 10000 },
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 } as any],
    messages: [{
      role: 'user',
      content: buildNewsletterDigestPrompt(opts),
    }],
  } as any);

  return parseNewsletterDigestText(extractNewsletterTextContent(response.content as any[]));
}

export function formatNewsletterDigestForMatrix(result: NewsletterDigestResult): string {
  const parts = [result.digest.trim()];

  if (result.news.length > 0) {
    parts.push([
      'News for today:',
      ...result.news.map(item => `[${item.title}](${item.url}) - ${item.summary}`),
    ].join('\n'));
  }

  if (result.question.trim()) {
    parts.push(result.question.trim());
  }

  return parts.join('\n\n');
}
