export const MAX_REPOSITORY_NAME_LENGTH = 100;
export const MAX_REPOSITORY_DESCRIPTION_LENGTH = 350;

export function normalizeRepositoryName(value: string) {
  return value.trim();
}

export function getRepositoryNameError(value: string): string | null {
  const name = normalizeRepositoryName(value);
  if (!name) {
    return "Enter a repository name.";
  }
  if (Array.from(name).length > MAX_REPOSITORY_NAME_LENGTH) {
    return "Repository names can contain at most 100 characters.";
  }
  if (name === "." || name === ".." || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return "Use only letters, numbers, periods, hyphens, and underscores.";
  }
  return null;
}
