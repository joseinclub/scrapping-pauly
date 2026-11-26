/**
 * Keeps each store product's photos equal to its source's, by identity. Every sync adds the
 * source images the store lacks, deletes the store images that came from the source and the
 * source no longer has, and puts the source images in source order. Images the merchant
 * uploaded and videos are never deleted or moved.
 *
 * Identity: every source image has a stable key (`shopify:<image id>`, `woo:<image id>`,
 * `ps:<image id>`), and the app-owned product metafield `$app:source_media` (json) records which
 * store media holds which key: `[{ key, mediaId }]`, in source order. Only media in that map
 * are ever deleted; a product whose source lists no image is not touched.
 *
 * Bootstrap (no map yet): source images are linked to store images by file name (Shopify keeps
 * the uploaded file's name, adding `_<uuid>` when it is taken). An unlinked image whose alt is
 * one the app writes (the product title, or an earlier title it used) is a stale copy of a
 * supplier photo and is deleted; any other is the merchant's and stays. With `replaceUnmatched` every unlinked image is deleted instead — once,
 * since the map exists afterwards.
 *
 * Waiting: while an unlinked image is still being uploaded or processed it has no URL yet, so it
 * cannot be told apart (it may be the app's own copy whose map was not saved, or a merchant
 * upload); the product is left for the next run instead of deleting or uploading anything.
 *
 * Order: the source images take, in source order, the positions the source images already hold;
 * the merchant's images and the videos keep theirs and are never named in a move. New images are
 * appended by Shopify.
 *
 * Cost: the media (ids, alts, URLs, status) and the map are read inside the app's existing
 * product fetch (`SOURCE_MEDIA_FIELDS`), so a run with nothing to change adds no request; writes
 * only where something differs, one product at a time, capped per run in number and time
 * (products without any image first), with backoff when Shopify throttles. The maps are returned
 * to the caller, which writes them in the bulk metafieldsSet it already runs; images are added by
 * URL, never downloaded.
 *
 * WHY productUpdate(media), productDeleteMedia and productReorderMedia, deprecated in 2025-07:
 * their replacements (fileCreate / fileUpdate) need the write_files scope, which the app does
 * not have. They are not bulk mutations, and an added image's id is needed in the same run to
 * order it and record it.
 *
 * No imports: the plan is pure and the run only talks to the `admin` it is given, so
 * `node --test` and the QA harness load this file as is.
 */

export const SOURCE_MEDIA_NAMESPACE = "$app";
export const SOURCE_MEDIA_KEY = "source_media";

// WHY caps: the first runs add and delete thousands of images (Pitbull alone ~2,500); each
// product costs a few mutations and the hourly sync is already long. Products past either cap
// are done on the next runs.
export const MEDIA_WRITES_PER_RUN = 50;
export const MEDIA_WRITE_BUDGET_MS = 75_000;

// WHY 50: the store's products hold at most 20 media (2026-11-25); a product with more is
// reported, not reconciled, and the page of 250 products stays far below the query cost limit.
const MEDIA_PER_PRODUCT = 50;

/** Add to the product node of the app's existing product fetch; read it with `storeMediaState`. */
export const SOURCE_MEDIA_FIELDS = `
  sourceMedia: metafield(namespace: "${SOURCE_MEDIA_NAMESPACE}", key: "${SOURCE_MEDIA_KEY}") { value }
  media(first: ${MEDIA_PER_PRODUCT}) {
    pageInfo { hasNextPage }
    nodes { id mediaContentType alt status ... on MediaImage { image { url } } }
  }
`;

export interface SourceImage {
  key: string;
  url: string;
}

export interface StoreMedia {
  id: string;
  /** mediaContentType: IMAGE, VIDEO, EXTERNAL_VIDEO, MODEL_3D. Only IMAGE is ever touched. */
  type: string;
  url: string | null;
  alt: string | null;
  /** MediaStatus: UPLOADED, PROCESSING, READY, FAILED. */
  status?: string | null;
}

export interface SourceMediaLink {
  key: string;
  mediaId: string;
}

