import { z } from 'zod';

export const commitmentSchema = z.object({
  issuer: z.string().regex(/^G[A-Z2-7]{55}$/, 'issuer must be a valid Stellar public key (G...)'),
  counterparty: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'counterparty must be a valid Stellar public key (G...)'),
  terms_hash: z.string(),
  due_at: z.number().int().positive(),
});

export type CommitmentInput = z.infer<typeof commitmentSchema>;
