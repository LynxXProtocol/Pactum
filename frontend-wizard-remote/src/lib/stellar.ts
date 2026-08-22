import { z } from 'zod';

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export function isStellarAddress(value: string): boolean {
  return STELLAR_ADDRESS_RE.test(value);
}

export const stellarAddressSchema = z
  .string()
  .min(1, 'Stellar address is required')
  .refine(isStellarAddress, {
    message: 'Must be a valid Stellar address (56 chars starting with G)',
  });
