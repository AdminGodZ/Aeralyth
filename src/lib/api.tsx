import { headers } from "next/headers";

type HeaderSource = {
  get(name: string): string | null;
};

export type CurrentUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  displayName: string | null;
  themePreference: "system" | "light" | "dark";
  accentColor: string;
  folderZipPromptEnabled: boolean;
  vaultAutoLockMinutes: number;
  profileImageUrl: string | null;
  e2eeMode: "off" | "migrate" | "required";
  vaultConfigured: boolean;
};

export type AuthState =
  | {
      status: "authenticated";
      user: CurrentUser;
    }
  | {
      status: "anonymous";
    }
  | {
      status: "unavailable";
    };

export type CsrfState =
  | {
      status: "ready";
      token: string;
    }
  | {
      status: "unauthorized";
    }
  | {
      status: "unavailable";
    };

export type AdminUser = {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "user";
  status: "active" | "disabled";
  profileImageUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Invitation = {
  id: string;
  invitedUsername: string;
  role: "admin" | "user";
  status: "pending" | "accepted" | "revoked" | "expired";
  createdByUsername: string;
  expiresAt: string;
  createdAt: string;
};

export type AdminUsersData = {
  users: AdminUser[];
  invitations: Invitation[];
  summary: {
    totalUsers: number;
    activeUsers: number;
    admins: number;
    pendingInvites: number;
  };
  usersNextCursor: string | null;
  usersHasMore: boolean;
  invitationsNextCursor: string | null;
  invitationsHasMore: boolean;
};

export type AdminUsersState =
  | {
      status: "ready";
      data: AdminUsersData;
    }
  | {
      status: "unauthorized";
    }
  | {
      status: "forbidden";
    }
  | {
      status: "unavailable";
    };

export type InvitationDetails = {
  username: string;
  role: "admin" | "user";
  expiresAt: string;
};

export type InvitationState =
  | {
      status: "ready";
      invitation: InvitationDetails;
    }
  | {
      status: "invalid";
    }
  | {
      status: "unavailable";
    };

export type SharedLinkEntry = {
  id: string;
  name: string;
  mimeType: string | null;
  entryType: "file" | "folder";
  sizeBytes: number;
  updatedAt: string;
};

export type SharedLinkBreadcrumb = {
  id: string;
  name: string;
};

export type SharedLinkData = {
  accessScope: "public" | "account";
  permission: "viewer" | "editor";
  expiresAt: string | null;
  ownerUsername: string;
  root: SharedLinkEntry;
  currentFolderId: string | null;
  breadcrumbs: SharedLinkBreadcrumb[];
  entries: SharedLinkEntry[];
};

export type ShareLinkState =
  | {
      status: "ready";
      data: SharedLinkData;
    }
  | {
      status: "authentication-required";
    }
  | {
      status: "forbidden";
    }
  | {
      status: "invalid";
    }
  | {
      status: "unavailable";
    };

export type FileView = "files" | "recent" | "favorites" | "shared" | "trash";
export type FileSort = "name" | "size" | "updated";
export type FileSortDirection = "asc" | "desc";

export type FileEntry = {
  id: string;
  name: string;
  kind: string;
  entryType: "file" | "folder";
  parentId: string | null;
  sizeBytes: number;
  state: "active" | "trashed";
  favorite: boolean;
  ownerUsername: string | null;
  shared: boolean;
  hasActiveShareLink: boolean;
  sharedAt: string | null;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  e2eeState: "legacy" | "staged" | "encrypted";
};

export type FolderBreadcrumb = {
  id: string;
  name: string;
  e2eeState: "legacy" | "staged" | "encrypted";
};

export type StorageStats = {
  storagePath: string;
  totalBytes: number;
  availableBytes: number;
  systemUsedBytes: number;
  aeralythUsedBytes: number;
};

export type FilesData = {
  view: FileView;
  entries: FileEntry[];
  currentFolderId: string | null;
  breadcrumbs: FolderBreadcrumb[];
  summary: {
    totalFiles: number;
    totalFolders: number;
    activeFiles: number;
    trashedFiles: number;
    favoriteFiles: number;
    sharedFiles: number;
    usedBytes: number;
  };
  storage: StorageStats;
  nextCursor: string | null;
  hasMore: boolean;
};

export type FilesState =
  | {
      status: "ready";
      data: FilesData;
    }
  | {
      status: "unauthorized";
    }
  | {
      status: "unavailable";
    };

export type RepositoryRoot = {
  id: string;
  name: string;
  e2eeState: "legacy" | "staged" | "encrypted";
  updatedAt: string;
};

export type RepositorySummary = {
  id: string;
  ownerUsername: string;
  defaultBranch: string;
  root: RepositoryRoot;
  createdAt: string;
  updatedAt: string;
};

export type RepositoriesData = {
  repositories: RepositorySummary[];
};

export type RepositoriesState =
  | { status: "ready"; data: RepositoriesData }
  | { status: "unauthorized" }
  | { status: "not-found" }
  | { status: "unavailable" };

export type RepositoryEntry = {
  id: string;
  name: string;
  mimeType: string | null;
  entryType: "file" | "folder";
  parentId: string | null;
  sizeBytes: number;
  e2eeState: "legacy" | "staged" | "encrypted";
  updatedAt: string;
};

export type RepositoryBreadcrumb = {
  id: string;
  name: string;
  e2eeState: "legacy" | "staged" | "encrypted";
};

export type RepositoryDetailData = {
  repository: RepositorySummary;
  currentFolderId: string;
  breadcrumbs: RepositoryBreadcrumb[];
  entries: RepositoryEntry[];
  summary: {
    totalFiles: number;
    totalFolders: number;
  };
  entriesTruncated: boolean;
};

export type RepositoryDetailState =
  | { status: "ready"; data: RepositoryDetailData }
  | { status: "unauthorized" }
  | { status: "not-found" }
  | { status: "unavailable" };

function getApiOrigin() {
  return process.env.AERALYTH_API_ORIGIN?.trim() || "http://127.0.0.1:8080";
}

function getApiTimeoutMs() {
  const configuredTimeout = Number.parseInt(
    process.env.AERALYTH_API_TIMEOUT_MS ?? "",
    10,
  );

  if (Number.isFinite(configuredTimeout) && configuredTimeout > 0) {
    return configuredTimeout;
  }

  return 2500;
}

function withApiTimeout<T>(operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("Aeralyth API request timed out"));
    }, getApiTimeoutMs());
  });

  return Promise.race([operation(controller.signal), timeoutPromise]).finally(
    () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    },
  );
}

