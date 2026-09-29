async function save(): Promise<void> {}
export async function handler(xs: number[]): Promise<number> {
  await save();
  void save().catch(() => undefined);
  for (const _ of xs) await save();
  await Promise.all(xs.map(() => save()));
  const p = save();
  await p;
  return 1;
}