export interface SourceMediaPlanOptions {
  /** The alt the app gives the images it uploads (the product title). */
  appAlt: string;
  /** Other alts the app gave its uploads before (e.g. a placeholder title later replaced). */
  oldAlts?: string[];
  /** Bootstrap only: delete every image not linked to the source, not just the app's copies. */
  replaceUnmatched?: boolean;
}

const UUID_SUFFIX = /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A file's name without folder, query or extension, lowercased: what Shopify keeps of it. */
export function fileStem(url: string) {
  const raw = url.split("?")[0].split("/").pop() ?? "";
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // A stray "%" in a file name: compare it as it is.
  }
  name = name.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function findByFileName(url: string, candidates: StoreMedia[]) {
  const stem = fileStem(url);
  const stems = candidates.map((media) => fileStem(media.url ?? ""));
  const exact = stems.findIndex((s) => s === stem);
  const index = exact !== -1 ? exact : stems.findIndex((s) => s.replace(UUID_SUFFIX, "") === stem);
  return index === -1 ? undefined : candidates[index];
}

/**
 * What one product needs: `keep` (source images already in the store, in source order), `add`
 * (in source order) and `remove` (store media ids, in store order); `waiting` when an unlinked
 * image is still being processed and nothing should be done yet. `links` is the product's map,
 * or null when it has never been reconciled.
 */
export function planSourceMedia(
  source: SourceImage[],
  media: StoreMedia[],
  links: SourceMediaLink[] | null,
  options: SourceMediaPlanOptions,
) {
  const images = media.filter((item) => item.type === "IMAGE");
  const present = new Set(images.map(({ id }) => id));

  const owned = new Set<string>();
  const linkByKey = new Map<string, string>();
  for (const link of links ?? []) {
    if (!present.has(link.mediaId) || owned.has(link.mediaId)) continue;
    owned.add(link.mediaId);
    if (!linkByKey.has(link.key)) linkByKey.set(link.key, link.mediaId);
  }

  // A FAILED image never gets a URL, so it is not waited for.
  if (images.some((item) => !item.url && item.status !== "FAILED" && !owned.has(item.id))) {
    return { keep: [] as SourceMediaLink[], add: [] as SourceImage[], remove: [] as string[], waiting: true };
  }

  const used = new Set<string>();
  const seenKeys = new Set<string>();
  const keep: SourceMediaLink[] = [];
  const add: SourceImage[] = [];
  for (const image of source) {
    if (seenKeys.has(image.key)) continue;
    seenKeys.add(image.key);

    const linked = linkByKey.get(image.key);
    // WHY by file name also once the map exists: an image added by a run whose map write then
    // failed is found again instead of being uploaded a second time.
    const found = linked ?? findByFileName(image.url, images.filter(({ id }) => !owned.has(id) && !used.has(id)))?.id;
    if (found) {
      used.add(found);
      keep.push({ key: image.key, mediaId: found });
    } else {
      add.push(image);
    }
  }

  const appAlts = new Set([options.appAlt, ...(options.oldAlts ?? [])]);
  const stale = (item: StoreMedia) =>
    owned.has(item.id) || (links === null && (options.replaceUnmatched || appAlts.has(item.alt ?? "")));
  const remove = images.filter((item) => !used.has(item.id) && stale(item)).map(({ id }) => id);

  return { keep, add, remove, waiting: false };
}

/**
 * The productReorderMedia moves that put `sourceIds` in that order on the positions they hold
 * in `current`, leaving every other media where it is. Only ids in `sourceIds` are ever moved:
 * when another media sits where it must end up, the source media in the way is moved on to its
 * own position instead. Applied one after the other, as Shopify does. Empty when already in order.
 */
export function sourceOrderMoves(current: string[], sourceIds: string[]) {
  const wanted = new Set(sourceIds);
  const queue = sourceIds.filter((id) => current.includes(id));
  const desired = current.map((id) => (wanted.has(id) ? (queue.shift() as string) : id));

  const working = [...current];
  const moves: Array<{ id: string; newPosition: string }> = [];
  const moveTo = (id: string, position: number) => {
    working.splice(working.indexOf(id), 1);
    working.splice(position, 0, id);
    moves.push({ id, newPosition: String(position) });
  };
  desired.forEach((id, position) => {
    while (working[position] !== id) {
      if (wanted.has(id)) moveTo(id, position);
      else moveTo(working[position], desired.indexOf(working[position]));
    }
  });
  return moves;
}

