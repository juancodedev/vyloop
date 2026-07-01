export function noop(..._args: unknown[]): void {
  // intentional no-op
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
