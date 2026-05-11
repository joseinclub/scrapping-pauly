import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  getBulkOperationDetails,
  updateSyncLogFromOperation,
} from "../services/bulk-sync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload } = await authenticate.webhook(request);

  const bulkOpId = (payload as { admin_graphql_api_id?: string })
    .admin_graphql_api_id;
  if (!bulkOpId) {
    return Response.json({ received: true }, { status: 200 });
  }

  const row = await db.syncLog.findFirst({
    where: { status: "running", message: { contains: bulkOpId } },
    orderBy: { createdAt: "desc" },
  });

  if (!row) {
    console.warn(
      `webhooks.bulk-operations.finish: no running SyncLog row for ${bulkOpId}`,
    );
    return Response.json(
      { received: true, note: "no matching SyncLog row" },
      { status: 200 },
    );
  }

  if (!admin) {
    console.warn(
      `webhooks.bulk-operations.finish: no admin client for ${bulkOpId}`,
    );
    await db.syncLog.update({
      where: { id: row.id, status: "running" },
      data: {
        status: "failed",
        message: `${row.message} — webhook received but admin client unavailable — final status unverified`,
      },
    });
    return Response.json({ received: true }, { status: 200 });
  }

  const details = await getBulkOperationDetails(admin, bulkOpId);
  if (details) {
    await updateSyncLogFromOperation(
      bulkOpId,
      details.status,
      details.objectCount ?? 0,
      details.errorCode,
      details.userErrors,
    );
  }

  return Response.json({ received: true }, { status: 200 });
};