interface ShopifyAdmin {
  graphql: (query: string, options?: any) => Promise<Response>;
}

/** What `storeMediaState` reads from a product node fetched with `SOURCE_MEDIA_FIELDS`. */
export interface StoreMediaState {
  media: StoreMedia[];
  links: SourceMediaLink[] | null;
  /** More media than `SOURCE_MEDIA_FIELDS` reads: the product is reported, not reconciled. */
  truncated: boolean;
}

export interface SourceMediaProduct extends StoreMediaState {
  productId: string;
  ref: string;
  images: SourceImage[];
  /** The alt the app gives the images it uploads (the product title). */
  appAlt: string;
  /** Other alts the app gave its uploads before (e.g. a placeholder title later replaced). */
  oldAlts?: string[];
}

export interface SourceMediaOptions {
  replaceUnmatched?: boolean;
  maxMediaWrites?: number;
  writeBudgetMs?: number;
}

/** A map to write, shaped as the app's bulk metafieldsSet entries. */
export interface SourceMediaMetafield {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

const THROTTLE_TRIES = 5;
const THROTTLE_WAIT_MS = 2_000;
// Keep this much of the cost bucket free for the rest of the sync.
const COST_RESERVE = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isThrottled(detail: unknown) {
  const text = detail instanceof Error ? `${detail.message} ${JSON.stringify((detail as any).body ?? "")}` : JSON.stringify(detail);
  return /THROTTLED|Throttled/.test(text ?? "");
}

async function graphqlData(admin: ShopifyAdmin, query: string, variables: Record<string, unknown>) {
  for (let attempt = 1; ; attempt++) {
    let body: any;
    try {
      const response = await admin.graphql(query, { variables });
      body = await response.json();
    } catch (error) {
      if (attempt < THROTTLE_TRIES && isThrottled(error)) {
        await sleep(THROTTLE_WAIT_MS * attempt);
        continue;
      }
      throw error;
    }
    if (body.errors) {
      if (attempt < THROTTLE_TRIES && isThrottled(body.errors)) {
        await sleep(THROTTLE_WAIT_MS * attempt);
        continue;
      }
      throw new Error(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
    }
    const bucket = body.extensions?.cost?.throttleStatus;
    if (bucket && bucket.currentlyAvailable < COST_RESERVE && bucket.restoreRate > 0) {
      await sleep(((COST_RESERVE - bucket.currentlyAvailable) / bucket.restoreRate) * 1000);
    }
    return body.data;
  }
}

function parseLinks(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (link): link is SourceMediaLink => typeof link?.key === "string" && typeof link?.mediaId === "string",
    );
  } catch {
    return null;
  }
}

function sameLinks(a: SourceMediaLink[] | null, b: SourceMediaLink[]) {
  return a !== null && a.length === b.length && a.every((link, i) => link.key === b[i].key && link.mediaId === b[i].mediaId);
}

/** The media and map of a product node fetched with `SOURCE_MEDIA_FIELDS`. */
export function storeMediaState(node: any): StoreMediaState {
  return {
    media: (node?.media?.nodes ?? []).map((item: any) => ({
      id: item.id,
      type: item.mediaContentType,
      url: item.image?.url ?? null,
      alt: item.alt ?? null,
      status: item.status ?? null,
    })),
    links: parseLinks(node?.sourceMedia?.value),
    truncated: Boolean(node?.media?.pageInfo?.hasNextPage),
  };
}

