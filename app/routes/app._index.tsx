import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  InlineStack,
  DataTable,
  EmptyState,
  Banner,
  Divider,
  Spinner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { scrapePaulyProducts } from "~/services/scraper.server";
import {
  bulkSyncPaulyToShopify,
  checkBulkOperationStatus,
  getBulkOperationDetails,
  updateSyncLogFromOperation,
} from "~/services/bulk-sync.server";
import prisma from "~/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const cronToken = process.env.CRON_TOKEN ?? null;
  const shopDomain = session?.shop || "";

  const totalSyncs = await prisma.syncLog.count();
  const successfulSyncs = await prisma.syncLog.count({
    where: { status: { in: ["success", "completed"] } },
  });

  const recentLogs = await prisma.syncLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const currentOperation = await checkBulkOperationStatus(admin);

  if (currentOperation && currentOperation.id) {
    const details = await getBulkOperationDetails(admin, currentOperation.id);

    if (
      details &&
      (details.status === "COMPLETED" ||
        details.status === "FAILED" ||
        details.status === "CANCELED")
    ) {
      await updateSyncLogFromOperation(
        details.id,
        details.status,
        details.objectCount || 0,
        details.errorCode,
      );

      const updatedRecentLogs = await prisma.syncLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      const updatedTotalSyncs = await prisma.syncLog.count();
      const updatedSuccessfulSyncs = await prisma.syncLog.count({
        where: { status: "success" },
      });

      return json({
        stats: {
          total: updatedTotalSyncs,
          successful: updatedSuccessfulSyncs,
          failureRate:
            updatedTotalSyncs > 0
              ? (
                  ((updatedTotalSyncs - updatedSuccessfulSyncs) /
                    updatedTotalSyncs) *
                  100
                ).toFixed(1)
              : "0",
        },
        recentLogs: updatedRecentLogs,
        currentOperation: null,
        cronUrl:
          cronToken && shopDomain
            ? `${new URL(request.url).origin}/cron?token=${cronToken}&shop=${shopDomain}`
            : null,
      });
    }
  }

  return json({
    stats: {
      total: totalSyncs,
      successful: successfulSyncs,
      failureRate:
        totalSyncs > 0
          ? (((totalSyncs - successfulSyncs) / totalSyncs) * 100).toFixed(1)
          : "0",
    },
    recentLogs,
    currentOperation,
    cronUrl:
      cronToken && shopDomain
        ? `${new URL(request.url).origin}/cron?token=${cronToken}&shop=${shopDomain}`
        : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const formData = await request.formData();
  const actionType = formData.get("action");

  if (actionType === "scrape") {
    try {
      const scrapedProducts = await scrapePaulyProducts();

      const shopDomain = session?.shop || "";
      const bulkJobs = await bulkSyncPaulyToShopify(
        admin,
        scrapedProducts,
        shopDomain,
      );

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

  if (actionType === "checkStatus") {
    try {
      const createJobId = formData.get("createJobId")?.toString();
      const updateJobId = formData.get("updateJobId")?.toString();

      const results: Record<string, unknown> = {};

      if (createJobId) {
        results.createStatus = await checkBulkOperationStatus(
          admin,
          createJobId,
        );
      }

      if (updateJobId) {
        results.updateStatus = await checkBulkOperationStatus(
          admin,
          updateJobId,
        );
      }

      return json(results);
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 },
      );
    }
  }

  return json({ error: "Invalid action" }, { status: 400 });
};

type ActionData = {
  success?: boolean;
  inProgress?: boolean;
  message?: string;
  error?: string;
  logId?: number;
  logIds?: number[];
  operation?: { id: string; status: string } | null;
  bulkJobs?: { createJobId?: string; updateJobId?: string } | null;
  stats?: { scraped: number };
};

type CheckStatusData = {
  createStatus?: { id: string; status: string; url?: string } | null;
  updateStatus?: { id: string; status: string; url?: string } | null;
  error?: string;
};

export default function Index() {
  const { stats, recentLogs, currentOperation, cronUrl } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const checkStatusFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const fetcherData = fetcher.data as ActionData | undefined;
  const checkStatusData = checkStatusFetcher.data as
    | CheckStatusData
    | undefined;

  const isLoading = fetcher.state !== "idle";
  const isCheckStatusLoading = checkStatusFetcher.state !== "idle";

  const handleSync = () => {
    fetcher.submit({ action: "scrape" }, { method: "post" });
  };

  const handleCheckStatus = () => {
    const formData: Record<string, string> = { action: "checkStatus" };
    if (fetcherData?.bulkJobs?.createJobId) {
      formData.createJobId = fetcherData.bulkJobs.createJobId;
    }
    if (fetcherData?.bulkJobs?.updateJobId) {
      formData.updateJobId = fetcherData.bulkJobs.updateJobId;
    }
    checkStatusFetcher.submit(formData, { method: "post" });
  };

  const operationInProgress =
    currentOperation &&
    (currentOperation.status === "RUNNING" ||
      currentOperation.status === "CREATED");

  useEffect(() => {
    if (!operationInProgress) return;
    const interval = setInterval(() => {
      revalidator.revalidate();
    }, 10000);
    return () => clearInterval(interval);
  }, [operationInProgress, revalidator]);

  return (
    <Page>
      <TitleBar title="Pauly Inventory Sync" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {operationInProgress && !fetcherData && (
              <Banner title="Bulk Operation in Progress" tone="info">
                <BlockStack gap="200">
                  <InlineStack gap="200" align="start">
                    <Text as="p" variant="bodyMd">
                      A bulk operation is currently running. Please wait for it
                      to complete.
                    </Text>
                    {revalidator.state === "loading" && (
                      <InlineStack gap="100" align="center">
                        <Spinner size="small" />
                        <Text as="span" tone="subdued">
                          Checking status...
                        </Text>
                      </InlineStack>
                    )}
                  </InlineStack>
                  <Text as="p" variant="bodyMd">
                    <strong>Operation ID:</strong> {currentOperation.id}
                  </Text>
                  <Text as="p" variant="bodyMd">
                    <strong>Status:</strong> {currentOperation.status}
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    The page will refresh automatically every 10 seconds.
                  </Text>
                </BlockStack>
              </Banner>
            )}

            {fetcherData &&
              !fetcherData.success &&
              fetcherData.inProgress && (
                <Banner title="Bulk operation in progress" tone="info">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">
                      {fetcherData.message}
                    </Text>
                    <Text as="p" variant="bodyMd">
                      Operation ID: {fetcherData.operation?.id}
                    </Text>
                    <Text as="p" variant="bodyMd">
                      Status: {fetcherData.operation?.status}
                    </Text>
                    <Text as="p" variant="bodyMd">
                      Please wait for it to complete before starting a new
                      sync.
                    </Text>
                  </BlockStack>
                </Banner>
              )}

            {fetcherData &&
              !fetcherData.success &&
              !fetcherData.inProgress && (
                <Banner title="Error during sync" tone="critical">
                  <Text as="p" variant="bodyMd">
                    {fetcherData.error}
                  </Text>
                </Banner>
              )}

            {fetcherData && fetcherData.success && (
              <Banner title="Bulk sync started successfully!" tone="success">
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">
                    {fetcherData.message}
                  </Text>
                  {fetcherData.bulkJobs?.createJobId && (
                    <Text as="p" variant="bodyMd">
                      Create Job ID: {fetcherData.bulkJobs.createJobId}
                    </Text>
                  )}
                  {fetcherData.bulkJobs?.updateJobId && (
                    <Text as="p" variant="bodyMd">
                      Update Job ID: {fetcherData.bulkJobs.updateJobId}
                    </Text>
                  )}
                </BlockStack>
              </Banner>
            )}

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Sync Stats
                </Text>
                <InlineStack gap="400">
                  <Text as="p" variant="bodyMd">
                    <strong>Total Syncs:</strong> {stats.total}
                  </Text>
                  <Text as="p" variant="bodyMd">
                    <strong>Successful:</strong> {stats.successful}
                  </Text>
                  <Text as="p" variant="bodyMd">
                    <strong>Failure Rate:</strong> {stats.failureRate}%
                  </Text>
                </InlineStack>
                <Divider />
                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    onClick={handleSync}
                    loading={isLoading}
                  >
                    {isLoading ? "Syncing..." : "Start Bulk Sync"}
                  </Button>
                  <Button
                    onClick={handleCheckStatus}
                    loading={isCheckStatusLoading}
                  >
                    {isCheckStatusLoading
                      ? "Checking..."
                      : "Debug Bulk Operation"}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {checkStatusData && !checkStatusData.error && (
              <Banner title="Bulk Operation Status" tone="info">
                <BlockStack gap="200">
                  {checkStatusData.createStatus && (
                    <Text as="p" variant="bodyMd">
                      Create Op: {checkStatusData.createStatus.status} (
                      {checkStatusData.createStatus.id})
                    </Text>
                  )}
                  {checkStatusData.updateStatus && (
                    <Text as="p" variant="bodyMd">
                      Update Op: {checkStatusData.updateStatus.status} (
                      {checkStatusData.updateStatus.id})
                    </Text>
                  )}
                  {!checkStatusData.createStatus &&
                    !checkStatusData.updateStatus && (
                      <Text as="p" variant="bodyMd">
                        No active bulk operations found.
                      </Text>
                    )}
                </BlockStack>
              </Banner>
            )}

            {checkStatusData && checkStatusData.error && (
              <Banner title="Error checking status" tone="critical">
                <Text as="p" variant="bodyMd">
                  {checkStatusData.error}
                </Text>
              </Banner>
            )}

            {cronUrl && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Automated Cron Endpoint
                  </Text>
                  <Text as="p" tone="subdued" variant="bodyMd">
                    Use this URL to schedule automatic syncs with external cron
                    services (Google Cloud Scheduler, GitHub Actions, etc.)
                  </Text>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd" fontWeight="bold">
                      Cron URL:
                    </Text>
                    <div
                      style={{
                        padding: "12px",
                        backgroundColor: "#f6f6f7",
                        borderRadius: "8px",
                        wordBreak: "break-all",
                        fontFamily: "monospace",
                        fontSize: "13px",
                      }}
                    >
                      {cronUrl}
                    </div>
                    <Button
                      onClick={() => {
                        navigator.clipboard.writeText(cronUrl);
                      }}
                      variant="secondary"
                    >
                      Copy to Clipboard
                    </Button>
                  </BlockStack>
                  <Divider />
                  <BlockStack gap="200">
                    <Text as="p" variant="headingSm">
                      Example with cURL:
                    </Text>
                    <div
                      style={{
                        padding: "12px",
                        backgroundColor: "#f6f6f7",
                        borderRadius: "8px",
                        wordBreak: "break-all",
                        fontFamily: "monospace",
                        fontSize: "13px",
                      }}
                    >
                      curl -X POST &quot;{cronUrl}&quot;
                    </div>
                  </BlockStack>
                </BlockStack>
              </Card>
            )}

            <Card>
              <BlockStack gap="200">
                <InlineStack
                  gap="200"
                  align="space-between"
                  blockAlign="center"
                >
                  <Text as="h2" variant="headingMd">
                    Recent Sync Logs
                  </Text>
                  {revalidator.state === "loading" && (
                    <InlineStack gap="100" align="center">
                      <Spinner size="small" />
                      <Text as="span" tone="subdued" variant="bodySm">
                        Updating...
                      </Text>
                    </InlineStack>
                  )}
                </InlineStack>
                {recentLogs.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "text", "numeric", "numeric"]}
                    headings={["Date", "Status", "Processed", "Errors"]}
                    rows={recentLogs.map((log) => [
                      new Date(log.createdAt).toLocaleString(),
                      log.status,
                      log.processed,
                      log.errors,
                    ])}
                  />
                ) : (
                  <EmptyState
                    heading="No sync logs yet"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <Text as="p" variant="bodyMd">
                      Start your first sync to see logs here.
                    </Text>
                  </EmptyState>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
