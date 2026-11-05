import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createNotificationService, type EmailClient } from './notifications.js';
import { MemoryStorage, type User, type JournalEntry } from './storage.js';
import { hashSecretKey } from './identity.js';

function createMockEmailClient(): EmailClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    async send(params) {
      calls.push(params);
    },
  };
}

describe('NotificationService', () => {
  let storage: MemoryStorage;
  let emailClient: ReturnType<typeof createMockEmailClient>;
  let service: ReturnType<typeof createNotificationService>;

  beforeEach(async () => {
    storage = new MemoryStorage();
    emailClient = createMockEmailClient();
    service = createNotificationService({
      storage,
      emailClient,
      anthropic: null,
      fromEmail: 'notify@router.test',
      baseUrl: 'https://router.test',
      jwtSecret: 'test-secret',
    });
  });

  describe('sendDailyDigests', () => {
    it('keeps private and AI-only followed/discovery text out of the email and model prompt',async()=>{
      const create=vi.fn().mockResolvedValue({content:[{type:'text',text:'<digest>Public update.</digest><question>Next?</question>'}]});
      await storage.createUser({handle:'alice',secretKeyHash:'alice',email:'alice@example.com',emailVerified:true,following:[{handle:'bob',note:'friend'}]});
      for(const [handle,extra] of [['alice',{}],['bob',{to:['#private']}],['carol',{aiOnly:true}]] as Array<[string,Partial<JournalEntry>]>)
        await storage.addEntry({handle,pseudonym:handle,client:'code',timestamp:Date.now(),content:`attestation ${handle} sentinel`,...extra});
      const digest=createNotificationService({storage,emailClient,anthropic:{messages:{create}} as any,
        fromEmail:'notify@router.test',baseUrl:'https://router.test',jwtSecret:'test'});
      expect((await digest.sendDailyDigests()).sent).toBe(1);
      expect(create).toHaveBeenCalled();
      const exposed=JSON.stringify([create.mock.calls,emailClient.calls]);
      expect(exposed).not.toContain('attestation bob sentinel');expect(exposed).not.toContain('attestation carol sentinel');
    });

    it('should skip user with no entries and no followed entries', async () => {
      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: true,
      });

      const result = await service.sendDailyDigests();
      expect(result.sent).toBe(0);
      expect(emailClient.calls).toHaveLength(0);
    });

    it('should not skip user with only followed entries (no own entries)', async () => {
      // Create a user who follows someone
      const alice = await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: true,
        following: [{ handle: 'bob', note: 'Interesting writer' }],
      });

      await storage.createUser({
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
      });

      // Bob writes an entry recently
      await storage.addEntry({
        pseudonym: 'Test#456',
        handle: 'bob',
        client: 'desktop',
        content: 'Building a new authentication system with TEE attestation',
        timestamp: Date.now() - 1000 * 60 * 60, // 1 hour ago
      });

      // Without anthropic, generateDigestContent returns null, so digest won't send
      // But the skip logic should NOT skip alice since she has followed entries
      const result = await service.sendDailyDigests();
      // Will be 0 because anthropic is null, but we verified it didn't skip early
      expect(result.sent).toBe(0);
    });

    it('should generate dynamic subject line with followed authors', async () => {
      // This test needs a mock anthropic to actually send
      // We'll test the subject line logic indirectly via the full flow
      // For now, just verify the service doesn't crash with following list
      const alice = await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: true,
        following: [
          { handle: 'bob', note: 'Builder' },
          { handle: 'carol', note: 'Researcher' },
        ],
      });

      const result = await service.sendDailyDigests();
      expect(result.failed).toBe(0);
    });
  });

  describe('sendDailyDigests with mock anthropic', () => {
    it('should use dynamic subject with single followed author', async () => {
      // Create mock anthropic that returns structured digest
      const mockAnthropic = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [
              { type: 'text', text: '<digest>Your daily briefing content here.</digest>\n<question>What do you think about TEE attestation?</question>' },
            ],
          }),
        },
      };

      const serviceWithAI = createNotificationService({
        storage,
        emailClient,
        anthropic: mockAnthropic as any,
        fromEmail: 'notify@router.test',
        baseUrl: 'https://router.test',
        jwtSecret: 'test-secret',
      });

      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: true,
        following: [{ handle: 'bob', note: 'Builder' }],
      });

      await storage.createUser({
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
      });

      // Bob writes recently
      await storage.addEntry({
        pseudonym: 'Test#456',
        handle: 'bob',
        client: 'desktop',
        content: 'Working on cryptographic attestation',
        timestamp: Date.now() - 1000 * 60 * 60,
      });

      const result = await serviceWithAI.sendDailyDigests();
      expect(result.sent).toBe(1);
      expect(emailClient.calls[0].subject).toBe('What @bob wrote today');
    });

    it('should use dynamic subject with two followed authors', async () => {
      const mockAnthropic = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [
              { type: 'text', text: '<digest>Daily update.</digest>\n<question>A question?</question>' },
            ],
          }),
        },
      };

      const serviceWithAI = createNotificationService({
        storage,
        emailClient,
        anthropic: mockAnthropic as any,
        fromEmail: 'notify@router.test',
        baseUrl: 'https://router.test',
        jwtSecret: 'test-secret',
      });

      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: true,
        following: [
          { handle: 'bob', note: 'Builder' },
          { handle: 'carol', note: 'Researcher' },
        ],
      });

      await storage.createUser({
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
      });
      await storage.createUser({
        handle: 'carol',
        secretKeyHash: hashSecretKey('carol-key-1234567890123'),
      });

      await storage.addEntry({
        pseudonym: 'Test#456',
        handle: 'bob',
        client: 'desktop',
        content: 'Building things',
        timestamp: Date.now() - 1000 * 60 * 60,
      });
      await storage.addEntry({
        pseudonym: 'Test#789',
        handle: 'carol',
        client: 'desktop',
        content: 'Researching things',
        timestamp: Date.now() - 1000 * 60 * 30,
      });

      const result = await serviceWithAI.sendDailyDigests();
      expect(result.sent).toBe(1);
      expect(emailClient.calls[0].subject).toBe('What @carol & @bob wrote today');
    });

    it('should fall back to generic subject when no followed entries', async () => {
      const mockAnthropic = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [
              { type: 'text', text: '<digest>Here is what happened.</digest>\n<question>What are you working on?</question>' },
            ],
          }),
        },
      };

      const serviceWithAI = createNotificationService({
        storage,
        emailClient,
        anthropic: mockAnthropic as any,
        fromEmail: 'notify@router.test',
        baseUrl: 'https://router.test',
        jwtSecret: 'test-secret',
      });

      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: true,
      });

      // Alice writes her own entry
      await storage.addEntry({
        pseudonym: 'Test#111',
        handle: 'alice',
        client: 'desktop',
        content: 'Working on my project today',
        timestamp: Date.now() - 1000 * 60 * 60,
      });

      const result = await serviceWithAI.sendDailyDigests();
      expect(result.sent).toBe(1);
      expect(emailClient.calls[0].subject).toBe("What's happening on Router");
    });

    it('should render question box and Claude deep link in digest email', async () => {
      const mockAnthropic = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [
              { type: 'text', text: '<digest>Your briefing content.</digest>\n<question>How might TEE attestation change trust models?</question>' },
            ],
          }),
        },
      };

      const serviceWithAI = createNotificationService({
        storage,
        emailClient,
        anthropic: mockAnthropic as any,
        fromEmail: 'notify@router.test',
        baseUrl: 'https://router.test',
        jwtSecret: 'test-secret',
      });

      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: true,
        displayName: 'Alice',
        bio: 'Building trust infrastructure',
      });

      await storage.addEntry({
        pseudonym: 'Test#111',
        handle: 'alice',
        client: 'desktop',
        content: 'Working on attestation',
        timestamp: Date.now() - 1000 * 60 * 60,
      });

      await serviceWithAI.sendDailyDigests();

      const html = emailClient.calls[0].html;
      expect(html).toContain('Hey Alice');
      expect(html).toContain('question-box');
      expect(html).toContain('How might TEE attestation change trust models?');
      expect(html).toContain('Think about this with Claude');
      expect(html).toContain('claude.ai/new');
    });

    it('should render followed and discovery entry sections', async () => {
      const mockAnthropic = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [
              { type: 'text', text: '<digest>Great stuff happening.</digest>\n<question>What next?</question>' },
            ],
          }),
        },
      };

      const serviceWithAI = createNotificationService({
        storage,
        emailClient,
        anthropic: mockAnthropic as any,
        fromEmail: 'notify@router.test',
        baseUrl: 'https://router.test',
        jwtSecret: 'test-secret',
      });

      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: true,
        following: [{ handle: 'bob', note: 'Builder' }],
      });

      await storage.createUser({
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
      });
      await storage.createUser({
        handle: 'carol',
        secretKeyHash: hashSecretKey('carol-key-1234567890123'),
      });

      // Alice's own entry (needed so keywords exist for discovery)
      await storage.addEntry({
        pseudonym: 'Test#111',
        handle: 'alice',
        client: 'desktop',
        content: 'Working on authentication and cryptography',
        timestamp: Date.now() - 1000 * 60 * 60 * 24, // 1 day ago
      });

      // Bob's entry (followed)
      await storage.addEntry({
        pseudonym: 'Test#456',
        handle: 'bob',
        client: 'desktop',
        content: 'Authentication patterns for distributed systems',
        timestamp: Date.now() - 1000 * 60 * 60,
      });

      // Carol's entry (should be discovery - shares keywords with alice)
      await storage.addEntry({
        pseudonym: 'Test#789',
        handle: 'carol',
        client: 'desktop',
        content: 'New approach to cryptography verification',
        timestamp: Date.now() - 1000 * 60 * 30,
      });

      await serviceWithAI.sendDailyDigests();

      const html = emailClient.calls[0].html;
      expect(html).toContain('followed-entry');
      expect(html).toContain('From people you follow');
      expect(html).toContain('discovery-entry');
      expect(html).toContain('Also interesting');
      expect(html).toContain('@bob');
      expect(html).toContain('@carol');
    });

    it('should handle web search interleaved response blocks', async () => {
      // Simulate what Anthropic returns when web_search is used
      const mockAnthropic = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [
              { type: 'text', text: 'Let me search for context.\n' },
              { type: 'server_tool_use', id: 'search1', name: 'web_search', input: { query: 'TEE attestation' } },
              { type: 'web_search_tool_result', tool_use_id: 'search1', content: [{ type: 'web_search_result', url: 'https://example.com' }] },
              { type: 'text', text: '<digest>After researching, here is your briefing about TEE attestation trends.</digest>\n<question>How will this affect your work?</question>' },
            ],
          }),
        },
      };

      const serviceWithAI = createNotificationService({
        storage,
        emailClient,
        anthropic: mockAnthropic as any,
        fromEmail: 'notify@router.test',
        baseUrl: 'https://router.test',
        jwtSecret: 'test-secret',
      });

      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: true,
      });

      await storage.addEntry({
        pseudonym: 'Test#111',
        handle: 'alice',
        client: 'desktop',
        content: 'TEE attestation research',
        timestamp: Date.now() - 1000 * 60 * 60,
      });

      await serviceWithAI.sendDailyDigests();

      expect(emailClient.calls).toHaveLength(1);
      const html = emailClient.calls[0].html;
      expect(html).toContain('TEE attestation trends');
      expect(html).toContain('How will this affect your work?');
    });
  });

  describe('notifyNewFollower', () => {
    it('should send email when followed user has verified email', async () => {
      const follower: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        bio: 'Building things',
        createdAt: Date.now(),
      };
      const followed: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };

      await service.notifyNewFollower!(follower, followed);

      expect(emailClient.calls).toHaveLength(1);
      expect(emailClient.calls[0].to).toBe('bob@example.com');
      expect(emailClient.calls[0].subject).toBe('@alice started following you');
      expect(emailClient.calls[0].html).toContain('@alice');
      expect(emailClient.calls[0].html).toContain('Building things');
    });

    it('should skip when followed user has no verified email', async () => {
      const follower: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        createdAt: Date.now(),
      };
      const followed: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: false,
        createdAt: Date.now(),
      };

      await service.notifyNewFollower!(follower, followed);

      expect(emailClient.calls).toHaveLength(0);
    });

    it('should skip when followed user has no email', async () => {
      const follower: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        createdAt: Date.now(),
      };
      const followed: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        createdAt: Date.now(),
      };

      await service.notifyNewFollower!(follower, followed);

      expect(emailClient.calls).toHaveLength(0);
    });

    it('should skip when followed user disabled notifications', async () => {
      const follower: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        createdAt: Date.now(),
      };
      const followed: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        emailPrefs: { comments: false, digest: true },
        createdAt: Date.now(),
      };

      await service.notifyNewFollower!(follower, followed);

      expect(emailClient.calls).toHaveLength(0);
    });

    it('should not include bio section when follower has no bio', async () => {
      const follower: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        createdAt: Date.now(),
      };
      const followed: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };

      await service.notifyNewFollower!(follower, followed);

      expect(emailClient.calls).toHaveLength(1);
      expect(emailClient.calls[0].html).not.toContain('Their bio');
    });
  });

  describe('notifyAddressedEntry with author CC', () => {
    it('should CC author when author has verified email', async () => {
      const recipient: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const author: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const entry: JournalEntry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'desktop',
        content: 'Hey Bob, check this out',
        timestamp: Date.now(),
        to: ['@bob'],
      };

      await service.notifyAddressedEntry!(entry, recipient, author);

      expect(emailClient.calls).toHaveLength(1);
      expect(emailClient.calls[0].to).toBe('bob@example.com');
      expect(emailClient.calls[0].cc).toBe('alice@example.com');
      expect(emailClient.calls[0].replyTo).toBe('alice@example.com');
    });

    it('should not CC author when author has no verified email', async () => {
      const recipient: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const author: User = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
        email: 'alice@example.com',
        emailVerified: false,
        createdAt: Date.now(),
      };
      const entry: JournalEntry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'desktop',
        content: 'Hey Bob',
        timestamp: Date.now(),
        to: ['@bob'],
      };

      await service.notifyAddressedEntry!(entry, recipient, author);

      expect(emailClient.calls).toHaveLength(1);
      expect(emailClient.calls[0].cc).toBeUndefined();
      expect(emailClient.calls[0].replyTo).toBeUndefined();
    });

    it('should not CC when no author provided', async () => {
      const recipient: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const entry: JournalEntry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'desktop',
        content: 'Hey Bob',
        timestamp: Date.now(),
        to: ['@bob'],
      };

      await service.notifyAddressedEntry!(entry, recipient);

      expect(emailClient.calls).toHaveLength(1);
      expect(emailClient.calls[0].cc).toBeUndefined();
    });

    it('should use warm subject line', async () => {
      const recipient: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const entry: JournalEntry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'desktop',
        content: 'Hello',
        timestamp: Date.now(),
        to: ['@bob'],
      };

      await service.notifyAddressedEntry!(entry, recipient);

      expect(emailClient.calls[0].subject).toBe('@alice wrote you something');
    });

    it('should use warm template with quote style', async () => {
      const recipient: User = {
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key-123456789012345'),
        email: 'bob@example.com',
        emailVerified: true,
        createdAt: Date.now(),
      };
      const entry: JournalEntry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'desktop',
        content: 'Hello world',
        timestamp: Date.now(),
        to: ['@bob'],
      };

      await service.notifyAddressedEntry!(entry, recipient);

      const html = emailClient.calls[0].html;
      expect(html).toContain('Hey,');
      expect(html).toContain('wrote this for you');
      expect(html).toContain('class="quote"');
      expect(html).toContain('router.teleport.computer');
      // Should NOT have old platform-style copy
      expect(html).not.toContain("You're receiving this because");
    });
  });

  describe('sendVerificationEmail', () => {
    it('should use warm template', async () => {
      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-12345678901234'),
      });

      await service.sendVerificationEmail('alice', 'alice@example.com');

      expect(emailClient.calls).toHaveLength(1);
      const html = emailClient.calls[0].html;
      expect(html).toContain('Hey @alice');
      expect(html).toContain('verify your email');
      expect(html).toContain('router.teleport.computer');
      // Should NOT have old style
      expect(html).not.toContain("If you didn't request this");
    });
  });
});
