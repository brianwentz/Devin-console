import io

def edit(path, pairs):
    s = io.open(path, encoding='utf8').read()
    for old, new in pairs:
        assert old in s, path + ': missing ' + old[:70]
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf8').write(s)

# ---------- core/claudeUsage.ts ----------
edit('src/core/claudeUsage.ts', [
# 1) zero-token models dropped: skip addTotals entry only if the whole usage is
# zero — simplest correct rule: after the line's totals are added, a model that
# contributed nothing must not create a byModel/byDay entry at all.
("""    const model = typeof parsed.message.model === 'string' ? parsed.message.model : 'unknown';
    const bucket = (out[month] ??= { byModel: {}, byDay: {} });
    addTotals((bucket.byModel[model] ??= emptyTotals()), usage);
    const perModel =
      (Number(usage.input_tokens) || 0) +
      (Number(usage.output_tokens) || 0) +
      (Number(usage.cache_read_input_tokens) || 0) +
      (Number(usage.cache_creation_input_tokens) || 0);
    const perDay = (bucket.byDay[day] ??= {});
    perDay[model] = (perDay[model] ?? 0) + perModel;
  }
  return out;
}""",
 """    const model = typeof parsed.message.model === 'string' ? parsed.message.model : 'unknown';
    const perModel =
      (Number(usage.input_tokens) || 0) +
      (Number(usage.output_tokens) || 0) +
      (Number(usage.cache_read_input_tokens) || 0) +
      (Number(usage.cache_creation_input_tokens) || 0);
    // Zero-token lines (e.g. `<synthetic>`) contribute nothing — drop the
    // whole line rather than leaving an all-zero model row.
    if (perModel === 0) continue;
    const bucket = (out[month] ??= { byModel: {}, byDay: {} });
    addTotals((bucket.byModel[model] ??= emptyTotals()), usage);
    const perDay = (bucket.byDay[day] ??= {});
    perDay[model] = (perDay[model] ?? 0) + perModel;
  }
  return out;
}"""),
# 2) fileMayContainMonths helper next to fileScanPlan
("""/** Group per-host credentials into usage accounts: same email → one account. */""",
 """/**
 * Cold-scan gate: a file whose mtime is older than the start of the earliest
 * month of interest can't contain lines from any requested month (line
 * timestamps precede the file's last write) → skip reading it entirely.
 */
export function fileMayContainMonths(mtimeMs: number, months: Set<string>): boolean {
  if (months.size === 0) return true;
  let earliest: number | null = null;
  for (const key of months) {
    const [y, m] = key.split('-').map(Number);
    if (!y || !m) continue;
    const start = new Date(y, m - 1, 1).getTime(); // local midnight of the 1st
    if (earliest === null || start < earliest) earliest = start;
  }
  return earliest === null || mtimeMs >= earliest;
}

/** Group per-host credentials into usage accounts: same email → one account. */"""),
])

# ---------- main/claude/usage.ts ----------
edit('src/main/claude/usage.ts', [
("""  aggregateUsageLines,
  emptyClaudeUsageState,
  fileScanPlan,""",
 """  aggregateUsageLines,
  emptyClaudeUsageState,
  fileMayContainMonths,
  fileScanPlan,"""),
# 3) empty-string account-file env → unset
("""    const file = testMode
      ? (process.env.DEVIN_WORKSPACES_TEST_CLAUDE_ACCOUNT_FILE ?? null)
      : join(dirname(configDir), '.claude.json');""",
 """    const file = testMode
      ? (process.env.DEVIN_WORKSPACES_TEST_CLAUDE_ACCOUNT_FILE?.trim() ||
        join(dirname(configDir), '.claude.json'))
      : join(dirname(configDir), '.claude.json');"""),
# 4) start(): wait for enumeration; chain the onStatusChange slot
("""  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadCache();
    void this.fetchAll();
    void this.scanAll();
    this.schedule();
  }""",
 """  private hostChangePrev: (() => void) | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadCache();
    // Wait for the first distro enumeration so wsl hosts are in list() for
    // the first pass; later probe completions poke a re-fetch via the
    // host-change hook below.
    void hosts()
      .whenEnumerated()
      .then(() => {
        void this.fetchAll();
        void this.scanAll();
        this.schedule();
      });
    // Chain the single onStatusChange slot (claude sessions owns it): a host
    // that becomes ready after the first pass gets fetched + scanned.
    this.hostChangePrev = hosts().onStatusChange;
    this.hostChangeFn = () => {
      this.hostChangePrev?.();
      this.poke('hosts');
    };
    hosts().onStatusChange = this.hostChangeFn;
  }"""),
# 5) poke reasons: 'hosts' triggers fetch+scan
("""  /** Debounced fetch trigger: app-driven turn end or a Stop hook event. */
  poke(_reason: 'turn' | 'hook'): void {
    if (!this.started) return;
    if (this.pokeTimer) return;
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.fetchAll();
    }, POKE_DEBOUNCE_MS);
  }""",
 """  /** Debounced fetch trigger: app-driven turn end, a Stop hook event, or a
   * host becoming ready ('hosts' also rescans — a new store appeared). */
  poke(reason: 'turn' | 'hook' | 'hosts'): void {
    if (!this.started) return;
    if (this.pokeTimer) return;
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.fetchAll();
      if (reason === 'hosts') void this.scanAll();
    }, POKE_DEBOUNCE_MS);
  }"""),
# 6) dispose: restore the chained slot
("""  dispose(): void {
    for (const t of [this.fetchTimer, this.scanTimer, this.pokeTimer]) {
      if (t) clearTimeout(t);
    }
    this.fetchTimer = this.scanTimer = this.pokeTimer = null;
  }""",
 """  dispose(): void {
    for (const t of [this.fetchTimer, this.scanTimer, this.pokeTimer]) {
      if (t) clearTimeout(t);
    }
    this.fetchTimer = this.scanTimer = this.pokeTimer = null;
    if (this.hostChangeFn && hosts().onStatusChange === this.hostChangeFn) {
      hosts().onStatusChange = this.hostChangePrev;
    }
    this.hostChangeFn = null;
  }

  private hostChangeFn: (() => void) | null = null;"""),
# 7) scan: mtime gate + skipped count
("""      let changed = 0;
      let files = 0;
    try {""",
 """      let changed = 0;
      let files = 0;
      let skipped = 0;
    try {"""),
("""      for (const task of tasks) {
        const cached = this.cache.files[task.key];
        const stat = statSync(task.path);
        const plan = fileScanPlan(cached, stat.size, stat.mtimeMs);
        let buckets: UsageBuckets = cached?.buckets ?? {};
        if (plan !== 'reuse') {""",
 """      for (const task of tasks) {
        const cached = this.cache.files[task.key];
        const stat = statSync(task.path);
        const plan = fileScanPlan(cached, stat.size, stat.mtimeMs);
        let buckets: UsageBuckets = cached?.buckets ?? {};
        if (plan !== 'reuse' && !fileMayContainMonths(stat.mtimeMs, months)) {
          // Older than the previous month — can't contain relevant lines;
          // skip the read and pin it as fully consumed.
          skipped += 1;
          this.cache.files[task.key] = {
            size: stat.size,
            mtime: stat.mtimeMs,
            offset: stat.size,
            buckets: {},
          };
        } else if (plan !== 'reuse') {"""),
("""      log('claude', 'usage-scan', { detail: { files, changed, ms: Date.now() - start } });""",
 """      log('claude', 'usage-scan', {
        detail: { files, changed, skipped, ms: Date.now() - start },
      });"""),
])

print('edits done')
