// Bound per-suite concurrency independently of CPU count exposed by the host.
// Mutation runner concurrency is separate; avoid multiplying both blindly.
export function testWorkers(raw: string | undefined = process.env.INSPECTOR_TEST_WORKERS): number {
  if (raw === undefined) return 4;
  if (!/^[1-8]$/.test(raw)) throw new Error("INSPECTOR_TEST_WORKERS must be an integer from 1 to 8");
  return Number(raw);
}
