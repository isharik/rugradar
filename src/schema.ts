/**
 * Public input/output contract for RugRadar's one tool: assess_token_risk.
 *
 * Design goals: strong input validation, a stable structured output, and every
 * signal explicitly able to say "not_available" so we never fake a result.
 */
import { z } from "zod";

/** EVM address validator (0x + 40 hex). */
export const AddressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/i, "must be a 0x-prefixed 40-hex-character EVM address");

/** Chain may be an id (number or numeric string) or a name/alias string. */
export const ChainSchema = z.union([
  z.number().int().positive(),
  z.string().trim().min(1),
]);

export const AssessInputSchema = z.object({
  chain: ChainSchema.describe(
    "Chain id (e.g. 1) or name/alias (e.g. 'ethereum', 'bsc', 'base'). Defaults to Ethereum if omitted.",
  ).optional(),
  token_address: AddressSchema.describe(
    "The token/contract address to assess (0x-prefixed, 40 hex chars).",
  ),
});
export type AssessInput = z.infer<typeof AssessInputSchema>;

// --- Output types --------------------------------------------------------

export type Verdict = "SAFE" | "CAUTION" | "HIGH_RISK" | "AVOID";
export type Confidence = "high" | "medium" | "low";

/** Tri-state result for a single signal so we can honestly report "unknown". */
export type SignalStatus = "pass" | "warn" | "fail" | "not_available";

export interface SignalCheck {
  /** Machine key, e.g. "sellability". */
  id: string;
  /** Human label. */
  label: string;
  status: SignalStatus;
  /** Short human detail, e.g. "sell tax 12%" or "source unreachable". */
  detail: string;
  /** Optional structured value (number/bool/string) when meaningful. */
  value?: number | boolean | string | null;
  /** How many risk points this signal contributed to the score. */
  weight: number;
}

export interface SourceStatus {
  name: string;
  reachable: boolean;
  detail?: string;
}

export interface AssessResult {
  ok: true;
  /** Echo of normalized input for idempotency/debuggability. */
  request: {
    chain_id: number;
    chain_name: string;
    token_address: string;
  };
  token: {
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    total_holders: number | null;
  };
  /** 0 (safe) .. 100 (maximally risky). */
  risk_score: number;
  verdict: Verdict;
  confidence: Confidence;
  signals: SignalCheck[];
  /** One-paragraph, human-relayable explanation. */
  explanation: string;
  /** Which data sources were reachable at call time. */
  sources: SourceStatus[];
  /** Non-fatal notes (e.g. which sources were skipped/unreachable). */
  notes: string[];
  /** ISO timestamp; stateless — purely informational. */
  assessed_at: string;
  explorer_url: string;
}

/** Shape returned on validation / hard errors (still structured, never a bare throw). */
export interface AssessError {
  ok: false;
  error: {
    code:
      | "INVALID_INPUT"
      | "UNSUPPORTED_CHAIN"
      | "INTERNAL_ERROR";
    message: string;
    /** Helpful hints for the caller, e.g. list of supported chains. */
    details?: unknown;
  };
}

export type AssessOutput = AssessResult | AssessError;
