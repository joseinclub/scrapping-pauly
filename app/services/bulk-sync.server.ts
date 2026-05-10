import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { PaulyVariant, ScrapedProduct } from "./scraper.server";
import prisma from "~/db.server";

interface ShopifyAdmin {
  graphql: (query: string, options?: any) => Promise<Response>;
}

interface BulkOperationResult {
  id: string;
  status: string;
  url?: string;
}

const BULK_OP_POLL_INTERVAL_MS = 5000;
const BULK_OP_MAX_POLL_ATTEMPTS = 120;

const METAFIELD_NAMESPACE = "custom";
const METAFIELD_KEY = "pauly_ref";
const METAFIELD_TYPE = "single_line_text_field";

const PRICING_METAFIELD_NAMESPACE = "custom";
const PRECIO_BASE_KEY = "cambio_precio_base";
const PRECIO_INCREMENTO_KEY = "cambio_precio_incremento";
const NUMBER_DECIMAL_TYPE = "number_decimal";
const INITIAL_PRECIO_INCREMENTO_VALUE = "1.00";

const PRICE_BASE_FACTOR: number = (() => {
  const raw = process.env.PAULY_PRICE_BASE_FACTOR;
  if (raw === undefined || raw === "") return 1;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    console.warn(
      'PAULY_PRICE_BASE_FACTOR="' +
        raw +
        '" is not a valid number — falling back to 1.0',
    );
    return 1;
  }
  return parsed;
})();

const metafieldDefinitionEnsured = new Map<string, boolean>();

type PricingMetafield = {
  namespace: string;
  key: string;
  value: string;
  type: string;
};

function roundTo2Decimals(value: number): number {
  return Number(value.toFixed(2));
}

function variantBasePriceAtTwoDecimals(variant: PaulyVariant): number {
  return roundTo2Decimals(parseFloat(variant.price) || 0);
}

function allVariantsShareBasePriceAtTwoDecimals(
  variants: PaulyVariant[],
): boolean {
  if (variants.length === 0) return false;
  const first = variantBasePriceAtTwoDecimals(variants[0]);
  for (let i = 1; i < variants.length; i++) {
    if (variantBasePriceAtTwoDecimals(variants[i]) !== first) return false;
  }
  return true;
}

export function buildPricingMetafields(
  product: ScrapedProduct,
  options: { includeIncremento: boolean },
): PricingMetafield[] | null {
  if (!allVariantsShareBasePriceAtTwoDecimals(product.variants)) {
    console.warn(
      `Skipping pricing metafields: variants have different base prices (handle="${product.handle}", ref="${product.ref}")`,
    );
    return null;
  }

  const basePriceNumeric = variantBasePriceAtTwoDecimals(product.variants[0]);
  const precioBase = roundTo2Decimals(basePriceNumeric * PRICE_BASE_FACTOR);

  const metafields: PricingMetafield[] = [
    {
      namespace: PRICING_METAFIELD_NAMESPACE,
      key: PRECIO_BASE_KEY,
      value: precioBase.toFixed(2),
      type: NUMBER_DECIMAL_TYPE,
    },
  ];

  if (options.includeIncremento) {
    metafields.push({
      namespace: PRICING_METAFIELD_NAMESPACE,
      key: PRECIO_INCREMENTO_KEY,
      value: INITIAL_PRECIO_INCREMENTO_VALUE,
      type: NUMBER_DECIMAL_TYPE,
    });
  }

  return metafields;
}

type SyncOperationStatus = "running" | "completed" | "partial" | "failed";

export async function logSyncOperation(
  type: string,
  bulkOpId: string | null,
  status: SyncOperationStatus,
  processed: number,
  errors: number,
  errorMessages?: string[],
): Promise<number> {
  try {
    const bulkSuffix = bulkOpId ? ` bulk ${bulkOpId}` : "";
    const errorSuffix =
      errorMessages && errorMessages.length > 0
        ? ` — ${errorMessages.slice(0, 3).join("; ")}`
        : "";
    const message = `${type}${bulkSuffix}${errorSuffix}`;

    const row = await prisma.syncLog.create({
      data: {
        status,
        message,
        processed,
        errors,
      },
    });

    return row.id;
  } catch (error) {
    console.error("logSyncOperation failed:", error);
    return -1;
  }
}

