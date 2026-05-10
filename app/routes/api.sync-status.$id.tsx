import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "~/db.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const syncId = params.id;

  if (!syncId) {
    return json({ error: "Missing sync ID" }, { status: 400 });
  }

  const syncLog = await prisma.syncLog.findUnique({
    where: { id: parseInt(syncId) },
  });

  if (!syncLog) {
    return json({ error: "SyncLog not found" }, { status: 404 });
  }

  return json({
    id: syncLog.id,
    status: syncLog.status,
    message: syncLog.message,
    processed: syncLog.processed,
    errors: syncLog.errors,
    createdAt: syncLog.createdAt,
  });
};
