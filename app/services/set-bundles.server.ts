import type { ScrapedProduct } from "./scraper.server";
import { logSyncOperation } from "./bulk-sync.server";

interface ShopifyAdmin {
  graphql: (query: string, options?: any) => Promise<Response>;
}

/** The fields fetchAllShopifyProducts reads that matter to a bundle. */
interface StoreProduct {
  id: string;
  hasVariantsThatRequiresComponents?: boolean;
  options?: Array<{ id: string; name: string; values: string[] }>;
}

interface DesiredComponent {
  productId: string;
  optionId: string;
  optionName: string;
  values: string[];
}

interface CurrentComponent {
  quantity: number;
  componentProduct: { id: string };
  optionSelections: Array<{
    componentOption: { id: string };
    parentOption: { name: string } | null;
    values: Array<{ value: string; selectionStatus: string }>;
  }>;
}

const BUNDLE_OP_POLL_INTERVAL_MS = 1000;
const BUNDLE_OP_MAX_POLL_ATTEMPTS = 60;
const BUNDLE_LOOKUP_BATCH_SIZE = 25;

function desiredComponents(
  product: ScrapedProduct,
  existingProducts: Map<string, StoreProduct>,
): DesiredComponent[] | null {
  const desired: DesiredComponent[] = [];

  for (const component of product.components ?? []) {
    const piece = existingProducts.get(component.ref);
    const option = piece?.options?.length === 1 ? piece.options[0] : undefined;
    if (!piece || !option) return null;

    // A size the store has not received yet cannot be selected on the piece.
    const values = component.values.filter((v) => option.values.includes(v));
    if (values.length === 0) return null;

    desired.push({
      productId: piece.id,
      optionId: option.id,
      optionName: component.optionName,
      values,
    });
  }

  return desired.length >= 2 ? desired : null;
}

function sameComponents(
  current: CurrentComponent[] | undefined,
  desired: DesiredComponent[],
): boolean {
  if (!current || current.length !== desired.length) return false;

  return desired.every((d) => {
    const c = current.find((node) => node.componentProduct.id === d.productId);
    const selection = c?.optionSelections.length === 1 ? c.optionSelections[0] : undefined;
    if (!c || c.quantity !== 1 || !selection) return false;

    const selected = selection.values
      .filter((v) => v.selectionStatus === "SELECTED")
      .map((v) => v.value);
    return (
      selection.componentOption.id === d.optionId &&
      selection.parentOption?.name === d.optionName &&
      selected.length === d.values.length &&
      d.values.every((v) => selected.includes(v))
    );
  });
}

async function fetchBundleComponents(
  admin: ShopifyAdmin,
  productIds: string[],
): Promise<Map<string, CurrentComponent[]>> {
  const byProductId = new Map<string, CurrentComponent[]>();

  for (let i = 0; i < productIds.length; i += BUNDLE_LOOKUP_BATCH_SIZE) {
    const response = await admin.graphql(
      `#graphql
      query bundleComponents($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            bundleComponents(first: 10) {
              nodes {
                quantity
                componentProduct { id }
                optionSelections {
                  componentOption { id }
                  parentOption { name }
                  values { value selectionStatus }
                }
              }
            }
          }
        }
      }`,
      { variables: { ids: productIds.slice(i, i + BUNDLE_LOOKUP_BATCH_SIZE) } },
    );
    const data = await response.json();
    if (data.errors) throw new Error(`bundleComponents: ${JSON.stringify(data.errors)}`);

    for (const node of data.data?.nodes ?? []) {
      if (node?.id) byProductId.set(node.id, node.bundleComponents?.nodes ?? []);
    }
  }

  return byProductId;
}