function requestApi<T>(
  input: string,
  init: RequestInit,
  handleResponse: (response: Response) => Promise<T>,
) {
  return withApiTimeout(async (signal) => {
    const response = await fetch(input, {
      ...init,
      signal,
    });

    return handleResponse(response);
  });
}

export async function getAuthState(): Promise<AuthState> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");

  try {
    return await requestApi<AuthState>(
      `${getApiOrigin()}/api/auth/me`,
      {
        headers: getForwardedHeaders(requestHeaders, cookie),
        cache: "no-store",
      },
      async (response) => {
        if (response.status === 401) {
          return { status: "anonymous" };
        }

        if (!response.ok) {
          return { status: "unavailable" };
        }

        const data = (await response.json()) as { user: CurrentUser | null };

        if (!data.user) {
          return { status: "anonymous" };
        }

        return { status: "authenticated", user: data.user };
      },
    );
  } catch {
    return { status: "unavailable" };
  }
}

export async function getAdminUsersState(options?: {
  usersCursor?: string;
  invitationsCursor?: string;
  query?: string;
}): Promise<AdminUsersState> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");

  try {
    return await requestApi<AdminUsersState>(
      `${getApiOrigin()}/api/admin/users?${new URLSearchParams({
        ...(options?.usersCursor ? { users_cursor: options.usersCursor } : {}),
        ...(options?.invitationsCursor
          ? { invitations_cursor: options.invitationsCursor }
          : {}),
        ...(options?.query ? { q: options.query } : {}),
      })}`,
      {
        headers: getForwardedHeaders(requestHeaders, cookie),
        cache: "no-store",
      },
      async (response) => {
        if (response.status === 401) {
          return { status: "unauthorized" };
        }

        if (response.status === 403) {
          return { status: "forbidden" };
        }

        if (!response.ok) {
          return { status: "unavailable" };
        }

        return {
          status: "ready",
          data: (await response.json()) as AdminUsersData,
        };
      },
    );
  } catch {
    return { status: "unavailable" };
  }
}

export async function getInvitationState(
  token: string,
): Promise<InvitationState> {
  try {
    return await requestApi<InvitationState>(
      `${getApiOrigin()}/api/invitations/${encodeURIComponent(token)}`,
      {
        cache: "no-store",
      },
      async (response) => {
        if (response.status === 404 || response.status === 410) {
          return { status: "invalid" };
        }

        if (!response.ok) {
          return { status: "unavailable" };
        }

        return {
          status: "ready",
          invitation: (
            (await response.json()) as { invitation: InvitationDetails }
          ).invitation,
        };
      },
    );
  } catch {
    return { status: "unavailable" };
  }
}

