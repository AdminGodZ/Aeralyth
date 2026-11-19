/** Files a paste carries, and how many folders it held that cannot be read. */
export type ClipboardFiles = {
  files: File[];
  skippedFolders: number;
};

type ClipboardItemLike = {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?: () => { isDirectory: boolean } | null;
};

type ClipboardDataLike = {
  items?: ArrayLike<ClipboardItemLike> | null;
  files?: ArrayLike<File> | null;
};

// Browsers name a pasted bitmap (a screenshot, an image copied from a page)
// "image.png" and stamp it with the paste time. A file copied in the file
// manager keeps its own name and modification time.
const GENERIC_CLIPBOARD_IMAGE = /^image\.([a-z0-9]+)$/iu;
const CLIPBOARD_STAMP_TOLERANCE_MS = 10_000;

export function filesFromClipboard(
  data: ClipboardDataLike | null | undefined,
  now: Date = new Date(),
): ClipboardFiles {
  if (!data) return { files: [], skippedFolders: 0 };

  const files: File[] = [];
  let skippedFolders = 0;
  const items = data.items ? Array.from(data.items) : [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) {
      skippedFolders += 1;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  // Some browsers expose pasted files only through the file list.
  if (files.length === 0 && skippedFolders === 0 && data.files) {
    files.push(...Array.from(data.files));
  }

  return { files: nameClipboardImages(files, now), skippedFolders };
}

function nameClipboardImages(files: File[], now: Date): File[] {
  const generic = files.filter((file) => isGenericClipboardImage(file, now));
  if (generic.length === 0) return files;

  const stamp = formatPasteStamp(now);
  let index = 0;
  return files.map((file) => {
    if (!generic.includes(file)) return file;
    index += 1;
    const extension = GENERIC_CLIPBOARD_IMAGE.exec(file.name)?.[1] ?? "png";
    const suffix = generic.length > 1 ? ` (${index})` : "";
    return new File([file], `Pasted image ${stamp}${suffix}.${extension}`, {
      type: file.type,
      lastModified: file.lastModified,
    });
  });
}

function isGenericClipboardImage(file: File, now: Date): boolean {
  return (
    GENERIC_CLIPBOARD_IMAGE.test(file.name) &&
    file.type.startsWith("image/") &&
    Math.abs(now.getTime() - file.lastModified) <= CLIPBOARD_STAMP_TOLERANCE_MS
  );
}

function formatPasteStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} at ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}

/** A paste into a text field, or into an open dialog, is not an upload. */
export function isPasteUploadTarget(target: EventTarget | null): boolean {
  if (typeof document === "undefined") return false;
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
    return false;
  }
  if (!(target instanceof Element)) return true;
  return !target.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
  );
}