/** Appends the images by URL (Shopify adds them at the end, in this order); returns the media ids after. */
async function addImages(admin: ShopifyAdmin, productId: string, images: SourceImage[], alt: string) {
  const data = await graphqlData(
    admin,
    `#graphql
      mutation addSourceImages($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
        productUpdate(product: $product, media: $media) {
          product { id media(first: 250) { nodes { id } } }
          userErrors { field message }
        }
      }`,
    {
      product: { id: productId },
      media: images.map(({ url }) => ({ originalSource: url, mediaContentType: "IMAGE", alt })),
    },
  );
  const errors = data?.productUpdate?.userErrors ?? [];
  const nodes: Array<{ id: string }> | undefined = data?.productUpdate?.product?.media?.nodes;
  if (errors.length > 0 || !nodes) throw new Error(`productUpdate media: ${JSON.stringify(errors).slice(0, 300)}`);
  return nodes.map(({ id }) => id);
}

async function deleteMedia(admin: ShopifyAdmin, productId: string, mediaIds: string[]) {
  const data = await graphqlData(
    admin,
    `#graphql
      mutation removeSourceImages($productId: ID!, $mediaIds: [ID!]!) {
        productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
          deletedMediaIds
          mediaUserErrors { field message }
        }
      }`,
    { productId, mediaIds },
  );
  const errors = data?.productDeleteMedia?.mediaUserErrors ?? [];
  const deleted: string[] = data?.productDeleteMedia?.deletedMediaIds ?? [];
  if (errors.length > 0 || deleted.length !== mediaIds.length) {
    throw new Error(`productDeleteMedia: deleted ${deleted.length}/${mediaIds.length} ${JSON.stringify(errors).slice(0, 300)}`);
  }
}

async function reorderMedia(admin: ShopifyAdmin, productId: string, moves: Array<{ id: string; newPosition: string }>) {
  const data = await graphqlData(
    admin,
    `#graphql
      mutation orderSourceImages($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) {
          mediaUserErrors { field message }
        }
      }`,
    { id: productId, moves },
  );
  const errors = data?.productReorderMedia?.mediaUserErrors ?? [];
  if (errors.length > 0) throw new Error(`productReorderMedia: ${JSON.stringify(errors).slice(0, 300)}`);
}

/** Adds before it deletes, so a replaced photo never leaves the product without images. */
async function applyPlan(
  admin: ShopifyAdmin,
  product: SourceMediaProduct,
  plan: ReturnType<typeof planSourceMedia>,
  currentIds: string[],
) {
  const mediaIdByKey = new Map(plan.keep.map(({ key, mediaId }) => [key, mediaId]));
  let ids = currentIds;
  let writes = 0;

  if (plan.add.length > 0) {
    const before = new Set(ids);
    ids = await addImages(admin, product.productId, plan.add, product.appAlt);
    writes++;
    const added = ids.filter((id) => !before.has(id));
    if (added.length !== plan.add.length) {
      throw new Error(`productUpdate added ${added.length} images, expected ${plan.add.length}`);
    }
    plan.add.forEach(({ key }, i) => mediaIdByKey.set(key, added[i]));
  }

  if (plan.remove.length > 0) {
    await deleteMedia(admin, product.productId, plan.remove);
    writes++;
    ids = ids.filter((id) => !plan.remove.includes(id));
  }

  const links = product.images.flatMap(({ key }) => {
    const mediaId = mediaIdByKey.get(key);
    return mediaId ? [{ key, mediaId }] : [];
  });
  const moves = sourceOrderMoves(ids, links.map(({ mediaId }) => mediaId));
  if (moves.length > 0) {
    await reorderMedia(admin, product.productId, moves);
    writes++;
  }

  return { links, reordered: moves.length > 0, writes };
}

/**
 * Reconciles the photos of the given store products with their source images, and returns the
 * maps to write (`metafields`) with a summary. One product's failure does not stop the others;
 * it gets no map entry, so the next run retries it.
 */
