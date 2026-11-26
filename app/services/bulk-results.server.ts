/**
 * Reads a finished bulk operation's result file for the lines that failed.
 *
 * WHY: COMPLETED only means Shopify ran every line. Per-line userErrors (a productSet
 * HANDLE_NOT_UNIQUE or INVALID_PRODUCT with a null product) exist only in the result file, so
 * Pitbull's creates failed every hour for days while SyncLog said "completed".
 *
 * No imports, so `node --test` and the QA harness load this file as is.
 */

const RESULT_DOWNLOAD_TIMEOUT_MS = 3000;
const FAILURE_SAMPLES = 20;

interface BulkResultLine {
  data?: Record<string, { userErrors?: Array<{ code?: string | null; message: string }>; product?: unknown } | null>;
  errors?: Array<{ message: string }>;
  __lineNumber?: number;
}

/** Failed lines of a result file (JSONL): `#<line> <CODE> <message>`. */
export function bulkResultFailures(text: string) {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const failures: string[] = [];
  for (const line of lines) {
    const row = JSON.parse(line) as BulkResultLine;
    const payload = row.data ? Object.values(row.data)[0] : null;
    const reasons = [
      ...(payload?.userErrors ?? []).map((e) => `${e.code ?? "ERROR"} ${e.message}`),
      ...(row.errors ?? []).map((e) => e.message),
    ];
    // A productSet line with a null product failed even without a userError.
    if (reasons.length === 0 && payload && payload.product !== null) continue;
    failures.push(`#${row.__lineNumber ?? "?"} ${reasons.join(", ") || "empty result"}`.slice(0, 200));
  }
  return { total: lines.length, failures };
}

export async function readBulkResultFailures(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(RESULT_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return bulkResultFailures(await response.text());
}

/**
 * How a COMPLETED operation's SyncLog row should end once its result file is read: failed when
 * every line failed, partial when some did, unchanged when none did or the file could not be
 * read (then the message says so).
 */
export async function completedRowFromResult(url: string | undefined | null, objectCount: number) {
  if (!url) return { status: "completed" as const, processed: objectCount, errors: 0, tail: "" };
  try {
    const { total, failures } = await readBulkResultFailures(url);
    if (failures.length === 0) return { status: "completed" as const, processed: objectCount, errors: 0, tail: "" };
    return {
      status: failures.length === total ? ("failed" as const) : ("partial" as const),
      processed: total - failures.length,
      errors: failures.length,
      tail: ` — ${failures.length}/${total} failed: ${failures.slice(0, FAILURE_SAMPLES).join("; ")}`,
    };
  } catch (error) {
    return {
      status: "completed" as const,
      processed: objectCount,
      errors: 0,
      tail: ` — result file not checked: ${error instanceof Error ? error.message : error}`,
    };
  }
}
