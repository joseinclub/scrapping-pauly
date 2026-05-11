import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { scrapePaulyProducts } from "~/services/scraper.server";
import { unauthenticated } from "~/shopify.server";
import {
  bulkSyncPaulyToShopify,
  logSyncOperation,
} from "~/services/bulk-sync.server";

if (!process.env.CRON_TOKEN) {
  throw new Error("CRON_TOKEN is required but not set in environment");
}

const CRON_TOKEN = process.env.CRON_TOKEN;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return handleCronRequest(request);
};

export const action = async ({ request }: LoaderFunctionArgs) => {
  return handleCronRequest(request);
};

async function handleCronRequest(request: Request) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const shop = url.searchParams.get("shop");

    if (token !== CRON_TOKEN) {
      return json(
        {
          success: false,
          error: "Unauthorized",
          message: "Invalid or missing token",
        },
        { status: 401 },
      );
    }

    if (!shop) {
      return json(
        {
          success: false,
          error: "Bad Request",
          message: "Missing 'shop' parameter",
        },
        { status: 400 },
      );
    }

    const { admin } = await unauthenticated.admin(shop);

    const scrapedProducts = await scrapePaulyProducts();

    const result = await bulkSyncPaulyToShopify(admin, scrapedProducts, shop);
    if (result.existingOperation) {
      return json({
        success: false,
        inProgress: true,
        message: `A bulk operation is already in progress. Status: ${result.existingOperation.status}`,
        operation: result.existingOperation,
      });
    }

    const bulkOperationIds: Record<string, string> = {};
    if (result.createJobId) bulkOperationIds.create = result.createJobId;
    if (result.updateJobId) bulkOperationIds.update = result.updateJobId;
    if (result.archiveJobId) bulkOperationIds.archive = result.archiveJobId;
    if (result.orphanDeleteJobId)
      bulkOperationIds.orphanDelete = result.orphanDeleteJobId;
    if (result.reactivatedCount > 0 && result.updateJobId)
      bulkOperationIds.reactivate = result.updateJobId;

    return json({
      success: true,
      message: `Bulk sync dispatched (${scrapedProducts.length} products scraped)`,
      stats: {
        scraped: scrapedProducts.length,
      },
      status: "pending",
      bulkOperationIds,
      logId: result.logIds[0],
      logIds: result.logIds,
    });
  } catch (error) {
    console.error("Bulk sync error:", error);
    await logSyncOperation(
      "cron-error",
      null,
      "failed",
      0,
      1,
      [error instanceof Error ? error.message : "Unknown error"],
    );

    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
