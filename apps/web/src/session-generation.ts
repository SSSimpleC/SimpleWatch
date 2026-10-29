// Fences late restore/login responses after local or cross-tab session cleanup.
// This is page-local lifecycle state, never an authentication credential.
let generation = 0;

export function currentSessionGeneration(): number {
  return generation;
}

export function invalidateSessionOperations(): number {
  generation += 1;
  return generation;
}
