/**
 * Picks the handle each new product is created under, so a taken handle stops failing the
 * create on every run.
 *
 * WHY: the supplier re-creates a product under a new id with the same name (Pitbull 6957 and
 * the archived 6775 are both JPS3266), and its handle is still held by the older product, so
 * productSet answered HANDLE_NOT_UNIQUE every hour and the bulk operation still read COMPLETED.
 * Products are matched by the ref metafield, never by handle, so a suffixed handle is safe:
 * taken → `${handle}-${ref}`; that one taken too → not created, reported.
 *
 * A handle held by a product with the same ref is our own product that the store search has
 * not returned (its index lags behind writes): it is not created again, the next run updates
 * it. Until now that taken handle was what stopped the duplicate.
 *
 * No imports: the decision is pure and the run only talks to the `admin` it is given, so
 * `node --test` and the QA harness load this file as is.
 */

export interface HandleHolder {
  id: string;
  /** The holder's own ref metafield, if it has one. */
  ref: string | null;
}

export type HandleChoice =
  | { action: "create"; handle: string }
  | { action: "skip"; reason: string };

/** Where to create a product, given who holds its handle and the suffixed one. */
export function chooseCreateHandle(
  handle: string,
  ref: string,
  holder: HandleHolder | null,
  suffixedHolder: HandleHolder | null,
): HandleChoice {
  if (!holder) return { action: "create", handle };
  if (holder.ref === ref) return { action: "skip", reason: `already in the store as ${holder.id} (search missed it)` };

  const suffixed = `${handle}-${ref.toLowerCase()}`;
  if (!suffixedHolder) return { action: "create", handle: suffixed };
  if (suffixedHolder.ref === ref) {
    return { action: "skip", reason: `already in the store as ${suffixedHolder.id} under ${suffixed} (search missed it)` };
  }
  return { action: "skip", reason: `${handle} held by ${holder.id}, ${suffixed} held by ${suffixedHolder.id}` };
}

interface ShopifyAdmin {
  graphql: (query: string, options?: any) => Promise<Response>;
}

async function findHandleHolder(admin: ShopifyAdmin, handle: string, refKey: string) {
  const response = await admin.graphql(
    `#graphql
      query productByHandle($handle: String!) {
        productByIdentifier(identifier: { handle: $handle }) {
          id
          ref: metafield(namespace: "custom", key: "${refKey}") { value }
        }
      }`,
    { variables: { handle } },
  );
  const body = await response.json();
  if (body.errors || !body.data) throw new Error(`productByIdentifier: ${JSON.stringify(body.errors ?? "no data").slice(0, 300)}`);
  const product = body.data.productByIdentifier;
  const holder: HandleHolder | null = product ? { id: product.id, ref: product.ref?.value ?? null } : null;
  return holder;
}

/**
 * The products to create, each under a free handle, plus what was renamed or left out. A handle
 * that could not be checked is created as it is: a collision then shows in the create row,
 * which reads the bulk result file. One cheap read per product, a second one only when taken.
 */
export async function resolveCreateHandles<P extends { handle: string; ref: string }>(
  admin: ShopifyAdmin,
  products: P[],
  refKey: string,
) {
  const resolved: P[] = [];
  const renamed: string[] = [];
  const skipped: string[] = [];
  const unchecked: string[] = [];

  for (const product of products) {
    try {
      const holder = await findHandleHolder(admin, product.handle, refKey);
      const suffixed = `${product.handle}-${product.ref.toLowerCase()}`;
      const suffixedHolder = holder && holder.ref !== product.ref ? await findHandleHolder(admin, suffixed, refKey) : null;
      const choice = chooseCreateHandle(product.handle, product.ref, holder, suffixedHolder);

      if (choice.action === "skip") {
        skipped.push(`skipped ${product.handle} (ref=${product.ref}): ${choice.reason}`);
      } else if (choice.handle !== product.handle) {
        renamed.push(`${product.handle} -> ${choice.handle} (ref=${product.ref}, held by ${holder?.id})`);
        resolved.push({ ...product, handle: choice.handle });
      } else {
        resolved.push(product);
      }
    } catch (error) {
      unchecked.push(`handle not checked ${product.handle} (ref=${product.ref}): ${error instanceof Error ? error.message : error}`);
      resolved.push(product);
    }
  }

  return { products: resolved, renamed, skipped, unchecked };
}
