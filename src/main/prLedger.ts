import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  overlayKnown,
  replace,
  structural,
  unknownPaths,
  type PreserveSpec,
} from '../core/storePreserve';
import { log } from './log';

const PrLedgerSchema = z.object({
  version: z.literal(1),
  lastGoodAt: z.number(),
  seen: z.array(z.string()),
});

// ux3 S6: every known leaf is replaced; the passthrough is for unknown
// top-level keys a newer build may add.
const PR_LEDGER_PRESERVE_SPEC: PreserveSpec = structural({
  version: replace,
  lastGoodAt: replace,
  seen: replace,
});

const MAX_SEEN = 500;
// lastGoodAt is rewritten once a minute at most when nothing else changed —
// a 10 s poll cadence must not rewrite the file every poll.
const REFRESH_MS = 60_000;

// PR ledger: every PR URL a successful poll has ever listed, plus the
// timestamp of the last good poll. A baseline poll (restart/outage) diffs
// against this instead of `previousSessions` so PRs that appeared while the
// poller was down still auto-open once.
export class PrLedger {
  private readonly file: string;
  private urls: string[] = [];
  private urlSet = new Set<string>();
  private good = 0;
  private writtenGoodAt = 0;
  private raw: unknown = undefined;

  constructor(userData: string) {
    this.file = join(userData, 'pr-ledger.json');
    try {
      const json = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      const parsed = PrLedgerSchema.safeParse(json);
      if (parsed.success) {
        this.urls = parsed.data.seen.slice(-MAX_SEEN);
        this.urlSet = new Set(this.urls);
        this.good = parsed.data.lastGoodAt;
        this.writtenGoodAt = parsed.data.lastGoodAt;
        this.raw = json;
        const preserved = unknownPaths(json, parsed.data, PR_LEDGER_PRESERVE_SPEC);
        if (preserved.length > 0) {
          log('shell', 'store-preserved', { detail: { store: 'pr-ledger', keys: preserved } });
        }
      }
    } catch {
      // missing or corrupt -> empty ledger
    }
  }

  lastGoodAt(): number {
    return this.good;
  }

  seen(): ReadonlySet<string> {
    return this.urlSet;
  }

  record(urls: Iterable<string>, now: number): void {
    let added = false;
    for (const url of urls) {
      if (this.urlSet.has(url)) continue;
      this.urlSet.add(url);
      this.urls.push(url);
      added = true;
    }
    while (this.urls.length > MAX_SEEN) {
      const oldest = this.urls.shift()!;
      this.urlSet.delete(oldest);
    }
    this.good = now;
    if (!added && now - this.writtenGoodAt < REFRESH_MS) return;
    this.writtenGoodAt = now;
    try {
      if (!existsSync(this.file)) mkdirSync(join(this.file, '..'), { recursive: true });
      const out = overlayKnown(
        this.raw,
        { version: 1, lastGoodAt: this.good, seen: this.urls },
        PR_LEDGER_PRESERVE_SPEC,
      );
      writeFileSync(this.file, JSON.stringify(out));
      this.raw = out;
    } catch (error) {
      log('shell', 'pr-ledger-save-error', { detail: { message: String(error) } });
    }
  }
}

let ledger: PrLedger | null = null;

export function prLedger(userData?: string): PrLedger {
  if (!ledger) {
    if (!userData) throw new Error('prLedger not initialised');
    ledger = new PrLedger(userData);
  }
  return ledger;
}
