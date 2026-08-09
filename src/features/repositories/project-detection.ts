export type ProjectDetection = {
  detected: boolean;
  confidence: "high" | "medium" | "none";
  projectType: string | null;
  signals: string[];
};

type ProjectMarker = {
  path: string;
  label: string;
  projectType: string;
};

const MANIFEST_MARKERS: ProjectMarker[] = [
  {
    path: "package.json",
    label: "package.json",
    projectType: "JavaScript or TypeScript",
  },
  { path: "cargo.toml", label: "Cargo.toml", projectType: "Rust" },
  { path: "go.mod", label: "go.mod", projectType: "Go" },
  { path: "pyproject.toml", label: "pyproject.toml", projectType: "Python" },
  {
    path: "requirements.txt",
    label: "requirements.txt",
    projectType: "Python",
  },
  { path: "pipfile", label: "Pipfile", projectType: "Python" },
  { path: "gemfile", label: "Gemfile", projectType: "Ruby" },
  { path: "composer.json", label: "composer.json", projectType: "PHP" },
  { path: "pom.xml", label: "pom.xml", projectType: "Java" },
  {
    path: "build.gradle",
    label: "build.gradle",
    projectType: "Java or Kotlin",
  },
  {
    path: "build.gradle.kts",
    label: "build.gradle.kts",
    projectType: "Kotlin",
  },
  { path: "mix.exs", label: "mix.exs", projectType: "Elixir" },
  { path: "package.swift", label: "Package.swift", projectType: "Swift" },
  {
    path: "pnpm-workspace.yaml",
    label: "pnpm-workspace.yaml",
    projectType: "JavaScript or TypeScript",
  },
];

export function detectProjectFolder(relativePaths: string[]): ProjectDetection {
  const paths = stripSelectionRoot(normalizePaths(relativePaths));
  const lowerPaths = paths.map((path) => path.toLowerCase());
  const manifest = MANIFEST_MARKERS.find((marker) =>
    lowerPaths.includes(marker.path),
  );
  const solutionFile = paths.find((path) =>
    /^(?:[^/]+\.)?(?:sln|csproj|fsproj|vbproj)$/iu.test(path),
  );
  const hasGitMetadata = lowerPaths.some(
    (path) => path === ".git/head" || path === ".git/config",
  );
  const supportSignals = [
    lowerPaths.some((path) => path === "readme" || path.startsWith("readme."))
      ? "README"
      : null,
    lowerPaths.some((path) => path === ".gitignore") ? ".gitignore" : null,
    lowerPaths.some((path) => path === "src" || path.startsWith("src/"))
      ? "src directory"
      : null,
    lowerPaths.some((path) => path === "app" || path.startsWith("app/"))
      ? "app directory"
      : null,
    lowerPaths.some((path) => path === "index.html") ? "index.html" : null,
  ].filter((signal): signal is string => signal !== null);

  if (manifest) {
    return {
      detected: true,
      confidence: "high",
      projectType: manifest.projectType,
      signals: [manifest.label, ...supportSignals].slice(0, 3),
    };
  }

  if (solutionFile) {
    return {
      detected: true,
      confidence: "high",
      projectType: ".NET",
      signals: [solutionFile, ...supportSignals].slice(0, 3),
    };
  }

  if (hasGitMetadata) {
    return {
      detected: true,
      confidence: "high",
      projectType: "Git",
      signals: [".git metadata", ...supportSignals].slice(0, 3),
    };
  }

  if (supportSignals.length >= 2) {
    return {
      detected: true,
      confidence: "medium",
      projectType: null,
      signals: supportSignals.slice(0, 3),
    };
  }

  return {
    detected: false,
    confidence: "none",
    projectType: null,
    signals: supportSignals,
  };
}

export function getSelectionRootName(relativePaths: string[]): string {
  const paths = normalizePaths(relativePaths);
  const rootSegments = new Set(paths.map((path) => path.split("/")[0]));

  if (rootSegments.size === 1 && paths.every((path) => path.includes("/"))) {
    return Array.from(rootSegments)[0] ?? "Project folder";
  }

  return "Project folder";
}

function stripSelectionRoot(paths: string[]): string[] {
  const rootSegments = new Set(paths.map((path) => path.split("/")[0]));
  if (rootSegments.size !== 1 || paths.some((path) => !path.includes("/"))) {
    return paths;
  }

  return paths.map((path) => path.slice(path.indexOf("/") + 1));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

function normalizePaths(paths: string[]): string[] {
  return paths.flatMap((path) => {
    const normalized = normalizePath(path);
    return normalized ? [normalized] : [];
  });
}
