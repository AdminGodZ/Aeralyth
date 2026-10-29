import { getFileExtension } from "@/features/repositories/repository-file-types";

export type RepositoryLanguage = {
  bytes: number;
  color: string;
  name: string;
  percentage: number;
};

export type RepositoryLanguageFile = {
  name: string;
  path: string;
  sizeBytes: number;
};

/** Server-side byte totals for readable files, keyed like `detectLanguage`. */
export type RepositoryLanguageGroup = {
  kind: "extension" | "filename";
  key: string;
  files: number;
  bytes: number;
};

type LanguageDefinition = {
  color: string;
  name: string;
};

const LANGUAGE_BY_EXTENSION: Record<string, LanguageDefinition> = {
  astro: language("Astro", "#ff5a03"),
  c: language("C", "#555555"),
  cc: language("C++", "#f34b7d"),
  clj: language("Clojure", "#db5855"),
  cljs: language("Clojure", "#db5855"),
  cpp: language("C++", "#f34b7d"),
  cs: language("C#", "#178600"),
  css: language("CSS", "#663399"),
  cxx: language("C++", "#f34b7d"),
  dart: language("Dart", "#00b4ab"),
  elm: language("Elm", "#60b5cc"),
  erl: language("Erlang", "#b83998"),
  ex: language("Elixir", "#6e4a7e"),
  exs: language("Elixir", "#6e4a7e"),
  fs: language("F#", "#b845fc"),
  fsx: language("F#", "#b845fc"),
  go: language("Go", "#00add8"),
  graphql: language("GraphQL", "#e10098"),
  h: language("C", "#555555"),
  hpp: language("C++", "#f34b7d"),
  htm: language("HTML", "#e34c26"),
  html: language("HTML", "#e34c26"),
  java: language("Java", "#b07219"),
  js: language("JavaScript", "#f1e05a"),
  jsx: language("JavaScript", "#f1e05a"),
  kt: language("Kotlin", "#a97bff"),
  kts: language("Kotlin", "#a97bff"),
  less: language("Less", "#1d365d"),
  lua: language("Lua", "#000080"),
  m: language("Objective-C", "#438eff"),
  mjs: language("JavaScript", "#f1e05a"),
  mm: language("Objective-C++", "#6866fb"),
  nim: language("Nim", "#ffc200"),
  php: language("PHP", "#4f5d95"),
  pl: language("Perl", "#0298c3"),
  pm: language("Perl", "#0298c3"),
  prisma: language("Prisma", "#0c344b"),
  proto: language("Protocol Buffer", "#0c344b"),
  ps1: language("PowerShell", "#012456"),
  py: language("Python", "#3572a5"),
  r: language("R", "#198ce7"),
  rb: language("Ruby", "#701516"),
  rs: language("Rust", "#dea584"),
  sass: language("Sass", "#a53b70"),
  scala: language("Scala", "#c22d40"),
  scss: language("SCSS", "#c6538c"),
  sh: language("Shell", "#89e051"),
  sol: language("Solidity", "#aa6746"),
  sql: language("SQL", "#e38c00"),
  svelte: language("Svelte", "#ff3e00"),
  swift: language("Swift", "#f05138"),
  ts: language("TypeScript", "#3178c6"),
  tsx: language("TypeScript", "#3178c6"),
  vue: language("Vue", "#41b883"),
  zig: language("Zig", "#ec915c"),
  zsh: language("Shell", "#89e051"),
};

const LANGUAGE_BY_FILENAME: Record<string, LanguageDefinition> = {
  "cmakelists.txt": language("CMake", "#da3434"),
  dockerfile: language("Dockerfile", "#384d54"),
  justfile: language("Just", "#384d54"),
  makefile: language("Makefile", "#427819"),
};

// The backend mirrors these rules for readable names in
// REPOSITORY_LANGUAGE_STATS_QUERY; repository-languages.test.ts keeps them equal.
export const LANGUAGE_IGNORED_DIRECTORIES = [
  ".next",
  ".output",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "pods",
  "target",
  "vendor",
] as const;

export const LANGUAGE_FILENAMES = Object.keys(LANGUAGE_BY_FILENAME);

const IGNORED_DIRECTORIES = new Set<string>(LANGUAGE_IGNORED_DIRECTORIES);

export const GENERATED_FILE_PATTERN =
  /(?:\.bundle\.|\.generated\.|\.min\.|\.snap$|\.map$)/iu;

export const LOCK_FILE_PATTERN = /(?:^|[-.])lock(?:\.|$)/iu;

export function calculateRepositoryLanguages(
  files: RepositoryLanguageFile[],
  groups: RepositoryLanguageGroup[] = [],
): RepositoryLanguage[] {
  const bytesByLanguage = new Map<string, { bytes: number; color: string }>();
  const add = (definition: LanguageDefinition | null, bytes: number) => {
    if (!definition || bytes <= 0) return;
    const current = bytesByLanguage.get(definition.name);
    bytesByLanguage.set(definition.name, {
      bytes: (current?.bytes ?? 0) + bytes,
      color: definition.color,
    });
  };

  for (const group of groups) {
    add(
      lookupLanguage(
        group.kind === "filename"
          ? LANGUAGE_BY_FILENAME
          : LANGUAGE_BY_EXTENSION,
        group.key,
      ),
      group.bytes,
    );
  }
  for (const file of files) {
    if (file.sizeBytes <= 0 || shouldIgnoreLanguageFile(file)) continue;
    add(detectLanguage(file.name), file.sizeBytes);
  }

  const totalBytes = Array.from(bytesByLanguage.values()).reduce(
    (total, item) => total + item.bytes,
    0,
  );
  if (totalBytes === 0) return [];

  return Array.from(bytesByLanguage, ([name, value]) => ({
    bytes: value.bytes,
    color: value.color,
    name,
    percentage: (value.bytes / totalBytes) * 100,
  })).sort(
    (left, right) =>
      right.bytes - left.bytes || left.name.localeCompare(right.name),
  );
}

export function detectLanguage(name: string): LanguageDefinition | null {
  const normalizedName = name.trim().toLowerCase();
  return (
    lookupLanguage(LANGUAGE_BY_FILENAME, normalizedName) ??
    lookupLanguage(LANGUAGE_BY_EXTENSION, getFileExtension(normalizedName))
  );
}

function lookupLanguage(
  table: Record<string, LanguageDefinition>,
  key: string,
): LanguageDefinition | null {
  // Keys come from file names, so inherited properties such as
  // "constructor" must not resolve to a language.
  return Object.hasOwn(table, key) ? table[key] : null;
}

function shouldIgnoreLanguageFile(file: RepositoryLanguageFile): boolean {
  const pathSegments = file.path
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  return (
    pathSegments.some((segment) => IGNORED_DIRECTORIES.has(segment)) ||
    GENERATED_FILE_PATTERN.test(file.name) ||
    LOCK_FILE_PATTERN.test(file.name)
  );
}

function language(name: string, color: string): LanguageDefinition {
  return { color, name };
}
