export type RepositoryPreviewKind =
  | "archive"
  | "audio"
  | "binary"
  | "font"
  | "image"
  | "markdown"
  | "pdf"
  | "text"
  | "video";

export type RepositoryFilePresentation = {
  kind: RepositoryPreviewKind;
  label: string;
  language: string | null;
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  astro: "astro",
  bash: "bash",
  c: "c",
  cc: "cpp",
  cmake: "cmake",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  csv: "csv",
  cts: "typescript",
  cxx: "cpp",
  diff: "diff",
  env: "dotenv",
  fish: "fish",
  gql: "graphql",
  go: "go",
  graphql: "graphql",
  h: "c",
  hcl: "hcl",
  hpp: "cpp",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "json5",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  log: "text",
  lua: "lua",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  mts: "typescript",
  nix: "nix",
  php: "php",
  plist: "xml",
  prisma: "prisma",
  properties: "properties",
  proto: "proto",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "sass",
  scss: "scss",
  sh: "shellscript",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  tf: "hcl",
  toml: "toml",
  ts: "typescript",
  tsv: "tsv",
  tsx: "tsx",
  txt: "text",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript",
};

const LANGUAGE_BY_FILENAME: Record<string, string> = {
  ".dockerignore": "gitignore",
  ".editorconfig": "ini",
  ".env": "dotenv",
  ".gitattributes": "gitignore",
  ".gitignore": "gitignore",
  "cargo.lock": "toml",
  "cmakelists.txt": "cmake",
  dockerfile: "dockerfile",
  gemfile: "ruby",
  justfile: "make",
  license: "text",
  makefile: "make",
  procfile: "shellscript",
  rakefile: "ruby",
  readme: "markdown",
  "yarn.lock": "yaml",
};

const IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);
const AUDIO_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "mid",
  "midi",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav",
  "weba",
]);
const VIDEO_EXTENSIONS = new Set([
  "avi",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "ogv",
  "webm",
]);
const FONT_EXTENSIONS = new Set(["otf", "ttf", "woff", "woff2"]);
const ZIP_CONTAINER_EXTENSIONS = new Set([
  "apk",
  "docx",
  "epub",
  "jar",
  "odp",
  "ods",
  "odt",
  "pptx",
  "war",
  "xlsx",
  "zip",
]);

export function getRepositoryFilePresentation(
  name: string,
  mimeType: string | null,
): RepositoryFilePresentation {
  const normalizedName = name.trim().toLocaleLowerCase();
  const extension = getFileExtension(normalizedName);
  const normalizedMime = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

  if (normalizedMime === "application/pdf" || extension === "pdf") {
    return { kind: "pdf", label: "PDF", language: null };
  }
  if (normalizedMime.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) {
    return { kind: "image", label: imageLabel(extension), language: null };
  }
  if (normalizedMime.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)) {
    return { kind: "audio", label: "Audio", language: null };
  }
  if (normalizedMime.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) {
    return { kind: "video", label: "Video", language: null };
  }
  if (
    normalizedMime.startsWith("font/") ||
    normalizedMime.includes("font-") ||
    FONT_EXTENSIONS.has(extension)
  ) {
    return { kind: "font", label: "Font", language: null };
  }
  if (
    normalizedMime === "application/zip" ||
    ZIP_CONTAINER_EXTENSIONS.has(extension)
  ) {
    return { kind: "archive", label: archiveLabel(extension), language: null };
  }

  const language =
    LANGUAGE_BY_FILENAME[normalizedName] ?? LANGUAGE_BY_EXTENSION[extension];
  if (language) {
    const markdown = language === "markdown" || language === "mdx";
    return {
      kind: markdown ? "markdown" : "text",
      label: languageLabel(language),
      language,
    };
  }
  if (
    normalizedMime.startsWith("text/") ||
    isStructuredTextMime(normalizedMime)
  ) {
    return { kind: "text", label: "Text", language: "text" };
  }

  return {
    kind: "binary",
    label: extension ? extension.toUpperCase() : "Binary",
    language: null,
  };
}

export function getFileExtension(name: string): string {
  const lastSegment = name.split(/[\\/]/u).at(-1) ?? name;
  const dot = lastSegment.lastIndexOf(".");
  return dot > 0 && dot < lastSegment.length - 1
    ? lastSegment.slice(dot + 1).toLowerCase()
    : "";
}

