import { Router, Request, Response, NextFunction } from 'express';
import { commitmentSchema } from '../schemas/commitment';
import { z, ZodError } from 'zod';
import { strictLimiter } from '../middleware/rateLimiter';
import pool from '../db/timescale';
import { logger } from '../logger/logger';

// ── Encrypted Payload Schema ──────────────────────────────────────────────────
// Validates the body of POST /commitments/encrypted.
// The backend never decrypts this data — it is a dumb blob store.
const encryptedPayloadSchema = z.object({
  commitmentId: z.string().min(1, 'commitmentId is required'),
  issuer: z.string().regex(/^G[A-Z2-7]{55}$/, 'issuer must be a valid Stellar public key (G...)'),
  counterparty: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'counterparty must be a valid Stellar public key (G...)'),
  // base64url(IV[12] || AES-GCM ciphertext || auth-tag[16])
  ciphertext: z
    .string()
    .min(1, 'ciphertext is required')
    .max(65536, 'ciphertext must not exceed 64 KB'),
});

type EncryptedPayloadInput = z.infer<typeof encryptedPayloadSchema>;

const router = Router();

export const commitmentQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  issuer: z.string().optional(),
  counterparty: z.string().optional(),
  status: z.enum(['pending', 'active', 'completed', 'disputed']).optional(),
  template: z.enum(['Freeform', 'RefundDeposit', 'SLAGuarantee', 'MilestoneCheckIn']).optional(),
});

export type CommitmentQueryInput = z.infer<typeof commitmentQuerySchema>;

export interface CommitmentOutcomeRow {
  time: string | Date;
  id: string | number;
  partyA: string;
  partyB: string | null;
  status: string;
  outcome: string;
  dueDate: string | Date;
  completedAt: string | Date | null;
  createdAt: string | Date;
}

const toUnixSeconds = (value: string | Date): number =>
  Math.floor(new Date(value).getTime() / 1000);

/**
 * Maps a commitment_outcomes row onto the shape frontend/src/lib/api.ts's `Commitment` type
 * actually expects (issuer/counterparty/due_at/status as 'Pending'|'Fulfilled'|...). The two
 * were never aligned -- commitment_outcomes uses partyA/partyB and lowercase
 * status/outcome columns predating this contract's data model, so every row this route
 * returned was silently unusable: CommitmentItem (App.tsx) does
 * `commitment.issuer.charAt(0)` unconditionally, which throws given `issuer` was always
 * undefined, so the Commitments list rendered nothing for any row, ever.
 *
 * terms_hash has no equivalent in commitment_outcomes at all (off-chain, not tracked by this
 * table) -- returned as '' rather than omitted, since the field is typed as a required string.
 */
export function toApiCommitment(row: CommitmentOutcomeRow) {
  const isTerminal = row.status === 'completed';
  const status =
    row.status === 'disputed'
      ? 'Disputed'
      : isTerminal
        ? row.outcome === 'late'
          ? 'Late'
          : row.outcome === 'breached'
            ? 'Breached'
            : 'Fulfilled'
        : 'Pending';

  return {
    id: Number(row.id),
    issuer: row.partyA,
    counterparty: row.partyB ?? '',
    terms_hash: '',
    due_at: toUnixSeconds(row.dueDate),
    status,
    outcome: status === 'Pending' ? null : status,
    created_at: toUnixSeconds(row.createdAt),
    attested_at: row.completedAt ? toUnixSeconds(row.completedAt) : null,
  };
}

export type KeysetCursor = {
  time: string;
  id: string;
};

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(token: string): KeysetCursor | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.time === 'string' && typeof parsed.id === 'string') {
      return parsed as KeysetCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validation middleware using Zod for POST/PUT commitment bodies.
 */
const validateCommitment = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const validatedData = commitmentSchema.parse(req.body);
    req.body = validatedData;
    next();
  } catch (error) {
    if (error instanceof ZodError) {
      const formattedErrors = error.errors.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
      }));

      res.status(400).json({
        error: 'Bad Request',
        details: formattedErrors,
      });
      return;
    }
    next(error);
  }
};

