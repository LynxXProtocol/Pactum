import { WebhookWorker, enqueueWebhook } from '../src/workers/webhook';
import { IndexerListener } from '../src/indexer/listener';
import { getDLQEntries, clearDLQ } from '../src/db/dlq';

describe('Webhook Worker and Dead Letter Queue (DLQ)', () => {
  beforeEach(async () => {
    await clearDLQ();
  });

  describe('Exponential Backoff Calculations', () => {
    it('calculates correct exponential backoff delays', () => {
      const worker = new WebhookWorker({ baseDelayMs: 1000 });
      expect(worker.calculateBackoff(1)).toBe(1000);
      expect(worker.calculateBackoff(2)).toBe(2000);
      expect(worker.calculateBackoff(3)).toBe(4000);
      expect(worker.calculateBackoff(4)).toBe(8000);
    });
  });

  describe('Retry and DLQ Behavior', () => {
    it('retries failing webhooks and dumps to DLQ after 5 consecutive failures', async () => {
      let dispatchCount = 0;
      const failingDispatcher = async () => {
        dispatchCount++;
        return false; // Simulate HTTP non-ok or error
      };

      const worker = new WebhookWorker({
        baseDelayMs: 10,
        maxAttempts: 5,
        dispatcher: failingDispatcher,
      });

      worker.enqueue('https://example.com/webhook', { commitmentId: 'c123', status: 'ATTESTED' });

      // Run attempts 1 through 5
      for (let attempt = 1; attempt <= 5; attempt++) {
        await worker.processQueue();
        if (attempt < 5) {
          const queue = worker.getQueue();
          expect(queue.length).toBe(1);
          expect(queue[0].attempts).toBe(attempt);
          // Manually reset nextRetryAt for test fast-forwarding
          queue[0].nextRetryAt = 0;
        }
      }

      // After 5 attempts, the job must be removed from queue and written to DLQ
      expect(worker.getQueue().length).toBe(0);
      expect(dispatchCount).toBe(5);

      const dlqEntries = await getDLQEntries();
      expect(dlqEntries.length).toBe(1);
      expect(dlqEntries[0].url).toBe('https://example.com/webhook');
      expect(dlqEntries[0].attempts).toBe(5);
      expect(dlqEntries[0].payload).toEqual({ commitmentId: 'c123', status: 'ATTESTED' });
    });

    it('removes job from queue upon successful delivery without sending to DLQ', async () => {
      const mockDispatcher = jest.fn().mockResolvedValue(true);
      const worker = new WebhookWorker({ dispatcher: mockDispatcher });

      worker.enqueue('https://example.com/webhook', { test: true });
      await worker.processQueue();

      expect(worker.getQueue().length).toBe(0);
      expect(mockDispatcher).toHaveBeenCalledTimes(1);

      const dlqEntries = await getDLQEntries();
      expect(dlqEntries.length).toBe(0);
    });
  });

  describe('Indexer Listener Integration', () => {
    it('dispatches events asynchronously without blocking the main indexer loop', async () => {
      const listener = new IndexerListener([
        'https://example.com/hook1',
        'https://example.com/hook2',
      ]);

      const startTime = Date.now();
      listener.handleCommitmentUpdate({
        eventId: 'evt_001',
        commitmentId: 'commit_99',
        eventType: 'ATTESTED',
        issuer: 'GABC123',
        timestamp: new Date().toISOString(),
      });
      const duration = Date.now() - startTime;

      // Must complete immediately (< 50ms) without blocking for network responses
      expect(duration).toBeLessThan(50);
    });
  });
});
