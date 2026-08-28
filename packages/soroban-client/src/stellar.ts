import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

export function isStellarAddress(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value);
}

export const stellarAddressSchema = z
  .string()
  .min(1, 'Stellar address is required')
  .refine(isStellarAddress, {
    message: 'Must be a valid Stellar address (56 chars starting with G)',
  });
