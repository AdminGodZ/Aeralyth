/** Retain local mutations if an older route refresh arrives while they commit. */
export function applyFileListOverlay<
  T extends { id: string; favorite: boolean },
>(
  entries: T[],
  removed: Set<string>,
  favorites: Map<string, boolean>,
  favoritesView: boolean,
): T[] {
  const present = new Set(entries.map(({ id }) => id));
  for (const id of removed) if (!present.has(id)) removed.delete(id);
  return entries.flatMap((entry) => {
    if (removed.has(entry.id)) return [];
    const favorite = favorites.get(entry.id);
    if (favorite === entry.favorite) favorites.delete(entry.id);
    const next = favorite === undefined ? entry : { ...entry, favorite };
    return favoritesView && !next.favorite ? [] : [next];
  });
}
