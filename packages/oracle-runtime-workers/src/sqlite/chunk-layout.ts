/**
 * The storage grain shared by the DO VFS and the R2 page tier. Kept in its
 * own module so `page-tier.ts` can import it without a cycle through
 * `do-vfs.ts`.
 */

/** Bytes per SQLite page. Matches `PRAGMA page_size=4096`. */
export const VFS_PAGE_SIZE = 4096;

/** SQLite pages packed into one stored row (billing grain). */
export const PAGES_PER_CHUNK = 16;

/** Bytes per stored chunk row (64 KiB — well under the 2 MB DO value cap). */
export const CHUNK_SIZE = VFS_PAGE_SIZE * PAGES_PER_CHUNK;
