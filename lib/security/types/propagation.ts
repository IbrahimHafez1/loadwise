/**
 * Which argument of a taint-carrying call the result copies: 'keep' and 'keep-any' also keep the
 * `whole` flag.
 */
export type PropagationSource = 'receiver' | 'first' | 'any' | 'keep' | 'keep-any';

/** How a call carries taint from an input to its result. */
export interface Propagation {
  from: PropagationSource;
  name: string | undefined;
  /** Receiver methods only: whether the receiver may be a string. */
  stringResult?: boolean;
}
