import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ScoreData } from '../schemas/stateProof';

export interface BufferedProofItem {
  stellarAddress: string;
  scoreData: ScoreData;
  enqueuedAt: number;
}

export interface DurableQueueSnapshot {
  items: BufferedProofItem[];
}

/**
 * JSON-file durable queue so a relayer restart does not drop buffered proofs.
 * Writes are atomic (temp file + rename). Same-address enqueues replace in place.
 */
export class DurableProofQueue {
  private items: Map<string, BufferedProofItem> = new Map();
  private persistPath?: string;

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
  }

  public async restore(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const raw = await readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as DurableQueueSnapshot;
      if (!Array.isArray(parsed.items)) return;
      this.items.clear();
      for (const item of parsed.items) {
        if (item?.stellarAddress && item.scoreData) {
          this.items.set(item.stellarAddress, item);
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn('[DurableProofQueue] Failed to restore queue:', err);
      }
    }
  }

  public size(): number {
    return this.items.size;
  }

  public oldestEnqueuedAt(): number | undefined {
    let oldest: number | undefined;
    for (const item of this.items.values()) {
      if (oldest === undefined || item.enqueuedAt < oldest) {
        oldest = item.enqueuedAt;
      }
    }
    return oldest;
  }

  public list(): BufferedProofItem[] {
    return [...this.items.values()];
  }

  public async enqueue(stellarAddress: string, scoreData: ScoreData, now: number): Promise<void> {
    const existing = this.items.get(stellarAddress);
    this.items.set(stellarAddress, {
      stellarAddress,
      scoreData,
      enqueuedAt: existing?.enqueuedAt ?? now,
    });
    await this.persist();
  }

  public async drain(): Promise<BufferedProofItem[]> {
    const drained = this.list();
    this.items.clear();
    await this.persist();
    return drained;
  }

  public async replace(items: BufferedProofItem[]): Promise<void> {
    this.items.clear();
    for (const item of items) {
      this.items.set(item.stellarAddress, item);
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.persistPath) return;
    const snapshot: DurableQueueSnapshot = { items: this.list() };
    const payload = JSON.stringify(snapshot);
    const tmp = `${this.persistPath}.${process.pid}.tmp`;
    await mkdir(dirname(this.persistPath), { recursive: true });
    await writeFile(tmp, payload, 'utf8');
    try {
      await rename(tmp, this.persistPath);
    } catch {
      await unlink(this.persistPath).catch(() => undefined);
      await rename(tmp, this.persistPath);
    }
  }
}