export async function getShareLinkState(
  token: string,
  folderId?: string,
): Promise<ShareLinkState> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  const query = folderId ? `?${new URLSearchParams({ folder: folderId })}` : "";

  try {
    return await requestApi<ShareLinkState>(
      `${getApiOrigin()}/api/share-links/access/${encodeURIComponent(token)}${query}`,
      {
        headers: getForwardedHeaders(requestHeaders, cookie),
        cache: "no-store",
      },
      async (response) => {
        if (response.status === 401) {
          return { status: "authentication-required" };
        }

        if (response.status === 403) {
          return { status: "forbidden" };
        }

        if (
          response.status === 400 ||
          response.status === 404 ||
          response.status === 410
        ) {
          return { status: "invalid" };
        }

        if (!response.ok) {
          return { status: "unavailable" };
        }

        return {
          status: "ready",
          data: (await response.json()) as SharedLinkData,
        };
      },
    );
  } catch {
    return { status: "unavailable" };
  }
}

export async function getCsrfState(): Promise<CsrfState> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");

  try {
    return await requestApi<CsrfState>(
      `${getApiOrigin()}/api/auth/csrf`,
      {
        headers: getForwardedHeaders(requestHeaders, cookie),
        cache: "no-store",
      },
      async (response) => {
        if (response.status === 401) {
          return { status: "unauthorized" };
        }

        if (!response.ok) {
          return { status: "unavailable" };
        }

        const data = (await response.json()) as { csrfToken?: unknown };

        if (typeof data.csrfToken !== "string" || !data.csrfToken) {
          return { status: "unavailable" };
        }

        return {
          status: "ready",
          token: data.csrfToken,
        };
      },
    );
  } catch {
    return { status: "unavailable" };
  }
}

export async function getFilesState(
  view: FileView,
  folderId?: string,
  sort?: FileSort,
  direction?: FileSortDirection,
  cursor?: string,
): Promise<FilesState> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");

  try {
    return await requestApi<FilesState>(
      `${getApiOrigin()}/api/files?${new URLSearchParams({
        view,
        ...(folderId ? { folder: folderId } : {}),
        ...(sort ? { sort } : {}),
        ...(sort && direction ? { direction } : {}),
        ...(cursor ? { cursor } : {}),
      })}`,
      {
        headers: getForwardedHeaders(requestHeaders, cookie),
        cache: "no-store",
      },
      async (response) => {
        if (response.status === 401) {
          return { status: "unauthorized" };
        }

        if (!response.ok) {
          return { status: "unavailable" };
        }

        const data = (await response.json()) as Partial<FilesData>;

        if (!isFilesData(data)) {
          return { status: "unavailable" };
        }

        return {
          status: "ready",
          data,
        };
      },
    );
  } catch {
    return { status: "unavailable" };
  }
}

export async function getRepositoriesState(): Promise<RepositoriesState> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");

  try {
    return await requestApi<RepositoriesState>(
      `${getApiOrigin()}/api/repositories`,
      {
        headers: getForwardedHeaders(requestHeaders, cookie),
        cache: "no-store",
      },
      async (response) => {
        if (response.status === 401) {
          return { status: "unauthorized" };
        }

        if (!response.ok) {
          return { status: "unavailable" };
        }

        const data = (await response.json()) as Partial<RepositoriesData>;
        if (!isRepositoriesData(data)) {
          return { status: "unavailable" };
        }

        return { status: "ready", data };
      },
    );
  } catch {
    return { status: "unavailable" };
  }
}

export async function getRepositoryDetailState(
  repositoryId: string,
  folderId?: string,
): Promise<RepositoryDetailState> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  const query = folderId ? `?${new URLSearchParams({ folder: folderId })}` : "";

  try {
    return await requestApi<RepositoryDetailState>(
      `${getApiOrigin()}/api/repositories/${encodeURIComponent(repositoryId)}${query}`,
      {
        headers: getForwardedHeaders(requestHeaders, cookie),
        cache: "no-store",
      },
      async (response) => {
        if (response.status === 401) {
          return { status: "unauthorized" };
        }

        if (response.status === 404) {
          return { status: "not-found" };
        }

        if (!response.ok) {
          return { status: "unavailable" };
        }

        const data = (await response.json()) as Partial<RepositoryDetailData>;
        if (!isRepositoryDetailData(data)) {
          return { status: "unavailable" };
        }

        return { status: "ready", data };
      },
    );
  } catch {
    return { status: "unavailable" };
  }
}

function isRepositoriesData(
  data: Partial<RepositoriesData>,
): data is RepositoriesData {
  return (
    Array.isArray(data.repositories) &&
    data.repositories.every(isRepositorySummary)
  );
}

