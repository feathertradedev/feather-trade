import { FULL_HISTORY_START_TIMESTAMP, type AnalyticsEngine, type CanonicalHead } from "./engine.js";
import type { BlockEnvelope } from "./types.js";

export interface BackfillPage {
  blocks: BlockEnvelope[];
  nextCursor: string | null;
  hasMore: boolean;
  canonicalHead?: CanonicalHead | null;
  rewindTo?: CanonicalHead | null;
}

export interface BackfillResult {
  status: "complete" | "partial" | "capped";
  pagesLoaded: number;
  blocksLoaded: number;
  cursor: string | null;
  error: string | null;
}

export async function runBackfill(input: {
  engine: AnalyticsEngine;
  fetchPage: (cursor: string | null) => Promise<BackfillPage>;
  startCursor?: string | null;
  maxPages?: number;
}): Promise<BackfillResult> {
  const maxPages = input.maxPages ?? 10_000;
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) throw new Error("maxPages must be a positive integer");

  let cursor = input.startCursor ?? null;
  let pagesLoaded = 0;
  let blocksLoaded = 0;
  let earliestTimestamp: number | null = null;
  let latestTimestamp: number | null = null;
  const priorBackfill = input.engine.exportCheckpoint().backfill;
  const priorCoverageStart = priorBackfill.coverageStartTimestamp;
  const coverageStart = () =>
    input.startCursor == null ? FULL_HISTORY_START_TIMESTAMP : priorCoverageStart ?? earliestTimestamp;
  const coverageThrough = () => {
    let timestamp = latestTimestamp ?? input.engine.exportCheckpointMetadata().backfill.coverageThroughTimestamp;
    const canonicalHeadTimestamp = input.engine.getCanonicalHead()?.timestamp ?? null;
    if (timestamp !== null && canonicalHeadTimestamp !== null) {
      timestamp = Math.min(timestamp, canonicalHeadTimestamp);
    }
    return timestamp;
  };
  if (input.startCursor != null && priorCoverageStart === null) {
    const message = "Cannot resume backfill without prior coverage state";
    input.engine.updateBackfillState({ status: "partial", cursor, error: message });
    throw new Error(message);
  }
  input.engine.updateBackfillState({ status: "running", cursor, error: null });

  while (pagesLoaded < maxPages) {
    try {
      const page = await input.fetchPage(cursor);
      if (page.blocks.length === 0 && page.hasMore) {
        throw new Error("Backfill page cannot be empty while hasMore is true");
      }
      if (page.rewindTo !== null && page.rewindTo !== undefined) {
        input.engine.rewindCanonicalHead(page.rewindTo);
      }
      for (const block of [...page.blocks].sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0))) {
        input.engine.ingestBlock(block);
        blocksLoaded += 1;
        earliestTimestamp = earliestTimestamp === null ? block.timestamp : Math.min(earliestTimestamp, block.timestamp);
        latestTimestamp = latestTimestamp === null ? block.timestamp : Math.max(latestTimestamp, block.timestamp);
      }
      if (!page.hasMore && page.canonicalHead !== null && page.canonicalHead !== undefined) {
        input.engine.rewindCanonicalHead(page.canonicalHead);
      }
      pagesLoaded += 1;

      if (!page.hasMore) {
        input.engine.updateBackfillState({
          status: "complete",
          cursor: page.nextCursor,
          error: null,
          coverageStartTimestamp: coverageStart(),
          coverageThroughTimestamp: coverageThrough()
        });
        return { status: "complete", pagesLoaded, blocksLoaded, cursor: page.nextCursor, error: null };
      }
      if (page.nextCursor === null || page.nextCursor === cursor) throw new Error("Backfill cursor did not advance");
      cursor = page.nextCursor;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backfill page failed";
      input.engine.updateBackfillState({
        status: "partial",
        cursor,
        error: message,
        coverageStartTimestamp: coverageStart(),
        coverageThroughTimestamp: coverageThrough()
      });
      if (pagesLoaded === 0 && blocksLoaded === 0) throw error;
      return {
        status: "partial",
        pagesLoaded,
        blocksLoaded,
        cursor,
        error: message
      };
    }
  }

  input.engine.updateBackfillState({
    status: "capped",
    cursor,
    error: null,
    coverageStartTimestamp: coverageStart(),
    coverageThroughTimestamp: coverageThrough()
  });
  return { status: "capped", pagesLoaded, blocksLoaded, cursor, error: null };
}