/** Returns an error message, or null once Shopify has finished rebuilding the bundle. */
async function updateBundle(
  admin: ShopifyAdmin,
  productId: string,
  components: DesiredComponent[],
): Promise<string | null> {
  const response = await admin.graphql(
    `#graphql
    mutation productBundleUpdate($input: ProductBundleUpdateInput!) {
      productBundleUpdate(input: $input) {
        productBundleOperation { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          productId,
          components: components.map((c) => ({
            quantity: 1,
            productId: c.productId,
            optionSelections: [
              { componentOptionId: c.optionId, name: c.optionName, values: c.values },
            ],
          })),
        },
      },
    },
  );
  const data = await response.json();
  const payload = data.data?.productBundleUpdate;
  if (data.errors || payload?.userErrors?.length) {
    return JSON.stringify(data.errors ?? payload.userErrors);
  }

  const operationId = payload?.productBundleOperation?.id;
  if (!operationId) return "productBundleUpdate returned no operation";

  for (let attempt = 0; attempt < BUNDLE_OP_MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, BUNDLE_OP_POLL_INTERVAL_MS));

    const statusResponse = await admin.graphql(
      `#graphql
      query productOperation($id: ID!) {
        productOperation(id: $id) {
          status
          ... on ProductBundleOperation { userErrors { field message } }
        }
      }`,
      { variables: { id: operationId } },
    );
    const operation = (await statusResponse.json()).data?.productOperation;
    if (operation?.status === "COMPLETE") {
      return operation.userErrors?.length ? JSON.stringify(operation.userErrors) : null;
    }
  }

  return `bundle operation ${operationId} did not complete`;
}

/**
 * Turns the sets the scraper found into Shopify bundles of the pieces already in the
 * store, and returns the ids of the store products whose variants the bundle now owns.
 *
 * WHY: a bundle's variants are generated by Shopify from the pieces (one per combination
 * of sizes) and its stock is derived from theirs, so the regular productSet must stop
 * sending options, variants and inventory for those products — and must not delete the
 * generated variants as orphans. A product that is already a bundle stays protected even
 * when this run could not read its pieces.
 *
 * A set created in this same run is converted on the next one, once it has an id. A set
 * is only rebuilt when its pieces changed: repeating the update is harmless but slow.
 */
export async function syncSetBundles(
  admin: ShopifyAdmin,
  updates: Array<{ product: ScrapedProduct; shopifyData: StoreProduct }>,
  existingProducts: Map<string, StoreProduct>,
  logIds: number[],
): Promise<Set<string>> {
  const bundled = new Set<string>();
  for (const { shopifyData } of updates) {
    if (shopifyData.hasVariantsThatRequiresComponents) bundled.add(shopifyData.id);
  }

  const wanted: Array<{ handle: string; productId: string; components: DesiredComponent[] }> = [];
  const piecesMissing: string[] = [];
  for (const { product, shopifyData } of updates) {
    if (!product.components) continue;

    const components = desiredComponents(product, existingProducts);
    if (components) {
      wanted.push({ handle: product.handle, productId: shopifyData.id, components });
    } else {
      piecesMissing.push(product.handle);
    }
  }
  if (wanted.length === 0) return bundled;

  let rebuilt = 0;
  const errors: string[] = [];
  try {
    const current = await fetchBundleComponents(
      admin,
      wanted.map((w) => w.productId),
    );

    for (const w of wanted) {
      if (sameComponents(current.get(w.productId), w.components)) continue;

      const error = await updateBundle(admin, w.productId, w.components);
      if (error) {
        errors.push(`${w.handle}: ${error}`);
      } else {
        rebuilt++;
        bundled.add(w.productId);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  console.log(
    JSON.stringify({
      event: "set-bundles",
      sets: wanted.length,
      rebuilt,
      failed: errors.length,
      piecesMissing,
    }),
  );
  if (rebuilt > 0 || errors.length > 0) {
    const logId = await logSyncOperation(
      "set-bundles",
      null,
      errors.length > 0 ? "partial" : "completed",
      rebuilt,
      errors.length,
      errors,
    );
    if (logId !== -1) logIds.push(logId);
  }

  return bundled;
}