export async function syncSourceMedia(admin: ShopifyAdmin, products: SourceMediaProduct[], options: SourceMediaOptions = {}) {
  const maxMediaWrites = options.maxMediaWrites ?? MEDIA_WRITES_PER_RUN;
  const deadline = Date.now() + (options.writeBudgetMs ?? MEDIA_WRITE_BUDGET_MS);
  const summary = {
    products: products.length,
    noSourceImages: 0,
    unchanged: 0,
    linked: 0,
    changed: 0,
    added: 0,
    removed: 0,
    reordered: 0,
    deferred: 0,
    waiting: 0,
    failed: 0,
    writes: 0,
    failures: [] as string[],
  };
  const metafields: SourceMediaMetafield[] = [];
  const fail = (product: SourceMediaProduct, error: unknown) => {
    summary.failed++;
    summary.failures.push(`${product.ref} (${product.productId}): ${error instanceof Error ? error.message : error}`);
  };
  const record = (product: SourceMediaProduct, links: SourceMediaLink[]) =>
    metafields.push({
      ownerId: product.productId,
      namespace: SOURCE_MEDIA_NAMESPACE,
      key: SOURCE_MEDIA_KEY,
      type: "json",
      value: JSON.stringify(links),
    });

  const pending: Array<{ product: SourceMediaProduct; plan: ReturnType<typeof planSourceMedia>; currentIds: string[] }> = [];
  for (const product of products) {
    if (product.images.length === 0) {
      summary.noSourceImages++;
      continue;
    }
    if (product.truncated) {
      fail(product, new Error(`more than ${MEDIA_PER_PRODUCT} media, not reconciled`));
      continue;
    }

    const plan = planSourceMedia(product.images, product.media, product.links, {
      appAlt: product.appAlt,
      oldAlts: product.oldAlts,
      replaceUnmatched: options.replaceUnmatched,
    });
    if (plan.waiting) {
      summary.waiting++;
      continue;
    }
    const currentIds = product.media.map(({ id }) => id);
    const changesMedia =
      plan.add.length > 0 ||
      plan.remove.length > 0 ||
      sourceOrderMoves(currentIds, plan.keep.map(({ mediaId }) => mediaId)).length > 0;

    if (!changesMedia) {
      if (sameLinks(product.links, plan.keep)) {
        summary.unchanged++;
      } else {
        summary.linked++;
        record(product, plan.keep);
      }
      continue;
    }
    pending.push({ product, plan, currentIds });
  }

  // WHY products without any image first: they are the ones the shop shows with no photo, so the
  // per-run cap never leaves them waiting behind products that only need an extra image.
  const hasImage = ({ product }: (typeof pending)[number]) => product.media.some(({ type }) => type === "IMAGE");
  const ordered = [...pending.filter((entry) => !hasImage(entry)), ...pending.filter(hasImage)];

  let changedProducts = 0;
  for (const { product, plan, currentIds } of ordered) {
    if (changedProducts >= maxMediaWrites || Date.now() >= deadline) {
      summary.deferred++;
      continue;
    }
    changedProducts++;

    try {
      const done = await applyPlan(admin, product, plan, currentIds);
      summary.writes += done.writes;
      summary.changed++;
      summary.added += plan.add.length;
      summary.removed += plan.remove.length;
      if (done.reordered) summary.reordered++;
      record(product, done.links);
    } catch (error) {
      fail(product, error);
    }
  }

  return { summary, metafields };
}

/** The `images` SyncLog row of a run (status, counts, first failures), or null when nothing happened. */
export function sourceMediaLogRow(summary: Awaited<ReturnType<typeof syncSourceMedia>>["summary"]) {
  if (summary.changed + summary.linked + summary.deferred + summary.waiting + summary.failed === 0) return null;

  const counts =
    `changed ${summary.changed} (+${summary.added} -${summary.removed}, ${summary.reordered} reordered), ` +
    `linked ${summary.linked}, unchanged ${summary.unchanged}, deferred ${summary.deferred}, ` +
    `waiting for processing ${summary.waiting}, no source images ${summary.noSourceImages}, failed ${summary.failed}`;
  const done = summary.changed + summary.linked;
  const status: "completed" | "partial" | "failed" = summary.failed === 0 ? "completed" : done > 0 ? "partial" : "failed";
  return {
    status,
    processed: done,
    errors: summary.failed,
    message: summary.failures.length > 0 ? `${counts}; ${summary.failures.slice(0, 10).join("; ")}` : counts,
  };
}
