import * as cheerio from "cheerio";
import { logSyncOperation } from "./bulk-sync.server";

export interface PaulyVariant {
  title: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  price: string;
  compare_at_price: string | null;
  sku: string;
  available: boolean;
  id: number;
  inventoryQuantity: number | null;
  inventoryPolicy: "DENY" | "CONTINUE" | null;
}

export interface ScrapedProduct {
  handle: string;
  title: string;
  ref: string;
  description: string;
  tags: string[];
  productType: string;
  bodyHtml: string;
  images: string[];
  variants: PaulyVariant[];
  options: Array<{ name: string; values: string[] }>;
}

interface PaulyProductsJsonResponse {
  products: PaulyRawProduct[];
}

interface PaulyRawProduct {
  id: number;
  handle: string;
  title: string;
  body_html: string;
  tags: string | string[];
  product_type: string;
  options: Array<{ name: string; values: string[] }>;
  images: Array<{ src: string }>;
  variants: Array<{
    id: number;
    title: string;
    option1: string | null;
    option2: string | null;
    option3: string | null;
    price: string;
    compare_at_price: string | null;
    sku: string;
    available: boolean;
  }>;
}

export type HtmlScrapeFallbackReason =
  | "timeout"
  | "network"
  | "4xx"
  | "5xx"
  | "parse-error"
  | "empty-result";

const PAULY_BASE_URL = process.env.PAULY_URL || "https://www.paulylingerie.com";
const PRODUCTS_PER_PAGE = 250;
// 250ms keeps sequential scrapes ~4 req/s, well under paulylingerie.com Cloudflare 1200/min limit
const HTML_FETCH_DELAY_MS = 250;

const HTML_FETCH_TIMEOUT_MS = (() => {
  const raw = process.env.PAULY_HTML_FETCH_TIMEOUT_MS;
  if (!raw) return 10000;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 10000;
  return parsed;
})();

const RETRY_BACKOFF_MS = [2000, 8000];
const MAX_ATTEMPTS = 3;

const USE_FULL_PRICE_AS_BASE = process.env.USE_FULL_PRICE_AS_BASE !== "0";

interface ScrapeMetafieldsResult {
  inventoryByVariantId: Map<number, { quantity: number; policy: "DENY" | "CONTINUE" }>;
  reason: HtmlScrapeFallbackReason | null;
  attempts: number;
}

function parseHtmlForMetafields(html: string): {
  inventoryByVariantId: Map<number, { quantity: number; policy: "DENY" | "CONTINUE" }>;
} {
  const $ = cheerio.load(html);

  const inventoryByVariantId = new Map<
    number,
    { quantity: number; policy: "DENY" | "CONTINUE" }
  >();

  $("option[data-inventoryquantity]").each((_, el) => {
    const variantId = parseInt($(el).attr("value") ?? "", 10);
    if (Number.isNaN(variantId)) return;

    const quantity = parseInt($(el).attr("data-inventoryquantity") ?? "", 10);
    if (Number.isNaN(quantity)) return;

    const rawPolicy = ($(el).attr("data-inventorypolicy") ?? "").toLowerCase();
    let policy: "DENY" | "CONTINUE";
    if (rawPolicy === "deny") {
      policy = "DENY";
    } else if (rawPolicy === "continue") {
      policy = "CONTINUE";
    } else {
      return;
    }

    inventoryByVariantId.set(variantId, { quantity, policy });
  });

  return { inventoryByVariantId };
}

type AttemptOutcome =
  | {
      kind: "success";
      inventoryByVariantId: Map<number, { quantity: number; policy: "DENY" | "CONTINUE" }>;
    }
  | {
      kind: "permanent";
      reason: HtmlScrapeFallbackReason;
      inventoryByVariantId: Map<number, { quantity: number; policy: "DENY" | "CONTINUE" }>;
    }
  | { kind: "transient"; reason: HtmlScrapeFallbackReason; retryAfterMs?: number };

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

async function performSingleAttempt(url: string): Promise<AttemptOutcome> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      signal: AbortSignal.timeout(HTML_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    return { kind: "transient", reason: isTimeout ? "timeout" : "network" };
  }

  const status = response.status;
  if (status === 429 || status === 408) {
    return { kind: "transient", reason: "5xx", retryAfterMs: parseRetryAfter(response) };
  }
  if (status >= 400 && status < 500) {
    return {
      kind: "permanent",
      reason: "4xx",
      inventoryByVariantId: new Map(),
    };
  }
  if (status >= 500 && status < 600) {
    return { kind: "transient", reason: "5xx" };
  }

  let parsed: ReturnType<typeof parseHtmlForMetafields>;
  try {
    const html = await response.text();
    parsed = parseHtmlForMetafields(html);
  } catch {
    return { kind: "transient", reason: "parse-error" };
  }

  if (parsed.inventoryByVariantId.size === 0) {
    return {
      kind: "permanent",
      reason: "empty-result",
      inventoryByVariantId: parsed.inventoryByVariantId,
    };
  }

  return {
    kind: "success",
    inventoryByVariantId: parsed.inventoryByVariantId,
  };
}

