// Kept free of imports so the folder ZIP worker can use it without bundling
// the zip.js writer that bounded-blob-writer.ts builds on.
export const ZIP_ARCHIVE_SAFETY_LIMIT_ERROR =
  "The ZIP archive exceeds the browser safety limit.";
