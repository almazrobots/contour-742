// NFR-PERF-RUNTIME (T-138): гистограмма в формате Prometheus. Пределы §11 ТЗ (ML-анализ параметра ≤ 500 мс,
// CV-анализ листа ≤ 30 с, отправка в «РиН» ≤ 30 с) проверяются в эксплуатации алертом по p95 —
// histogram_quantile(0.95, …) по корзинам. Граница предела обязана совпадать с одной из корзин: иначе p95 у предела
// интерполируется между соседними корзинами и алерт срабатывает не на пределе, а где-то рядом.

export class Histogram {
  private readonly counts: number[];
  sum = 0;
  count = 0;

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[],
  ) {
    if (!buckets.length) throw new Error(`${name}: нужна хотя бы одна граница корзины`);
    for (const b of buckets) if (!Number.isFinite(b)) throw new Error(`${name}: границы корзин — конечные числа (+Inf добавляется сама)`);
    for (let i = 1; i < buckets.length; i++) if (buckets[i] <= buckets[i - 1]) throw new Error(`${name}: границы корзин должны возрастать`);
    this.counts = buckets.map(() => 0);
  }

  /** Наблюдение в единицах гистограммы. Отрицательное, NaN и бесконечность — сломанный замер, не учитывается. */
  observe(v: number): void {
    if (!Number.isFinite(v) || v < 0) return;
    this.count++;
    this.sum += v;
    const i = this.buckets.findIndex((b) => v <= b);
    if (i >= 0) this.counts[i]++;
  }

  /** Доля наблюдений строго выше предела; предел — одна из границ корзин. */
  overShare(limit: number): number {
    const i = this.buckets.indexOf(limit);
    if (i < 0) throw new Error(`${this.name}: предел ${limit} не совпадает ни с одной из границ корзин`);
    if (!this.count) return 0;
    const upTo = this.counts.slice(0, i + 1).reduce((a, b) => a + b, 0);
    return (this.count - upTo) / this.count;
  }

  /** Строки экспозиции Prometheus: корзины накопительные, пустая гистограмма — нули, а не пропуск ряда. */
  lines(): string[] {
    let acc = 0;
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    this.buckets.forEach((b, i) => {
      acc += this.counts[i];
      out.push(`${this.name}_bucket{le="${b}"} ${acc}`);
    });
    out.push(`${this.name}_bucket{le="+Inf"} ${this.count}`, `${this.name}_sum ${Math.round(this.sum * 1e6) / 1e6}`, `${this.name}_count ${this.count}`);
    return out;
  }
}
