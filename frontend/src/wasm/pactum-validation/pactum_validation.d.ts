/* tslint:disable */
/* eslint-disable */

export function deserialize_ast_binary_to_json(rule_set_bytes: Uint8Array): string;

export function evaluate_ast_binary(
  rule_set_bytes: Uint8Array,
  context_json: string,
  gas_limit?: number | null,
  record_steps?: boolean | null,
): any;

export function evaluate_ast_json(
  rule_set_json: string,
  context_json: string,
  gas_limit?: number | null,
  record_steps?: boolean | null,
): any;

export function serialize_ast_json_to_binary(rule_set_json: string): Uint8Array;

export function validate_commitment_params(
  due_at: bigint,
  current_time: bigint,
  milestone_count: number,
): void;

export function verify_trace_hash(trace_json: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly deserialize_ast_binary_to_json: (a: number, b: number, c: number) => void;
  readonly evaluate_ast_binary: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => void;
  readonly evaluate_ast_json: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
  ) => void;
  readonly serialize_ast_json_to_binary: (a: number, b: number, c: number) => void;
  readonly validate_commitment_params: (a: number, b: bigint, c: bigint, d: number) => void;
  readonly verify_trace_hash: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export: (a: number, b: number) => number;
  readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?:
    { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>,
): Promise<InitOutput>;