export function isProbablyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  if (hasUnicodeBom(bytes) || looksLikeUtf16(bytes)) return true;

  let controlBytes = 0;
  for (const byte of bytes.subarray(0, 8192)) {
    if (byte === 0) return false;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) {
      controlBytes += 1;
    }
  }
  if (controlBytes / Math.min(bytes.length, 8192) > 0.02) return false;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 8192));
    return true;
  } catch {
    return false;
  }
}

export function decodeRepositoryText(bytes: Uint8Array): {
  encoding: string;
  text: string;
} {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      encoding: "UTF-16 LE",
      text: new TextDecoder("utf-16le").decode(bytes.subarray(2)),
    };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      encoding: "UTF-16 BE",
      text: new TextDecoder("utf-16be").decode(bytes.subarray(2)),
    };
  }
  if (looksLikeUtf16(bytes)) {
    const evenNulls = countNulls(bytes, 0);
    const oddNulls = countNulls(bytes, 1);
    const encoding = oddNulls > evenNulls ? "utf-16le" : "utf-16be";
    return {
      encoding: encoding === "utf-16le" ? "UTF-16 LE" : "UTF-16 BE",
      text: new TextDecoder(encoding).decode(bytes),
    };
  }

  const offset =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return {
    encoding: "UTF-8",
    text: new TextDecoder("utf-8").decode(bytes.subarray(offset)),
  };
}

export function formatHexDump(bytes: Uint8Array, maxBytes = 32 * 1024): string {
  const visible = bytes.subarray(0, maxBytes);
  const lines: string[] = [];
  for (let offset = 0; offset < visible.length; offset += 16) {
    const row = visible.subarray(offset, offset + 16);
    const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(47, " ");
    const ascii = Array.from(row, (byte) =>
      byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".",
    ).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}

function hasUnicodeBom(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  );
}

function looksLikeUtf16(bytes: Uint8Array): boolean {
  const sampleLength = Math.min(bytes.length, 4096);
  if (sampleLength < 8) return false;
  const evenNulls = countNulls(bytes.subarray(0, sampleLength), 0);
  const oddNulls = countNulls(bytes.subarray(0, sampleLength), 1);
  const pairs = Math.floor(sampleLength / 2);
  return Math.max(evenNulls, oddNulls) / pairs > 0.3;
}

function countNulls(bytes: Uint8Array, parity: 0 | 1): number {
  let count = 0;
  for (let index = parity; index < bytes.length; index += 2) {
    if (bytes[index] === 0) count += 1;
  }
  return count;
}

function isStructuredTextMime(mimeType: string): boolean {
  return (
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml") ||
    mimeType === "application/json" ||
    mimeType === "application/ld+json" ||
    mimeType === "application/sql" ||
    mimeType === "application/toml" ||
    mimeType === "application/xml" ||
    mimeType === "application/x-httpd-php" ||
    mimeType === "application/x-sh" ||
    mimeType === "application/yaml"
  );
}

function imageLabel(extension: string): string {
  return extension === "svg" ? "SVG image" : "Image";
}

function archiveLabel(extension: string): string {
  if (["docx", "xlsx", "pptx"].includes(extension)) {
    return `${extension.toUpperCase()} package`;
  }
  if (["odt", "ods", "odp"].includes(extension)) {
    return `${extension.toUpperCase()} package`;
  }
  return "ZIP archive";
}

function languageLabel(language: string): string {
  const labels: Record<string, string> = {
    csharp: "C#",
    cpp: "C++",
    csv: "CSV",
    dotenv: "Environment",
    gitignore: "Git ignore",
    graphql: "GraphQL",
    html: "HTML",
    ini: "Configuration",
    javascript: "JavaScript",
    json: "JSON",
    json5: "JSON5",
    jsonc: "JSON with comments",
    jsx: "JSX",
    markdown: "Markdown",
    mdx: "MDX",
    php: "PHP",
    shellscript: "Shell",
    sql: "SQL",
    svg: "SVG",
    text: "Text",
    toml: "TOML",
    tsv: "TSV",
    tsx: "TSX",
    typescript: "TypeScript",
    xml: "XML",
    yaml: "YAML",
  };
  return (
    labels[language] ?? language.charAt(0).toUpperCase() + language.slice(1)
  );
}
