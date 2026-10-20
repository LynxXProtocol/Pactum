import { useMutation, type QueryKey, type UseMutationOptions } from '@tanstack/react-query';
import { conflictEngine } from '../lib/queryClient';

interface OptimisticConfig<TData> {
  queryKey: QueryKey;
  /** The entity version this mutation assumes it's building on (e.g. current vote count / ledger seq). */
  baseVersion: number;
  /** Wallet/address performing the mutation, used to tell our own confirmation apart from a conflict. */
  actorId: string;
  /** Value to show in the cache immediately, before the chain confirms it. */
  optimisticData: TData;
}

/**
 * useMutation wrapper that registers an inflight mutation ID with the conflict
 * engine so a concurrent chain event on the same slice can be reconciled
 * without invalidating unrelated queries.
 */
export function useOptimisticMutation<TData, TVariables>(
  optimisticConfig: (variables: TVariables) => OptimisticConfig<TData>,
  options: UseMutationOptions<unknown, Error, TVariables>,
) {
  return useMutation({
    ...options,
    onMutate: async (variables, mutationCtx) => {
      const mutationId = crypto.randomUUID();
      const { queryKey, baseVersion, actorId, optimisticData } = optimisticConfig(variables);
      conflictEngine.beginMutation(mutationId, queryKey, baseVersion, actorId, optimisticData);
      const result = await options.onMutate?.(variables, mutationCtx);
      return Object.assign({}, result, { mutationId });
    },
    onError: (error, variables, onMutateResult, mutationCtx) => {
      const mutationId = (onMutateResult as { mutationId?: string } | undefined)?.mutationId;
      if (mutationId) conflictEngine.settleMutation(mutationId, 'error');
      options.onError?.(error, variables, onMutateResult, mutationCtx);
    },
    onSuccess: (data, variables, onMutateResult, mutationCtx) => {
      const mutationId = (onMutateResult as { mutationId?: string } | undefined)?.mutationId;
      if (mutationId) conflictEngine.settleMutation(mutationId, 'success');
      options.onSuccess?.(data, variables, onMutateResult, mutationCtx);
    },
  });
}
