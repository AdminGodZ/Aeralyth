export type ArchiveCompressionMode = "balanced" | "speed";

const INCOMPRESSIBLE_EXTENSIONS = new Set([
  "7z",
  "aac",
  "avi",
  "avif",
  "br",
  "bz2",
  "docx",
  "flac",
  "gif",
  "gz",
  "heic",
  "jpeg",
  "jpg",
  "m4a",
  "m4v",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "ogg",
  "otf",
  "pdf",
  "png",
  "pptx",
  "rar",
  "tar",
  "tgz",
  "ttf",
  "wasm",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xlsx",
  "xz",
  "zip",
  "zst",
]);

const INCOMPRESSIBLE_APPLICATION_TYPES = new Set([
  "application/gzip",
  "application/octet-stream",
  "application/pdf",
  "application/wasm",
  "application/x-7z-compressed",
  "application/x-brotli",
  "application/x-rar-compressed",
  "application/x-xz",
  "application/zip",
  "application/zstd",
]);

export function archiveCompressionLevel({
  path,
  mimeType,
  mode = "balanced",
}: {
  path: string;
  mimeType?: string | null;
  mode?: ArchiveCompressionMode;
}): number {
  const extension = path
    .slice(path.lastIndexOf("/") + 1)
    .split(".")
    .at(-1)
    ?.toLowerCase();
  const normalizedMime = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  const mediaMime =
    normalizedMime?.startsWith("audio/") ||
    normalizedMime?.startsWith("video/") ||
    (normalizedMime?.startsWith("image/") &&
      normalizedMime !== "image/svg+xml") ||
    normalizedMime?.startsWith("font/");

  if (
    (extension && INCOMPRESSIBLE_EXTENSIONS.has(extension)) ||
    mediaMime ||
    (normalizedMime && INCOMPRESSIBLE_APPLICATION_TYPES.has(normalizedMime))
  ) {
    return 0;
  }
  return mode === "speed" ? 1 : 6;
}
