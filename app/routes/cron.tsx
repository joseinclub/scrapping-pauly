import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { scrapePaulyProducts } from "~/services/scraper.server";
import { unauthenticated } from "~/shopify.server";
import prisma from "~/db.server";
import { bulkSyncPaulyToShopify } from "~/services/bulk-sync.server";

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

    const bulkJobs = await bulkSyncPaulyToShopify(admin, scrapedProducts, shop);
    if (bulkJobs.existingOperation) {
      return json({
        success: false,
        inProgress: true,
        message: `A bulk operation is already in progress. Status: ${bulkJobs.existingOperation.status}`,
        operation: bulkJobs.existingOperation,
      });
    }

    const firstLogId = bulkJobs.logIds[0];

    return json({
      success: true,
      message: `Bulk sync started for ${scrapedProducts.length} products`,
      logId: firstLogId,
      logIds: bulkJobs.logIds,
      bulkJobs: {
        createJobId: bulkJobs.createJobId,
        updateJobId: bulkJobs.updateJobId,
      },
      stats: {
        scraped: scrapedProducts.length,
      },
    });
  } catch (error) {
    console.error("Bulk sync error:", error);
    await prisma.syncLog.create({
      data: {
        status: "error",
        message: error instanceof Error ? error.message : "Unknown error",
        processed: 0,
        errors: 1,
      },
    });

    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