async function scrapeProductMetafields(
  handle: string,
): Promise<ScrapeMetafieldsResult> {
  const url = `${PAULY_BASE_URL}/products/${handle}`;
  const emptyMap = () =>
    new Map<number, { quantity: number; policy: "DENY" | "CONTINUE" }>();

  try {
    let lastTransientReason: HtmlScrapeFallbackReason = "network";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const outcome = await performSingleAttempt(url);

      if (outcome.kind === "success") {
        return {
          inventoryByVariantId: outcome.inventoryByVariantId,
          reason: null,
          attempts: attempt,
        };
      }

      if (outcome.kind === "permanent") {
        return {
          inventoryByVariantId: outcome.inventoryByVariantId,
          reason: outcome.reason,
          attempts: attempt,
        };
      }

      lastTransientReason = outcome.reason;

      if (attempt < MAX_ATTEMPTS) {
        const delay = outcome.retryAfterMs ?? RETRY_BACKOFF_MS[attempt - 1];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return {
      inventoryByVariantId: emptyMap(),
      reason: lastTransientReason,
      attempts: MAX_ATTEMPTS,
    };
  } catch (error) {
    console.warn(
      `HTML scraping failed for product "${handle}":`,
      error instanceof Error ? error.message : String(error),
    );
    return {
      inventoryByVariantId: emptyMap(),
      reason: "network",
      attempts: MAX_ATTEMPTS,
    };
  }
}

export async function scrapePaulyProducts(): Promise<ScrapedProduct[]> {
  const allProducts: ScrapedProduct[] = [];
  const fallbacks: Array<{ handle: string; ref: string; reason: HtmlScrapeFallbackReason }> = [];
  let page = 1;

  while (true) {
    const url = `${PAULY_BASE_URL}/products.json?limit=${PRODUCTS_PER_PAGE}&page=${page}`;

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Pauly products (page ${page}): HTTP ${response.status}`,
      );
    }

    let data: PaulyProductsJsonResponse;
    try {
      data = await response.json();
    } catch {
      throw new Error(
        `Invalid JSON response from Pauly products API (page ${page})`,
      );
    }

    if (!data.products || data.products.length === 0) {
      break;
    }

    for (const raw of data.products) {
      // REQ-02: identity from product.id (stable Shopify numeric id), not regex on handle
      const ref = String(raw.id);

      const images = raw.images.map((img) => img.src);

      const variants: PaulyVariant[] = raw.variants.map((v) => {
        const compareAtPrice = v.compare_at_price ?? null;
        const hasValidComparePrice =
          compareAtPrice !== null &&
          compareAtPrice !== "" &&
          compareAtPrice !== "0.00";
        const effectivePrice =
          USE_FULL_PRICE_AS_BASE && hasValidComparePrice
            ? compareAtPrice
            : v.price;

        return {
          title: v.title,
          option1: v.option1,
          option2: v.option2,
          option3: v.option3,
          price: effectivePrice,
          compare_at_price: compareAtPrice,
          sku: v.sku || "",
          available: v.available,
          id: v.id,
          inventoryQuantity: null,
          inventoryPolicy: null,
        };
      });

      let tags: string[];
      if (Array.isArray(raw.tags)) {
        tags = raw.tags.map((t) => t.trim()).filter(Boolean);
      } else if (typeof raw.tags === "string") {
        tags = raw.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      } else {
        tags = [];
      }

      const options = Array.isArray(raw.options)
        ? raw.options.map((o: any) => ({
            name: o.name || "",
            values: Array.isArray(o.values) ? o.values : [],
          }))
        : [];

      allProducts.push({
        handle: raw.handle,
        title: raw.title,
        ref,
        description: raw.body_html || "",
        tags,
        productType: raw.product_type || "",
        bodyHtml: raw.body_html || "",
        images,
        variants,
        options,
      });
    }

    if (data.products.length < PRODUCTS_PER_PAGE) {
      break;
    }

    page++;
  }

  for (let i = 0; i < allProducts.length; i++) {
    const product = allProducts[i];

    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, HTML_FETCH_DELAY_MS));
    }

    const metafields = await scrapeProductMetafields(product.handle);

    if (metafields.reason) {
      console.warn(
        JSON.stringify({
          event: "html-scrape-fallback",
          handle: product.handle,
          ref: product.ref,
          reason: metafields.reason,
          attempts: metafields.attempts,
        }),
      );
      fallbacks.push({
        handle: product.handle,
        ref: product.ref,
        reason: metafields.reason,
      });
    }

    for (const v of product.variants) {
      const entry = metafields.inventoryByVariantId.get(v.id);
      if (entry) {
        v.inventoryQuantity = entry.quantity;
        v.inventoryPolicy = entry.policy;
      }
    }
  }

  if (fallbacks.length > 0) {
    await logSyncOperation(
      "html-scrape-fallback",
      null,
      "partial",
      fallbacks.length,
      0,
      fallbacks.map((f) => f.handle),
    );
  }

  return allProducts;
}