export async function ensureMetafieldDefinition(
  admin: ShopifyAdmin,
  shopDomain: string,
): Promise<void> {
  if (!shopDomain) {
    throw new Error("shopDomain is required to ensure metafield definition");
  }

  if (metafieldDefinitionEnsured.get(shopDomain)) {
    return;
  }

  const lookupQuery = `#graphql
    query getDefinition($namespace: String!, $key: String!, $ownerType: MetafieldOwnerType!) {
      metafieldDefinitions(first: 1, namespace: $namespace, key: $key, ownerType: $ownerType) {
        edges {
          node {
            id
            name
            type { name }
            capabilities {
              adminFilterable {
                enabled
              }
            }
          }
        }
      }
    }
  `;

  const lookupResponse = await admin.graphql(lookupQuery, {
    variables: {
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      ownerType: "PRODUCT",
    },
  });
  const lookupData = await lookupResponse.json();
  const existing =
    lookupData.data?.metafieldDefinitions?.edges?.[0]?.node ?? null;

  if (!existing) {
    const createMutation = `#graphql
      mutation createDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            id
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const createResponse = await admin.graphql(createMutation, {
      variables: {
        definition: {
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          name: "Pauly Ref",
          description:
            "Shopify product id from paulylingerie.com used as stable identifier for scrapping-pauly multi-tenant safety.",
          type: METAFIELD_TYPE,
          ownerType: "PRODUCT",
          capabilities: {
            adminFilterable: { enabled: true },
          },
        },
      },
    });
    const createData = await createResponse.json();
    const userErrors =
      createData.data?.metafieldDefinitionCreate?.userErrors ?? [];

    if (userErrors.length > 0) {
      const message = userErrors
        .map((e: any) => `${e.field?.join(".") ?? ""}: ${e.message}`)
        .join("; ");
      throw new Error(`metafieldDefinitionCreate failed: ${message}`);
    }

    console.log(
      `Metafield definition custom.pauly_ref created for ${shopDomain}`,
    );
  } else {
    const adminFilterable = existing.capabilities?.adminFilterable?.enabled;
    if (!adminFilterable) {
      const updateMutation = `#graphql
        mutation updateDefinition($definition: MetafieldDefinitionUpdateInput!) {
          metafieldDefinitionUpdate(definition: $definition) {
            updatedDefinition {
              id
            }
            userErrors {
              field
              message
              code
            }
          }
        }
      `;

      const updateResponse = await admin.graphql(updateMutation, {
        variables: {
          definition: {
            id: existing.id,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            ownerType: "PRODUCT",
            capabilities: {
              adminFilterable: { enabled: true },
            },
          },
        },
      });
      const updateData = await updateResponse.json();
      const userErrors =
        updateData.data?.metafieldDefinitionUpdate?.userErrors ?? [];

      if (userErrors.length > 0) {
        const message = userErrors
          .map((e: any) => `${e.field?.join(".") ?? ""}: ${e.message}`)
          .join("; ");
        throw new Error(`metafieldDefinitionUpdate failed: ${message}`);
      }

      console.log(
        `Metafield definition custom.pauly_ref adminFilterable enabled for ${shopDomain}`,
      );
    }
  }

  metafieldDefinitionEnsured.set(shopDomain, true);
}

function normalizeOption(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function variantOptionKey(
  o1: string | null | undefined,
  o2: string | null | undefined,
  o3: string | null | undefined,
): string {
  return `${normalizeOption(o1)}|${normalizeOption(o2)}|${normalizeOption(o3)}`;
}

async function waitForBulkOperationCompletion(
  admin: ShopifyAdmin,
  operationId: string,
): Promise<BulkOperationResult> {
  for (let attempt = 0; attempt < BULK_OP_MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, BULK_OP_POLL_INTERVAL_MS));

    const status = await checkBulkOperationStatus(admin, operationId);
    if (!status) continue;

    if (
      status.status === "COMPLETED" ||
      status.status === "FAILED" ||
      status.status === "CANCELED" ||
      status.status === "EXPIRED"
    ) {
      return status;
    }
  }

  throw new Error(`Bulk operation ${operationId} timed out after polling`);
}

async function waitForCurrentBulkOperation(
  admin: ShopifyAdmin,
): Promise<void> {
  for (let attempt = 0; attempt < BULK_OP_MAX_POLL_ATTEMPTS; attempt++) {
    const current = await checkBulkOperationStatus(admin);

    if (
      !current ||
      (current.status !== "RUNNING" && current.status !== "CREATED")
    ) {
      return;
    }

    console.log(
      `Waiting for in-flight bulk operation ${current.id} (${current.status})...`,
    );
    await new Promise((resolve) => setTimeout(resolve, BULK_OP_POLL_INTERVAL_MS));
  }

  throw new Error("Timed out waiting for current bulk operation slot");
}

export async function bulkSyncPaulyToShopify(
  admin: ShopifyAdmin,
  products: ScrapedProduct[],
  shopDomain: string,
): Promise<{
  createJobId?: string;
  updateJobId?: string;
  existingOperation?: BulkOperationResult;
  logIds: number[];
}> {
  await ensureMetafieldDefinition(admin, shopDomain);

  const currentOperation = await checkBulkOperationStatus(admin);

  if (
    currentOperation &&
    (currentOperation.status === "RUNNING" ||
      currentOperation.status === "CREATED")
  ) {
    return { existingOperation: currentOperation, logIds: [] };
  }

  const logIds: number[] = [];

  const { toCreate, toUpdate, toArchive } = await categorizeProducts(
    admin,
    products,
  );

  console.log(
    `Categorization: ${toCreate.length} toCreate, ${toUpdate.length} toUpdate, ${toArchive.length} toArchive`,
  );

  const jobs: {
    createJobId?: string;
    updateJobId?: string;
    logIds: number[];
  } = { logIds };

  if (toCreate.length > 0) {
    jobs.createJobId = await createBulkProductOperation(
      admin,
      toCreate,
      shopDomain,
      logIds,
    );

    const createFinalStatus = await waitForBulkOperationCompletion(
      admin,
      jobs.createJobId,
    );
    if (createFinalStatus.status !== "COMPLETED") {
      throw new Error(
        `Create bulk operation ${jobs.createJobId} ended with status: ${createFinalStatus.status}`,
      );
    }
  }

  if (toUpdate.length > 0) {
    jobs.updateJobId = await createBulkInventoryUpdateOperation(
      admin,
      toUpdate,
      shopDomain,
      logIds,
    );
  }

  if (toArchive.length > 0) {
    await archiveMissingProducts(admin, toArchive, logIds);
  }

  return jobs;
}

export async function fetchAllShopifyProducts(
  admin: ShopifyAdmin,
): Promise<Map<string, any>> {
  const productMap = new Map<string, any>();
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const query = `#graphql
      query getAllProducts($cursor: String) {
        products(first: 250, after: $cursor, query: "metafields.custom.pauly_ref:*") {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              handle
              status
              paulyRef: metafield(namespace: "custom", key: "pauly_ref") {
                value
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    sku
                    inventoryQuantity
                    selectedOptions {
                      name
                      value
                    }
                    inventoryItem {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await admin.graphql(query, {
      variables: { cursor },
    });

    const data = await response.json();

    if (data.data?.products?.edges) {
      for (const edge of data.data.products.edges) {
        const product = edge.node;
        const paulyRef: string | undefined = product.paulyRef?.value;
        if (paulyRef && !productMap.has(paulyRef)) {
          productMap.set(paulyRef, product);
        }
      }

      hasNextPage = data.data.products.pageInfo.hasNextPage;
      cursor = data.data.products.pageInfo.endCursor;
    } else {
      hasNextPage = false;
    }

    if (hasNextPage) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return productMap;
}

async function categorizeProducts(
  admin: ShopifyAdmin,
  scrapedProducts: ScrapedProduct[],
): Promise<{
  toCreate: ScrapedProduct[];
  toUpdate: Array<{ product: ScrapedProduct; shopifyData: any }>;
  toArchive: Array<{ id: string; title: string }>;
}> {
  const toCreate: ScrapedProduct[] = [];
  const toUpdate: Array<{ product: ScrapedProduct; shopifyData: any }> = [];
  const toArchive: Array<{ id: string; title: string }> = [];

  const existingProducts = await fetchAllShopifyProducts(admin);

  const scrapedRefs = new Set<string>();
  for (const product of scrapedProducts) {
    if (product.ref) {
      scrapedRefs.add(product.ref);
    }
  }

  for (const product of scrapedProducts) {
    const existing = product.ref ? existingProducts.get(product.ref) : undefined;
    if (existing) {
      toUpdate.push({ product, shopifyData: existing });
    } else {
      toCreate.push(product);
    }
  }

  for (const [ref, shopifyProduct] of existingProducts) {
    if (!scrapedRefs.has(ref)) {
      toArchive.push({ id: shopifyProduct.id, title: shopifyProduct.title });
    }
  }

  return { toCreate, toUpdate, toArchive };
}

async function createBulkProductOperation(
  admin: ShopifyAdmin,
  products: ScrapedProduct[],
  shopDomain: string,
  logIds: number[],
): Promise<string> {
  const startLogId = await logSyncOperation("create", null, "running", 0, 0);
  if (startLogId !== -1) logIds.push(startLogId);

  let bulkOpId = "";
  try {
    const locationId = await getLocationId(admin, shopDomain);

    const jsonlLines = products.map((product) => {
      const hasRealOptions = product.options && product.options.length > 0;

      let productOptions: Array<{ name: string; values: Array<{ name: string }> }>;
      let resolvedOptionNames: string[];

      if (hasRealOptions) {
        productOptions = product.options.map((opt) => ({
          name: opt.name,
          values: opt.values.map((v) => ({ name: v })),
        }));
        resolvedOptionNames = product.options.map((opt) => opt.name);
      } else {
        const optionNamesSet = new Set<string>();
        for (const variant of product.variants) {
          if (variant.option1) optionNamesSet.add("Option1");
          if (variant.option2) optionNamesSet.add("Option2");
          if (variant.option3) optionNamesSet.add("Option3");
        }

        const fallbackNames = Array.from(optionNamesSet);
        if (fallbackNames.length === 0) {
          fallbackNames.push("Title");
        }

        productOptions = fallbackNames.map((name) => {
          const valuesSet = new Set<string>();
          for (const variant of product.variants) {
            if (name === "Option1" && variant.option1) valuesSet.add(variant.option1);
            if (name === "Option2" && variant.option2) valuesSet.add(variant.option2);
            if (name === "Option3" && variant.option3) valuesSet.add(variant.option3);
            if (name === "Title") valuesSet.add(variant.title || "Default Title");
          }
          return {
            name,
            values: Array.from(valuesSet).map((v) => ({ name: v })),
          };
        });
        resolvedOptionNames = fallbackNames;
      }

      const variants = product.variants.map((variant) => {
        const variantOption = variant.option1 || variant.option2 || variant.option3 || "DEFAULT";
        const sku = `PAULY-${product.ref}-${variantOption}`;

        const optionValues: Array<{ optionName: string; name: string }> = [];

        if (hasRealOptions) {
          if (product.options[0] && variant.option1) {
            optionValues.push({ optionName: product.options[0].name, name: variant.option1 });
          }
          if (product.options[1] && variant.option2) {
            optionValues.push({ optionName: product.options[1].name, name: variant.option2 });
          }
          if (product.options[2] && variant.option3) {
            optionValues.push({ optionName: product.options[2].name, name: variant.option3 });
          }
        } else {
          if (resolvedOptionNames.includes("Option1") && variant.option1) {
            optionValues.push({ optionName: "Option1", name: variant.option1 });
          }
          if (resolvedOptionNames.includes("Option2") && variant.option2) {
            optionValues.push({ optionName: "Option2", name: variant.option2 });
          }
          if (resolvedOptionNames.includes("Option3") && variant.option3) {
            optionValues.push({ optionName: "Option3", name: variant.option3 });
          }
          if (resolvedOptionNames.includes("Title")) {
            optionValues.push({
              optionName: "Title",
              name: variant.title || "Default Title",
            });
          }
        }

        return {
          optionValues,
          sku,
          inventoryItem: {
            tracked: true,
          },
          inventoryQuantities: [
            {
              locationId,
              name: "available",
              quantity:
                variant.inventoryQuantity !== null
                  ? Math.max(0, variant.inventoryQuantity)
                  : (variant.available ? 1 : 0),
            },
          ],
          ...(variant.inventoryPolicy !== null
            ? { inventoryPolicy: variant.inventoryPolicy }
            : {}),
        };
      });

      const files = product.images.map((src) => ({
        originalSource: src,
        alt: product.title,
        contentType: "IMAGE",
      }));

      const metafields: PricingMetafield[] = [];
      if (product.ref) {
        metafields.push({
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          value: product.ref,
          type: METAFIELD_TYPE,
        });
      }
      const pricingMetafields = buildPricingMetafields(product, {
        includeIncremento: true,
      });
      if (pricingMetafields) {
        metafields.push(...pricingMetafields);
      }

      return JSON.stringify({
        input: {
          title: product.title,
          descriptionHtml: product.bodyHtml,
          handle: product.handle,
          vendor: "Pauly",
          status: "DRAFT",
          tags: product.tags,
          productType: product.productType,
          productOptions,
          variants,
          ...(files.length > 0 && { files }),
          ...(metafields.length > 0 && { metafields }),
        },
      });
    });

    const jsonlContent = jsonlLines.join("\n");
    const tempFile = join(tmpdir(), `bulk-create-${Date.now()}.jsonl`);

    await writeFile(tempFile, jsonlContent, "utf-8");

    try {
      const uploadUrl = await stageUpload(admin);
      await uploadFile(uploadUrl, tempFile);

      bulkOpId = await runBulkMutation(
        admin,
        uploadUrl.key,
        `mutation productSet($input: ProductSetInput!) {
          productSet(input: $input) {
            product {
              id
              title
              status
              variants(first: 50) {
                edges {
                  node {
                    id
                    sku
                    inventoryQuantity
                  }
                }
              }
            }
            userErrors {
              field
              message
              code
            }
          }
        }`,
      );

      const finalStatus = await waitForBulkOperationCompletion(admin, bulkOpId);
      if (finalStatus.status !== "COMPLETED") {
        const failLogId = await logSyncOperation(
          "create",
          bulkOpId,
          "failed",
          0,
          products.length,
          [`bulk op ended with status ${finalStatus.status}`],
        );
        if (failLogId !== -1) logIds.push(failLogId);
        throw new Error(
          `Create bulk operation ${bulkOpId} ended with status: ${finalStatus.status}`,
        );
      }

      const endLogId = await logSyncOperation(
        "create",
        bulkOpId,
        "completed",
        products.length,
        0,
      );
      if (endLogId !== -1) logIds.push(endLogId);

      return bulkOpId;
    } finally {
      await unlink(tempFile).catch(() => {});
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (!bulkOpId) {
      const failLogId = await logSyncOperation(
        "create",
        null,
        "failed",
        0,
        products.length,
        [errMsg],
      );
      if (failLogId !== -1) logIds.push(failLogId);
    }
    throw error;
  }
}

async function createBulkInventoryUpdateOperation(
  admin: ShopifyAdmin,
  updates: Array<{ product: ScrapedProduct; shopifyData: any }>,
  shopDomain: string,
  logIds: number[],
): Promise<string> {
  const startLogId = await logSyncOperation("update", null, "running", 0, 0);
  if (startLogId !== -1) logIds.push(startLogId);

  const locationId = await getLocationId(admin, shopDomain);

  const productsWithOrphans: Array<{
    productId: string;
    variantIds: string[];
  }> = [];
  let reactivatedCount = 0;

  for (const { product, shopifyData } of updates) {
    const scrapedKeys = new Set<string>(
      product.variants.map((v) =>
        variantOptionKey(v.option1, v.option2, v.option3),
      ),
    );

    const orphanVariantIds: string[] = [];
    const shopifyVariantEdges = shopifyData.variants?.edges ?? [];

    for (const edge of shopifyVariantEdges) {
      const shopifyVariant = edge.node;
      const selected = shopifyVariant.selectedOptions ?? [];
      const shopifyOption1 = selected[0]?.value ?? null;
      const shopifyOption2 = selected[1]?.value ?? null;
      const shopifyOption3 = selected[2]?.value ?? null;

      const shopifyKey = variantOptionKey(
        shopifyOption1,
        shopifyOption2,
        shopifyOption3,
      );

      if (!scrapedKeys.has(shopifyKey)) {
        orphanVariantIds.push(shopifyVariant.id);
        console.log(
          `Orphan variant queued for deletion: ${shopifyVariant.id} (product=${shopifyData.id})`,
        );
      }
    }

    if (orphanVariantIds.length > 0) {
      productsWithOrphans.push({
        productId: shopifyData.id,
        variantIds: orphanVariantIds,
      });
    }
  }

  const jsonlLines = updates.map(({ product, shopifyData }) => {
    const hasRealOptions = product.options && product.options.length > 0;

    let productOptions: Array<{ name: string; values: Array<{ name: string }> }>;
    let resolvedOptionNames: string[];

    if (hasRealOptions) {
      productOptions = product.options.map((opt) => ({
        name: opt.name,
        values: opt.values.map((v) => ({ name: v })),
      }));
      resolvedOptionNames = product.options.map((opt) => opt.name);
    } else {
      const optionNamesSet = new Set<string>();
      for (const variant of product.variants) {
        if (variant.option1) optionNamesSet.add("Option1");
        if (variant.option2) optionNamesSet.add("Option2");
        if (variant.option3) optionNamesSet.add("Option3");
      }

      const fallbackNames = Array.from(optionNamesSet);
      if (fallbackNames.length === 0) {
        fallbackNames.push("Title");
      }

      productOptions = fallbackNames.map((name) => {
        const valuesSet = new Set<string>();
        for (const variant of product.variants) {
          if (name === "Option1" && variant.option1) valuesSet.add(variant.option1);
          if (name === "Option2" && variant.option2) valuesSet.add(variant.option2);
          if (name === "Option3" && variant.option3) valuesSet.add(variant.option3);
          if (name === "Title") valuesSet.add(variant.title || "Default Title");
        }
        return {
          name,
          values: Array.from(valuesSet).map((v) => ({ name: v })),
        };
      });
      resolvedOptionNames = fallbackNames;
    }

    const variants = product.variants.map((variant) => {
      const variantOption = variant.option1 || variant.option2 || variant.option3 || "DEFAULT";
      const sku = `PAULY-${product.ref}-${variantOption}`;

      const optionValues: Array<{ optionName: string; name: string }> = [];

      if (hasRealOptions) {
        if (product.options[0] && variant.option1) {
          optionValues.push({ optionName: product.options[0].name, name: variant.option1 });
        }
        if (product.options[1] && variant.option2) {
          optionValues.push({ optionName: product.options[1].name, name: variant.option2 });
        }
        if (product.options[2] && variant.option3) {
          optionValues.push({ optionName: product.options[2].name, name: variant.option3 });
        }
      } else {
        if (resolvedOptionNames.includes("Option1") && variant.option1) {
          optionValues.push({ optionName: "Option1", name: variant.option1 });
        }
        if (resolvedOptionNames.includes("Option2") && variant.option2) {
          optionValues.push({ optionName: "Option2", name: variant.option2 });
        }
        if (resolvedOptionNames.includes("Option3") && variant.option3) {
          optionValues.push({ optionName: "Option3", name: variant.option3 });
        }
        if (resolvedOptionNames.includes("Title")) {
          optionValues.push({
            optionName: "Title",
            name: variant.title || "Default Title",
          });
        }
      }

      return {
        optionValues,
        sku,
        inventoryItem: {
          tracked: true,
        },
        inventoryQuantities: [
          {
            locationId,
            name: "available",
            quantity:
              variant.inventoryQuantity !== null
                ? Math.max(0, variant.inventoryQuantity)
                : (variant.available ? 1 : 0),
          },
        ],
        ...(variant.inventoryPolicy !== null
          ? { inventoryPolicy: variant.inventoryPolicy }
          : {}),
      };
    });

    const files = product.images.map((src) => ({
      originalSource: src,
      alt: product.title,
      contentType: "IMAGE",
    }));

    const metafields: PricingMetafield[] = [];
    if (product.ref) {
      metafields.push({
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        value: product.ref,
        type: METAFIELD_TYPE,
      });
    }
    const pricingMetafields = buildPricingMetafields(product, {
      includeIncremento: false,
    });
    if (pricingMetafields) {
      metafields.push(...pricingMetafields);
    }

    const shouldReactivate = shopifyData.status === "ARCHIVED";
    if (shouldReactivate) {
      reactivatedCount++;
      console.log(
        `Reactivating product ${shopifyData.id}: ${product.title}`,
      );
    }

    return JSON.stringify({
      input: {
        id: shopifyData.id,
        productOptions,
        variants,
        ...(files.length > 0 && { files }),
        ...(metafields.length > 0 && { metafields }),
        ...(shouldReactivate ? { status: "ACTIVE" } : {}),
      },
    });
  });

  if (jsonlLines.length === 0) {
    const endLogId = await logSyncOperation(
      "update",
      null,
      "completed",
      0,
      0,
    );
    if (endLogId !== -1) logIds.push(endLogId);
    return "";
  }

  const jsonlContent = jsonlLines.join("\n");
  const tempFile = join(tmpdir(), `bulk-update-${Date.now()}.jsonl`);

  await writeFile(tempFile, jsonlContent, "utf-8");

  let bulkOpId = "";
  try {
    await waitForCurrentBulkOperation(admin);

    const uploadUrl = await stageUpload(admin);
    await uploadFile(uploadUrl, tempFile);

    bulkOpId = await runBulkMutation(
      admin,
      uploadUrl.key,
      `mutation productSet($input: ProductSetInput!) {
        productSet(input: $input) {
          product {
            id
            title
            status
            variants(first: 50) {
              edges {
                node {
                  id
                  sku
                  inventoryQuantity
                }
              }
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }`,
    );

    const finalStatus = await waitForBulkOperationCompletion(admin, bulkOpId);
    if (finalStatus.status !== "COMPLETED") {
      const failLogId = await logSyncOperation(
        "update",
        bulkOpId,
        "failed",
        0,
        updates.length,
        [`bulk op ended with status ${finalStatus.status}`],
      );
      if (failLogId !== -1) logIds.push(failLogId);
      throw new Error(
        `Update bulk operation ${bulkOpId} ended with status: ${finalStatus.status}`,
      );
    }

    const endLogId = await logSyncOperation(
      "update",
      bulkOpId,
      "completed",
      updates.length,
      0,
    );
    if (endLogId !== -1) logIds.push(endLogId);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (!bulkOpId) {
      const failLogId = await logSyncOperation(
        "update",
        null,
        "failed",
        0,
        updates.length,
        [errMsg],
      );
      if (failLogId !== -1) logIds.push(failLogId);
    }
    throw error;
  } finally {
    await unlink(tempFile).catch(() => {});
  }

  if (reactivatedCount > 0) {
    const reactivateLogId = await logSyncOperation(
      "reactivate",
      bulkOpId,
      "completed",
      reactivatedCount,
      0,
    );
    if (reactivateLogId !== -1) logIds.push(reactivateLogId);
  }

  await deleteOrphanVariantsBulk(admin, productsWithOrphans, logIds);

  return bulkOpId;
}

async function deleteOrphanVariantsBulk(
  admin: ShopifyAdmin,
  productsWithOrphans: Array<{ productId: string; variantIds: string[] }>,
  logIds: number[],
): Promise<void> {
  if (productsWithOrphans.length === 0) return;

  console.log(
    `Deleting orphan variants for ${productsWithOrphans.length} products via bulk operation...`,
  );

  const startLogId = await logSyncOperation(
    "orphan-deletion",
    null,
    "running",
    0,
    0,
  );
  if (startLogId !== -1) logIds.push(startLogId);

  const jsonlLines = productsWithOrphans.map((entry) =>
    JSON.stringify({
      productId: entry.productId,
      variantsIds: entry.variantIds,
    }),
  );

  const jsonlContent = jsonlLines.join("\n");
  const tempFile = join(tmpdir(), `bulk-orphan-delete-${Date.now()}.jsonl`);

  await writeFile(tempFile, jsonlContent, "utf-8");

  try {
    await waitForCurrentBulkOperation(admin);

    const uploadUrl = await stageUpload(admin);
    await uploadFile(uploadUrl, tempFile);

    const bulkOpId = await runBulkMutation(
      admin,
      uploadUrl.key,
      `mutation productVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
        productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
          product { id }
          userErrors { field message }
        }
      }`,
    );

    const finalStatus = await waitForBulkOperationCompletion(admin, bulkOpId);

    if (finalStatus.status !== "COMPLETED") {
      console.error(
        `Orphan variant deletion bulk op ${bulkOpId} ended with status ${finalStatus.status}`,
      );
      const failLogId = await logSyncOperation(
        "orphan-deletion",
        bulkOpId,
        "failed",
        0,
        productsWithOrphans.length,
        [`bulk op ended with status ${finalStatus.status}`],
      );
      if (failLogId !== -1) logIds.push(failLogId);
      return;
    }

    console.log("Orphan variant deletion bulk completed");
    const endLogId = await logSyncOperation(
      "orphan-deletion",
      bulkOpId,
      "completed",
      productsWithOrphans.length,
      0,
    );
    if (endLogId !== -1) logIds.push(endLogId);
  } catch (error) {
    console.error("Orphan variant deletion bulk operation failed:", error);
    const errMsg = error instanceof Error ? error.message : String(error);
    const failLogId = await logSyncOperation(
      "orphan-deletion",
      null,
      "failed",
      0,
      productsWithOrphans.length,
      [errMsg],
    );
    if (failLogId !== -1) logIds.push(failLogId);
  } finally {
    await unlink(tempFile).catch(() => {});
  }
}

async function archiveMissingProducts(
  admin: ShopifyAdmin,
  toArchive: Array<{ id: string; title: string }>,
  logIds: number[],
): Promise<void> {
  if (toArchive.length === 0) return;

  console.log(
    `Archiving ${toArchive.length} missing products via bulk operation...`,
  );

  const startLogId = await logSyncOperation("archive", null, "running", 0, 0);
  if (startLogId !== -1) logIds.push(startLogId);

  const jsonlLines = toArchive.map(({ id }) =>
    JSON.stringify({ input: { id, status: "ARCHIVED" } }),
  );

  const jsonlContent = jsonlLines.join("\n");
  const tempFile = join(tmpdir(), `bulk-archive-${Date.now()}.jsonl`);

  await writeFile(tempFile, jsonlContent, "utf-8");

  try {
    await waitForCurrentBulkOperation(admin);

    const uploadUrl = await stageUpload(admin);
    await uploadFile(uploadUrl, tempFile);

    const bulkOpId = await runBulkMutation(
      admin,
      uploadUrl.key,
      `mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id status }
          userErrors { field message }
        }
      }`,
    );

    const finalStatus = await waitForBulkOperationCompletion(admin, bulkOpId);

    if (finalStatus.status !== "COMPLETED") {
      console.error(
        `Archive bulk op ${bulkOpId} ended with status ${finalStatus.status}`,
      );
      const failLogId = await logSyncOperation(
        "archive",
        bulkOpId,
        "failed",
        0,
        toArchive.length,
        [`bulk op ended with status ${finalStatus.status}`],
      );
      if (failLogId !== -1) logIds.push(failLogId);
      return;
    }

    console.log(
      `Archive bulk operation completed for ${toArchive.length} products`,
    );
    const endLogId = await logSyncOperation(
      "archive",
      bulkOpId,
      "completed",
      toArchive.length,
      0,
    );
    if (endLogId !== -1) logIds.push(endLogId);
  } catch (error) {
    console.error("Archive bulk operation failed:", error);
    const errMsg = error instanceof Error ? error.message : String(error);
    const failLogId = await logSyncOperation(
      "archive",
      null,
      "failed",
      0,
      toArchive.length,
      [errMsg],
    );
    if (failLogId !== -1) logIds.push(failLogId);
  } finally {
    await unlink(tempFile).catch(() => {});
  }
}

export interface MetafieldsSetBulkEntry {
  ownerId: string;
  namespace: string;
  key: string;
  value: string;
  type: string;
}

export interface MetafieldBulkOperationResult {
  id: string;
  status: string;
  logId: number;
}

export async function runMetafieldsSetBulkOperation(
  admin: ShopifyAdmin,
  entries: MetafieldsSetBulkEntry[],
  syncLogType: string,
): Promise<MetafieldBulkOperationResult> {
  if (entries.length === 0) {
    const emptyLogId = await logSyncOperation(
      syncLogType,
      null,
      "completed",
      0,
      0,
    );
    return { id: "", status: "EMPTY", logId: emptyLogId };
  }

  const jsonlLines = entries.map((entry) =>
    JSON.stringify({
      metafields: [
        {
          ownerId: entry.ownerId,
          namespace: entry.namespace,
          key: entry.key,
          value: entry.value,
          type: entry.type,
        },
      ],
    }),
  );

  const jsonlContent = jsonlLines.join("\n");
  const tempFile = join(
    tmpdir(),
    `bulk-metafields-set-${syncLogType}-${Date.now()}.jsonl`,
  );

  await writeFile(tempFile, jsonlContent, "utf-8");

  let bulkOpId = "";
  try {
    await waitForCurrentBulkOperation(admin);

    const uploadUrl = await stageUpload(admin);
    await uploadFile(uploadUrl, tempFile);

    bulkOpId = await runBulkMutation(
      admin,
      uploadUrl.key,
      `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key namespace }
          userErrors { field message code }
        }
      }`,
    );

    const finalStatus = await waitForBulkOperationCompletion(admin, bulkOpId);

    if (finalStatus.status !== "COMPLETED") {
      const failLogId = await logSyncOperation(
        syncLogType,
        bulkOpId,
        "failed",
        0,
        entries.length,
        [`bulk op ended with status ${finalStatus.status}`],
      );
      return { id: bulkOpId, status: finalStatus.status, logId: failLogId };
    }

    const endLogId = await logSyncOperation(
      syncLogType,
      bulkOpId,
      "completed",
      entries.length,
      0,
    );

    return { id: bulkOpId, status: finalStatus.status, logId: endLogId };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await logSyncOperation(
      syncLogType,
      bulkOpId || null,
      "failed",
      0,
      entries.length,
      [errMsg],
    );
    console.error(`${syncLogType} bulk op failed: ${errMsg}`);
    throw error;
  } finally {
    await unlink(tempFile).catch(() => {});
  }
}

const locationCache = new Map<string, string>();

async function getLocationId(admin: ShopifyAdmin, shopDomain: string): Promise<string> {
  const cacheKey = shopDomain;
  const cached = locationCache.get(cacheKey);
  if (cached) return cached;

  const query = `#graphql
    query {
      locations(first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query);
  const data = await response.json();

  const locationId = data.data?.locations?.edges?.[0]?.node?.id;

  if (!locationId) {
    throw new Error("No location found");
  }

  locationCache.set(cacheKey, locationId);

  return locationId;
}

async function stageUpload(admin: ShopifyAdmin): Promise<{
  url: string;
  key: string;
  parameters: Array<{ name: string; value: string }>;
}> {
  const mutation = `#graphql
    mutation {
      stagedUploadsCreate(input:[{
        resource: BULK_MUTATION_VARIABLES,
        filename: "bulk_op_vars",
        mimeType: "text/jsonl",
        httpMethod: POST
      }]){
        userErrors{
          field
          message
        }
        stagedTargets{
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
      }
    }
  `;

  const response = await admin.graphql(mutation);
  const data = await response.json();

  if (data.data?.stagedUploadsCreate?.userErrors?.length > 0) {
    throw new Error(data.data.stagedUploadsCreate.userErrors[0].message);
  }

  const target = data.data?.stagedUploadsCreate?.stagedTargets?.[0];

  if (!target) {
    throw new Error("Failed to create staged upload");
  }

  const keyParam = target.parameters.find((p: any) => p.name === "key");

  if (!keyParam) {
    throw new Error("No key parameter found in staged upload");
  }

  return {
    url: target.url,
    key: keyParam.value,
    parameters: target.parameters,
  };
}

async function uploadFile(
  uploadData: {
    url: string;
    parameters: Array<{ name: string; value: string }>;
  },
  filePath: string,
): Promise<void> {
  const fs = await import("fs");
  const fileStream = fs.createReadStream(filePath);

  const formDataModule = await import("form-data");
  const FormData = formDataModule.default;
  const form = new FormData();

  for (const param of uploadData.parameters) {
    form.append(param.name, param.value);
  }

  form.append("file", fileStream, {
    filename: "bulk_op_vars.jsonl",
    contentType: "text/jsonl",
  });

  return new Promise((resolve, reject) => {
    form.submit(uploadData.url, (err, res) => {
      if (err) {
        reject(new Error(`Upload failed: ${err.message}`));
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        let errorText = "";
        res.on("data", (chunk) => {
          errorText += chunk.toString();
        });
        res.on("end", () => {
          reject(new Error(`Upload failed: ${res.statusCode} - ${errorText}`));
        });
      } else {
        res.resume();
        resolve();
      }
    });
  });
}

async function runBulkMutation(
  admin: ShopifyAdmin,
  stagedUploadPath: string,
  mutation: string,
): Promise<string> {
  const bulkMutation = `#graphql
    mutation {
      bulkOperationRunMutation(
        mutation: ${JSON.stringify(mutation)},
        stagedUploadPath: ${JSON.stringify(stagedUploadPath)}
      ) {
        bulkOperation {
          id
          url
          status
        }
        userErrors {
          message
          field
        }
      }
    }
  `;

  const response = await admin.graphql(bulkMutation);
  const data = await response.json();

  if (data.data?.bulkOperationRunMutation?.userErrors?.length > 0) {
    const error = data.data.bulkOperationRunMutation.userErrors[0].message;
    throw new Error(error);
  }

  return data.data?.bulkOperationRunMutation?.bulkOperation?.id;
}

export async function checkBulkOperationStatus(
  admin: ShopifyAdmin,
  operationId?: string,
): Promise<BulkOperationResult | null> {
  const query = operationId
    ? `#graphql
        query {
          node(id: "${operationId}") {
            ... on BulkOperation {
              id
              status
              errorCode
              objectCount
              url
              partialDataUrl
            }
          }
        }
      `
    : `#graphql
        query {
          currentBulkOperation(type: MUTATION) {
            id
            status
            errorCode
            createdAt
            completedAt
            objectCount
            fileSize
            url
            partialDataUrl
          }
        }
      `;

  const response = await admin.graphql(query);
  const data = await response.json();

  const operation = operationId
    ? data.data?.node
    : data.data?.currentBulkOperation;

  if (!operation) return null;

  return {
    id: operation.id,
    status: operation.status,
    url: operation.url || operation.partialDataUrl,
  };
}

export async function getBulkOperationDetails(
  admin: ShopifyAdmin,
  operationId: string,
): Promise<{
  id: string;
  status: string;
  objectCount?: number;
  errorCode?: string;
  url?: string;
} | null> {
  const query = `#graphql
    query {
      node(id: "${operationId}") {
        ... on BulkOperation {
          id
          status
          errorCode
          objectCount
          url
          partialDataUrl
        }
      }
    }
  `;

  const response = await admin.graphql(query);
  const data = await response.json();

  const operation = data.data?.node;

  if (!operation) return null;

  const objectCount = operation.objectCount
    ? parseInt(operation.objectCount.toString(), 10)
    : 0;

  return {
    id: operation.id,
    status: operation.status,
    objectCount,
    errorCode: operation.errorCode,
    url: operation.url || operation.partialDataUrl,
  };
}

export async function downloadBulkOperationResults(url: string): Promise<{
  totalLines: number;
  errors: Array<{ line: number; error: string; details: any }>;
  samples: any[];
}> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download results: ${response.statusText}`);
  }

  const text = await response.text();
  const lines = text.trim().split("\n");

  const errors: Array<{ line: number; error: string; details: any }> = [];
  const samples: any[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    try {
      const result = JSON.parse(lines[i]);

      if (samples.length < 5) {
        samples.push(result);
      }

      if (result.userErrors && result.userErrors.length > 0) {
        errors.push({
          line: i + 1,
          error: result.userErrors[0].message || "Unknown error",
          details: result,
        });
      }
    } catch (e) {
      errors.push({
        line: i + 1,
        error: `JSON parse error: ${e instanceof Error ? e.message : String(e)}`,
        details: { rawLine: lines[i] },
      });
    }
  }

  return {
    totalLines: lines.length,
    errors,
    samples,
  };
}

export async function updateSyncLogFromOperation(
  operationId: string,
  status: string,
  objectCount: number,
  errorCode?: string,
): Promise<void> {
  try {
    const runningLog = await prisma.syncLog.findFirst({
      where: {
        status: "running",
        message: {
          contains: operationId,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!runningLog) {
      return;
    }

    let finalStatus: string;
    if (status === "COMPLETED") {
      finalStatus = "success";
    } else if (status === "FAILED" || status === "CANCELED") {
      finalStatus = "error";
    } else {
      return;
    }

    await prisma.syncLog.update({
      where: { id: runningLog.id },
      data: {
        status: finalStatus,
        processed: objectCount,
        errors: errorCode ? 1 : 0,
        message: errorCode
          ? `${runningLog.message} - Error: ${errorCode}`
          : runningLog.message,
      },
    });
  } catch (error) {
    console.error("Error updating SyncLog:", error);
  }
}