// POST /commitments - Create a new commitment
router.post('/', strictLimiter, validateCommitment, async (req: Request, res: Response): Promise<void> => {
  const { issuer, counterparty, due_at } = req.body;

  // Use a timestamp-based ID to avoid collisions with the on-chain Soroban counter (1, 2, 3...)
  // and so it parses as a Number in GET /commitments.
  const optimisticId = Date.now();

  try {
    await pool.query(
      `INSERT INTO commitment_outcomes
       (commitment_id, party_a, party_b, amount, status, outcome, due_date, time)
       VALUES ($1, $2, $3, 0, 'pending', 'pending', to_timestamp($4), NOW())`,
      [optimisticId.toString(), issuer, counterparty, due_at]
    );

    logger.info('Created optimistic commitment', { issuer, counterparty, commitmentId: optimisticId });

    res.status(201).json({
      id: optimisticId,
      status: 'Pending',
    });
  } catch (error) {
    logger.error('Failed to insert optimistic commitment', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /commitments/:id - Fetch a single commitment by its on-chain id.
// Mounted after /export above so that path segment is never captured here.
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: 'Bad Request', message: 'id must be a non-negative integer' });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT
         time,
         commitment_id as id,
         party_a as "partyA",
         party_b as "partyB",
         amount,
         currency,
         status,
         template,
         outcome,
         due_date as "dueDate",
         completed_at as "completedAt",
         created_at as "createdAt"
       FROM commitment_outcomes
       WHERE commitment_id = $1
       ORDER BY time DESC
       LIMIT 1`,
      [id],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Not Found', message: `No commitment with id ${id}` });
      return;
    }

    // Apply the same commitment_outcomes -> Commitment shape transform GET / uses (see
    // toApiCommitment's doc comment) -- without it, `issuer`/`counterparty`/`due_at` come back
    // undefined and the frontend's lookup page throws rendering it.
    res.status(200).json(toApiCommitment(result.rows[0]));
  } catch (error) {
    logger.error('Failed to fetch commitment by id', error, { id });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /commitments - High-Performance Keyset Cursor Pagination & Dynamic Filtering (Pactum #124)
router.get('/', async (req: Request, res: Response) => {
  const parseResult = commitmentQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'Bad Request',
      details: parseResult.error.issues,
    });
    return;
  }

  const { cursor, limit, issuer, counterparty, status, template } = parseResult.data;
  let decodedCursor: KeysetCursor | null = null;

  if (cursor) {
    decodedCursor = decodeCursor(cursor);
    if (!decodedCursor) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid pagination cursor provided.',
      });
      return;
    }
  }

  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];

  if (issuer) {
    params.push(issuer);
    conditions.push(`party_a = $${params.length}`);
  }

  if (counterparty) {
    params.push(counterparty);
    conditions.push(`party_b = $${params.length}`);
  }

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  if (template) {
    params.push(template);
    conditions.push(`template = $${params.length}`);
  }

  if (decodedCursor) {
    params.push(decodedCursor.time);
    params.push(decodedCursor.id);
    conditions.push(`(time, commitment_id) < ($${params.length - 1}, $${params.length})`);
  }

  params.push(limit + 1);
  const sql = `
    SELECT
      time,
      commitment_id as id,
      party_a as "partyA",
      party_b as "partyB",
      amount,
      currency,
      status,
      template,
      outcome,
      due_date as "dueDate",
      completed_at as "completedAt",
      created_at as "createdAt"
    FROM commitment_outcomes
    WHERE ${conditions.join(' AND ')}
    ORDER BY time DESC, commitment_id DESC
    LIMIT $${params.length}
  `;

  try {
    const result = await pool.query(sql, params);
    const rows = result.rows || [];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      nextCursor = encodeCursor({
        time: new Date(lastItem.time).toISOString(),
        id: String(lastItem.id),
      });
    }

    res.status(200).json({
      items: items.map(toApiCommitment),
      next_cursor: nextCursor,
      limit,
      has_more: hasMore,
      filter: {
        ...(issuer ? { issuer } : {}),
        ...(counterparty ? { counterparty } : {}),
        ...(status ? { status } : {}),
        ...(template ? { template } : {}),
      },
    });
  } catch (error) {
    logger.error('Database query failed for /commitments', error, {
      filter: { issuer, counterparty, status, template },
    });

    res.status(503).json({
      error: 'Service Unavailable',
      message: 'Database query failed for commitments.',
    });
  }
});

// ── POST /commitments/encrypted ─────────────────────────────────────────────
// Stores the AES-GCM encrypted terms blob for a commitment.
// The backend never receives nor stores plaintext — only the opaque ciphertext.
router.post('/encrypted', strictLimiter, async (req: Request, res: Response): Promise<void> => {
  const parseResult = encryptedPayloadSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'Bad Request',
      details: parseResult.error.issues,
    });
    return;
  }

  const { commitmentId, issuer, counterparty, ciphertext }: EncryptedPayloadInput =
    parseResult.data;

  // Sanity: issuer and counterparty must differ
  if (issuer.trim().toUpperCase() === counterparty.trim().toUpperCase()) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'issuer and counterparty addresses must be different.',
    });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO encrypted_payloads (commitment_id, issuer, counterparty, ciphertext)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (commitment_id)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                       issuer = EXCLUDED.issuer,
                       counterparty = EXCLUDED.counterparty`,
      [commitmentId, issuer, counterparty, ciphertext],
    );

    logger.info('Encrypted payload stored for commitment', { commitmentId, issuer });

    res.status(201).json({ message: 'Encrypted terms stored successfully.' });
  } catch (error) {
    logger.error('Failed to store encrypted payload', error, { commitmentId });
    res.status(503).json({
      error: 'Service Unavailable',
      message: 'Failed to store encrypted commitment payload.',
    });
  }
});

// ── GET /commitments/:id/encrypted ───────────────────────────────────────────
// Returns the ciphertext blob for the given commitment ID.
// Decryption happens entirely in the browser — the server returns only ciphertext.
router.get('/:id/encrypted', async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id ?? '');

  if (!id || id.trim().length === 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Commitment ID is required.' });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT ciphertext, issuer, counterparty, created_at
       FROM encrypted_payloads
       WHERE commitment_id = $1
       LIMIT 1`,
      [id.trim()],
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: 'No encrypted payload found for this commitment.',
      });
      return;
    }

    const { ciphertext, issuer, counterparty, created_at } = result.rows[0];
    res.status(200).json({ ciphertext, issuer, counterparty, createdAt: created_at });
  } catch (error) {
    logger.error('Failed to fetch encrypted payload', error, { commitmentId: id });
    res.status(503).json({
      error: 'Service Unavailable',
      message: 'Failed to fetch encrypted commitment payload.',
    });
  }
});

export default router;