function isRepositoryDetailData(
  data: Partial<RepositoryDetailData>,
): data is RepositoryDetailData {
  return (
    isRepositorySummary(data.repository) &&
    typeof data.currentFolderId === "string" &&
    Array.isArray(data.breadcrumbs) &&
    data.breadcrumbs.every(
      (breadcrumb) =>
        typeof breadcrumb.id === "string" &&
        typeof breadcrumb.name === "string" &&
        isE2eeState(breadcrumb.e2eeState),
    ) &&
    Array.isArray(data.entries) &&
    data.entries.every(isRepositoryEntry) &&
    data.summary !== undefined &&
    typeof data.summary.totalFiles === "number" &&
    typeof data.summary.totalFolders === "number" &&
    typeof data.entriesTruncated === "boolean"
  );
}

function isRepositorySummary(value: unknown): value is RepositorySummary {
  if (!value || typeof value !== "object") {
    return false;
  }

  const repository = value as Partial<RepositorySummary>;
  return (
    typeof repository.id === "string" &&
    typeof repository.ownerUsername === "string" &&
    typeof repository.defaultBranch === "string" &&
    typeof repository.createdAt === "string" &&
    typeof repository.updatedAt === "string" &&
    repository.root !== undefined &&
    typeof repository.root.id === "string" &&
    typeof repository.root.name === "string" &&
    typeof repository.root.updatedAt === "string" &&
    isE2eeState(repository.root.e2eeState)
  );
}

function isRepositoryEntry(value: unknown): value is RepositoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<RepositoryEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    (typeof entry.mimeType === "string" || entry.mimeType === null) &&
    (entry.entryType === "file" || entry.entryType === "folder") &&
    (typeof entry.parentId === "string" || entry.parentId === null) &&
    typeof entry.sizeBytes === "number" &&
    typeof entry.updatedAt === "string" &&
    isE2eeState(entry.e2eeState)
  );
}

function isE2eeState(
  value: unknown,
): value is "legacy" | "staged" | "encrypted" {
  return value === "legacy" || value === "staged" || value === "encrypted";
}

function isFilesData(data: Partial<FilesData>): data is FilesData {
  return (
    data.view !== undefined &&
    Array.isArray(data.entries) &&
    data.entries.every(isFileEntry) &&
    (typeof data.currentFolderId === "string" ||
      data.currentFolderId === null) &&
    Array.isArray(data.breadcrumbs) &&
    data.breadcrumbs.every(
      (breadcrumb) =>
        typeof breadcrumb.id === "string" &&
        typeof breadcrumb.name === "string" &&
        (breadcrumb.e2eeState === "legacy" ||
          breadcrumb.e2eeState === "staged" ||
          breadcrumb.e2eeState === "encrypted"),
    ) &&
    data.summary !== undefined &&
    typeof data.summary.totalFiles === "number" &&
    typeof data.summary.totalFolders === "number" &&
    typeof data.summary.activeFiles === "number" &&
    typeof data.summary.trashedFiles === "number" &&
    typeof data.summary.favoriteFiles === "number" &&
    typeof data.summary.sharedFiles === "number" &&
    typeof data.summary.usedBytes === "number" &&
    (typeof data.nextCursor === "string" || data.nextCursor === null) &&
    typeof data.hasMore === "boolean" &&
    data.storage !== undefined &&
    typeof data.storage.totalBytes === "number" &&
    typeof data.storage.systemUsedBytes === "number"
  );
}

function isFileEntry(entry: unknown): entry is FileEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const fileEntry = entry as Partial<FileEntry>;

  return (
    typeof fileEntry.id === "string" &&
    typeof fileEntry.name === "string" &&
    typeof fileEntry.kind === "string" &&
    (fileEntry.entryType === "file" || fileEntry.entryType === "folder") &&
    (typeof fileEntry.parentId === "string" || fileEntry.parentId === null) &&
    typeof fileEntry.sizeBytes === "number" &&
    typeof fileEntry.state === "string" &&
    typeof fileEntry.favorite === "boolean" &&
    typeof fileEntry.shared === "boolean" &&
    typeof fileEntry.hasActiveShareLink === "boolean" &&
    (fileEntry.e2eeState === "legacy" ||
      fileEntry.e2eeState === "staged" ||
      fileEntry.e2eeState === "encrypted")
  );
}

function getForwardedHeaders(
  requestHeaders: HeaderSource,
  cookie: string | null,
) {
  const forwardedHeaders = new Headers({
    accept: "application/json",
  });
  const forwardedFor = requestHeaders.get("x-forwarded-for");

  if (cookie) {
    forwardedHeaders.set("cookie", cookie);
  }

  if (forwardedFor) {
    forwardedHeaders.set("x-forwarded-for", forwardedFor);
  }

  return forwardedHeaders;
}
