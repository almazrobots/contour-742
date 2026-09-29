async function save(): Promise<void> {}
export async function handler(xs: number[]): Promise<void> {
  save();
  xs.forEach(async () => { await save(); });
  Promise.resolve(1).then(() => 2);
}
