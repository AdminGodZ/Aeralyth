"use client";

import { format } from "date-fns";
import {
  CalendarClock,
  CalendarDays,
  Check,
  Clock3,
  Copy,
  Eye,
  Globe2,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type AccessScope = "public" | "account";
type Permission = "viewer" | "editor";
type ExpirationChoice =
  | "3600"
  | "86400"
  | "604800"
  | "2592000"
  | "custom"
  | "never";

type CustomExpirationValue = {
  date: Date;
  time: string;
  earliestDate: Date;
  latestDate: Date;
};

type CreatedShareLink = {
  id: string;
  urlPath: string;
  accessScope: AccessScope;
  permission: Permission;
  recipientUsername: string | null;
  expiresAt: string | null;
};

type OwnedShareLink = {
  id: string;
  accessScope: AccessScope;
  permission: Permission;
  recipientUsername: string | null;
  expiresAt: string | null;
  createdAt: string;
  status: "active" | "expired" | "revoked";
  urlPath: string | null;
};

type OwnedShareLinkPage = {
  links: OwnedShareLink[];
  nextCursor: string | null;
  hasMore: boolean;
};

const expirationOptions = [
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
  { value: "custom", label: "Custom" },
  { value: "never", label: "Never" },
] as const;
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) =>
  String(hour).padStart(2, "0"),
);
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, minute) =>
  String(minute).padStart(2, "0"),
);
const DEFAULT_EXPIRATION: ExpirationChoice = "604800";
const MIN_LINK_LIFETIME_SECONDS = 5 * 60;
const MAX_LINK_LIFETIME_SECONDS = 365 * 24 * 60 * 60;
const shareDateTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

type ShareLinkDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  itemId: string;
  itemName: string;
  itemType: "file" | "folder";
  initiallyShared: boolean;
  csrfToken: string;
};

export function ShareLinkDialog(props: ShareLinkDialogProps) {
  const controller = useShareLinkDialogController(props);
  return <ShareLinkDialogView controller={controller} />;
}

function useShareLinkDialogController({
  open,
  onOpenChange,
  itemId,
  itemName,
  itemType,
  initiallyShared,
  csrfToken,
}: ShareLinkDialogProps) {
  const router = useRouter();
  const [accessScope, setAccessScope] = useState<AccessScope>("public");
  const [permission, setPermission] = useState<Permission>("viewer");
  const [expiration, setExpiration] =
    useState<ExpirationChoice>(DEFAULT_EXPIRATION);
  const [customExpiration, setCustomExpiration] =
    useState<CustomExpirationValue | null>(null);
  const [recipientUsername, setRecipientUsername] = useState("");
  const [createdLink, setCreatedLink] = useState<CreatedShareLink | null>(null);
  const [createdUrl, setCreatedUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [links, setLinks] = useState<OwnedShareLink[]>([]);
  const linksCursorRef = useRef<string | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const [hasMoreLinks, setHasMoreLinks] = useState(false);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [loadingMoreLinks, setLoadingMoreLinks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The dialog is opened from client-only selection state, so this lookup
  // cannot be moved to its parent Server Component. It is an idempotent GET,
  // and the abort controller prevents stale updates on close or item changes.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect
  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();
    setLoadingLinks(true);
    void requestOwnedLinks(itemId, controller.signal)
      .then((page) => {
        setLinks(page.links);
        linksCursorRef.current = page.nextCursor;
        setHasMoreLinks(page.hasMore);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Existing links could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingLinks(false);
      });

    return () => {
      controller.abort();
      loadMoreControllerRef.current?.abort();
    };
  }, [itemId, open]);

  async function loadMoreLinks(): Promise<void> {
    const cursor = linksCursorRef.current;
    if (!cursor || loadMoreControllerRef.current) return;
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setLoadingMoreLinks(true);
    setError(null);
    try {
      const page = await requestOwnedLinks(itemId, controller.signal, cursor);
      setLinks((current) => [
        ...current,
        ...page.links.filter(
          (link) => !current.some((existing) => existing.id === link.id),
        ),
      ]);
      linksCursorRef.current = page.nextCursor;
      setHasMoreLinks(page.hasMore);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Older links could not be loaded.",
        );
      }
    } finally {
      loadMoreControllerRef.current = null;
      // The controller ref blocks every newer load-more request until this finally runs.
      // react-doctor-disable-next-line react-doctor/no-unowned-async-error-clear
      setLoadingMoreLinks(false);
    }
  }

  function close(nextOpen: boolean): void {
    if (busy || revokingId || rotatingId) return;
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setAccessScope("public");
      setPermission("viewer");
      setExpiration(DEFAULT_EXPIRATION);
      setCustomExpiration(null);
      setRecipientUsername("");
      setCreatedLink(null);
      setCreatedUrl("");
      setCopied(false);
      setCopiedLinkId(null);
      setError(null);
    }
  }

  async function createLink(): Promise<void> {
    const recipient = recipientUsername.trim();
    if (accessScope === "account" && !recipient) return;
    const expiresInSeconds = getExpirationSeconds(expiration, customExpiration);
    if (expiration === "custom" && expiresInSeconds === undefined) {
      setError(
        "Choose a date and time from five minutes to one year from now.",
      );
      return;
    }

    setBusy(true);
    setCopied(false);
    setError(null);
    try {
      const created = await requestCreateShareLink({
        itemId,
        accessScope,
        permission,
        recipientUsername: accessScope === "account" ? recipient : null,
        expiresInSeconds: expiresInSeconds ?? null,
        csrfToken,
      });
      setCreatedLink(created);
      setCreatedUrl(
        new URL(created.urlPath, window.location.origin).toString(),
      );
      setLinks((current) => [
        {
          id: created.id,
          accessScope: created.accessScope,
          permission: created.permission,
          recipientUsername: created.recipientUsername,
          expiresAt: created.expiresAt,
          createdAt: new Date().toISOString(),
          status: "active",
          urlPath: created.urlPath,
        },
        ...current,
      ]);
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The share link could not be created.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyCreatedUrl(): Promise<void> {
    if (!createdUrl) return;

    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
    } catch {
      setError("Copying was blocked. Select the link and copy it manually.");
    }
  }

  async function copyOwnedUrl(link: OwnedShareLink): Promise<void> {
    if (!link.urlPath) return;
    try {
      await navigator.clipboard.writeText(toAbsoluteShareUrl(link.urlPath));
      setCopiedLinkId(link.id);
    } catch {
      setError("Copying was blocked. Select the link and copy it manually.");
    }
  }

  async function rotate(linkId: string): Promise<void> {
    setRotatingId(linkId);
    setCopiedLinkId(null);
    setError(null);
    try {
      const rotated = await requestRotateShareLink(linkId, csrfToken);
      setLinks((current) =>
        current.map((link) =>
          link.id === linkId ? { ...link, urlPath: rotated.urlPath } : link,
        ),
      );
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The share link could not be replaced.",
      );
    } finally {
      setRotatingId(null);
    }
  }

  async function revoke(linkId: string): Promise<void> {
    setRevokingId(linkId);
    setError(null);
    try {
      await requestRevokeShareLink(linkId, csrfToken);
      setLinks((current) =>
        current.map((link) =>
          link.id === linkId ? { ...link, status: "revoked" } : link,
        ),
      );
      if (createdLink?.id === linkId) {
        setCreatedLink(null);
        setCreatedUrl("");
      }
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The share link could not be revoked.",
      );
    } finally {
      setRevokingId(null);
    }
  }

  const activeLinks = links.filter((link) => link.status === "active");
  const managingExistingLink =
    activeLinks.length > 0 || (loadingLinks && initiallyShared);

  return {
    accessScope,
    activeLinks,
    busy,
    close,
    copied,
    copiedLinkId,
    copyCreatedUrl,
    copyOwnedUrl,
    createLink,
    createdLink,
    createdUrl,
    customExpiration,
    error,
    expiration,
    hasMoreLinks,
    itemName,
    itemType,
    loadMoreLinks,
    loadingLinks,
    loadingMoreLinks,
    managingExistingLink,
    open,
    permission,
    recipientUsername,
    revoke,
    revokingId,
    rotate,
    rotatingId,
    setAccessScope,
    setCopied,
    setCreatedLink,
    setCreatedUrl,
    setCustomExpiration,
    setExpiration,
    setPermission,
    setRecipientUsername,
  };
}

function ShareLinkDialogView({
  controller,
}: {
  controller: ReturnType<typeof useShareLinkDialogController>;
}) {
  const {
    accessScope,
    activeLinks,
    busy,
    close,
    copied,
    copiedLinkId,
    copyCreatedUrl,
    copyOwnedUrl,
    createLink,
    createdLink,
    createdUrl,
    customExpiration,
    error,
    expiration,
    hasMoreLinks,
    itemName,
    itemType,
    loadMoreLinks,
    loadingLinks,
    loadingMoreLinks,
    managingExistingLink,
    open,
    permission,
    recipientUsername,
    revoke,
    revokingId,
    rotate,
    rotatingId,
    setAccessScope,
    setCopied,
    setCreatedLink,
    setCreatedUrl,
    setCustomExpiration,
    setExpiration,
    setPermission,
    setRecipientUsername,
  } = controller;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="size-5 text-primary" aria-hidden="true" />
            {managingExistingLink ? "Manage sharing" : `Share ${itemType}`}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure sharing for {itemName}.
          </DialogDescription>
        </DialogHeader>

        {createdLink ? (
          <CreatedLinkResult
            createdLink={createdLink}
            createdUrl={createdUrl}
            copied={copied}
            error={error}
            onCopy={() => void copyCreatedUrl()}
            onCreateAnother={() => {
              setCreatedLink(null);
              setCreatedUrl("");
              setCopied(false);
            }}
            onDone={() => close(false)}
          />
        ) : (
          <ShareConfigurationForm
            accessScope={accessScope}
            onAccessScopeChange={setAccessScope}
            permission={permission}
            onPermissionChange={setPermission}
            expiration={expiration}
            onExpirationChange={(value) => {
              setExpiration(value);
              if (value === "custom" && !customExpiration) {
                setCustomExpiration(createDefaultCustomExpiration());
              }
            }}
            customExpiration={customExpiration}
            onCustomExpirationChange={setCustomExpiration}
            recipientUsername={recipientUsername}
            onRecipientUsernameChange={setRecipientUsername}
            itemType={itemType}
            error={error}
            loadingLinks={loadingLinks}
            loadingMoreLinks={loadingMoreLinks}
            hasMoreLinks={hasMoreLinks}
            activeLinks={activeLinks}
            revokingId={revokingId}
            rotatingId={rotatingId}
            copiedLinkId={copiedLinkId}
            busy={busy}
            onRevoke={(linkId) => void revoke(linkId)}
            onRotate={(linkId) => void rotate(linkId)}
            onCopy={(link) => void copyOwnedUrl(link)}
            onLoadMore={() => void loadMoreLinks()}
            onCancel={() => close(false)}
            onSubmit={() => void createLink()}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreatedLinkResult({
  createdLink,
  createdUrl,
  copied,
  error,
  onCopy,
  onCreateAnother,
  onDone,
}: {
  createdLink: CreatedShareLink;
  createdUrl: string;
  copied: boolean;
  error: string | null;
  onCopy(): void;
  onCreateAnother(): void;
  onDone(): void;
}) {
  return (
    <div className="space-y-5">
      <p className="sr-only" role="status" aria-live="polite">
        Share link created
      </p>
      <section className="space-y-2" aria-labelledby="created-share-url-label">
        <Label id="created-share-url-label" htmlFor="created-share-url">
          Share link
        </Label>
        <CopyableShareUrl
          id="created-share-url"
          value={createdUrl}
          copied={copied}
          onCopy={onCopy}
          highlighted
        />
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <ShareLinkFacts
        accessScope={createdLink.accessScope}
        permission={createdLink.permission}
        recipientUsername={createdLink.recipientUsername}
        expiresAt={createdLink.expiresAt}
        className="rounded-xl bg-muted/40 p-3"
      />

      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onCreateAnother}>
          Create another link
        </Button>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

function ShareConfigurationForm({
  accessScope,
  onAccessScopeChange,
  permission,
  onPermissionChange,
  expiration,
  onExpirationChange,
  customExpiration,
  onCustomExpirationChange,
  recipientUsername,
  onRecipientUsernameChange,
  itemType,
  error,
  loadingLinks,
  loadingMoreLinks,
  hasMoreLinks,
  activeLinks,
  revokingId,
  rotatingId,
  copiedLinkId,
  busy,
  onRevoke,
  onRotate,
  onCopy,
  onLoadMore,
  onCancel,
  onSubmit,
}: {
  accessScope: AccessScope;
  onAccessScopeChange(value: AccessScope): void;
  permission: Permission;
  onPermissionChange(value: Permission): void;
  expiration: ExpirationChoice;
  onExpirationChange(value: ExpirationChoice): void;
  customExpiration: CustomExpirationValue | null;
  onCustomExpirationChange(value: CustomExpirationValue): void;
  recipientUsername: string;
  onRecipientUsernameChange(value: string): void;
  itemType: "file" | "folder";
  error: string | null;
  loadingLinks: boolean;
  loadingMoreLinks: boolean;
  hasMoreLinks: boolean;
  activeLinks: OwnedShareLink[];
  revokingId: string | null;
  rotatingId: string | null;
  copiedLinkId: string | null;
  busy: boolean;
  onRevoke(linkId: string): void;
  onRotate(linkId: string): void;
  onCopy(link: OwnedShareLink): void;
  onLoadMore(): void;
  onCancel(): void;
  onSubmit(): void;
}) {
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <ActiveShareLinks
        loading={loadingLinks}
        loadingMore={loadingMoreLinks}
        hasMore={hasMoreLinks}
        links={activeLinks}
        revokingId={revokingId}
        rotatingId={rotatingId}
        copiedLinkId={copiedLinkId}
        onRevoke={onRevoke}
        onRotate={onRotate}
        onCopy={onCopy}
        onLoadMore={onLoadMore}
      />

      {activeLinks.length > 0 ? (
        <p className="text-sm font-medium">Create another link</p>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Who can open it?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <ChoiceCard
            name="share-access"
            value="public"
            checked={accessScope === "public"}
            onChange={() => onAccessScopeChange("public")}
            icon={Globe2}
            title="Anyone with the link"
            description="No Aeralyth account is required."
          />
          <ChoiceCard
            name="share-access"
            value="account"
            checked={accessScope === "account"}
            onChange={() => onAccessScopeChange("account")}
            icon={LockKeyhole}
            title="One Aeralyth account"
            description="Only the selected signed-in user."
          />
        </div>
      </fieldset>

      {accessScope === "account" ? (
        <div className="space-y-2">
          <Label htmlFor="share-recipient-username">Recipient username</Label>
          <Input
            id="share-recipient-username"
            value={recipientUsername}
            onChange={(event) => onRecipientUsernameChange(event.target.value)}
            autoComplete="off"
            required
            autoFocus
            placeholder="username"
          />
        </div>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Permission</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <ChoiceCard
            name="share-permission"
            value="viewer"
            checked={permission === "viewer"}
            onChange={() => onPermissionChange("viewer")}
            icon={LockKeyhole}
            title="Viewer"
            description="Browse and download."
          />
          <ChoiceCard
            name="share-permission"
            value="editor"
            checked={permission === "editor"}
            onChange={() => onPermissionChange("editor")}
            icon={Pencil}
            title="Editor"
            description={
              itemType === "folder"
                ? "Upload and remove items inside this folder."
                : "Replace this shared file."
            }
          />
        </div>
      </fieldset>

      <div className="space-y-2">
        <Label id="share-expiration-label">Link expiration</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={expiration}
            onValueChange={(value) => {
              if (isExpirationChoice(value)) onExpirationChange(value);
            }}
          >
            <SelectTrigger
              className="w-44 max-w-full"
              aria-labelledby="share-expiration-label"
            >
              <Clock3 className="size-4" aria-hidden="true" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {expirationOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {expiration === "custom" && customExpiration ? (
            <CustomExpirationPicker
              value={customExpiration}
              onChange={onCustomExpirationChange}
            />
          ) : null}
        </div>
      </div>

      {permission === "editor" && accessScope === "public" ? (
        <Alert>
          <Pencil className="size-4" aria-hidden="true" />
          <AlertTitle>Anyone holding this link can modify it</AlertTitle>
          <AlertDescription>
            Treat an editor link like a password and revoke it when the work is
            finished.
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Sharing failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            busy || (accessScope === "account" && !recipientUsername.trim())
          }
        >
          {busy ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Share2 className="size-4" aria-hidden="true" />
          )}
          Create link
        </Button>
      </DialogFooter>
    </form>
  );
}

function CustomExpirationPicker({
  value,
  onChange,
}: {
  value: CustomExpirationValue;
  onChange(value: CustomExpirationValue): void;
}) {
  const [hours = "00", minutes = "00"] = value.time.split(":");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="w-64 max-w-full justify-start font-normal"
        >
          <CalendarDays className="size-4" aria-hidden="true" />
          <span className="truncate">
            {format(value.date, "PPP")} · {value.time}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="w-auto overflow-hidden rounded-2xl p-0 shadow-xl"
      >
        <Calendar
          mode="single"
          required
          selected={value.date}
          defaultMonth={value.date}
          disabled={{ before: value.earliestDate, after: value.latestDate }}
          onSelect={(date) => onChange({ ...value, date })}
          autoFocus
        />
        <div className="flex items-center gap-3 bg-muted/40 px-3 py-3">
          <span className="shrink-0 text-sm font-medium">Time</span>
          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">Custom expiration time</legend>
            <TimePartSelect
              label="Hour"
              value={hours}
              options={HOUR_OPTIONS}
              onValueChange={(hour) =>
                onChange({ ...value, time: `${hour}:${minutes}` })
              }
            />
            <span
              className="text-sm font-medium text-muted-foreground"
              aria-hidden="true"
            >
              :
            </span>
            <TimePartSelect
              label="Minute"
              value={minutes}
              options={MINUTE_OPTIONS}
              onValueChange={(minute) =>
                onChange({ ...value, time: `${hours}:${minute}` })
              }
            />
          </fieldset>
          <span className="text-xs text-muted-foreground">Local time</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TimePartSelect({
  label,
  value,
  options,
  onValueChange,
}: {
  label: "Hour" | "Minute";
  value: string;
  options: string[];
  onValueChange(value: string): void;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        aria-label={label}
        className="w-16 bg-background/80 font-mono tabular-nums"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="center"
        className="max-h-64 min-w-20"
      >
        {options.map((option) => (
          <SelectItem
            key={option}
            value={option}
            className="font-mono tabular-nums"
          >
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ActiveShareLinks({
  loading,
  loadingMore,
  hasMore,
  links,
  revokingId,
  rotatingId,
  copiedLinkId,
  onRevoke,
  onRotate,
  onCopy,
  onLoadMore,
}: {
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  links: OwnedShareLink[];
  revokingId: string | null;
  rotatingId: string | null;
  copiedLinkId: string | null;
  onRevoke(linkId: string): void;
  onRotate(linkId: string): void;
  onCopy(link: OwnedShareLink): void;
  onLoadMore(): void;
}) {
  if (!loading && links.length === 0 && !hasMore) return null;

  return (
    <div className="space-y-3">
      {loading ? (
        <LoaderCircle
          className="mx-auto size-4 animate-spin text-muted-foreground"
          aria-label="Loading active links"
        />
      ) : null}
      {links.map((link) => (
        <article
          key={link.id}
          className="space-y-3 rounded-2xl bg-muted/35 p-3.5"
        >
          <div className="flex items-center gap-2">
            {link.urlPath ? (
              <div className="min-w-0 flex-1">
                <CopyableShareUrl
                  id={`share-link-${link.id}`}
                  value={toAbsoluteShareUrl(link.urlPath)}
                  copied={copiedLinkId === link.id}
                  onCopy={() => onCopy(link)}
                />
              </div>
            ) : (
              <Button
                type="button"
                variant="secondary"
                disabled={rotatingId === link.id}
                onClick={() => onRotate(link.id)}
              >
                {rotatingId === link.id ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <RefreshCw className="size-4" aria-hidden="true" />
                )}
                Replace older link
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={revokingId === link.id || rotatingId === link.id}
              aria-label="Revoke share link"
              title="Revoke share link"
              onClick={() => onRevoke(link.id)}
            >
              {revokingId === link.id ? (
                <LoaderCircle
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
            </Button>
          </div>

          <ShareLinkFacts
            accessScope={link.accessScope}
            permission={link.permission}
            recipientUsername={link.recipientUsername}
            expiresAt={link.expiresAt}
            createdAt={link.createdAt}
          />
        </article>
      ))}
      {hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : null}
          Load older links
        </Button>
      ) : null}
    </div>
  );
}

function CopyableShareUrl({
  id,
  value,
  copied,
  onCopy,
  highlighted = false,
}: {
  id: string;
  value: string;
  copied: boolean;
  onCopy(): void;
  highlighted?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-xl border bg-background/70 p-1.5 shadow-sm shadow-black/5",
        highlighted ? "border-emerald-500/50" : "border-transparent",
      )}
    >
      <Link2
        className="ml-1.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        id={id}
        aria-label="Share link"
        readOnly
        value={value}
        onFocus={(event) => event.currentTarget.select()}
        className="h-8 min-w-0 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:border-transparent"
      />
      <Button
        type="button"
        variant={copied ? "default" : "secondary"}
        className="min-w-20"
        onClick={onCopy}
      >
        {copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}

function ShareLinkFacts({
  accessScope,
  permission,
  recipientUsername,
  expiresAt,
  createdAt,
  className,
}: {
  accessScope: AccessScope;
  permission: Permission;
  recipientUsername: string | null;
  expiresAt: string | null;
  createdAt?: string;
  className?: string;
}) {
  const AccessIcon = accessScope === "public" ? Globe2 : LockKeyhole;
  const PermissionIcon = permission === "editor" ? Pencil : Eye;

  return (
    <dl className={cn("grid gap-x-4 gap-y-3 sm:grid-cols-2", className)}>
      <ShareLinkFact
        icon={AccessIcon}
        label="Access"
        value={
          accessScope === "public"
            ? "Anyone with link"
            : (recipientUsername ?? "Selected account")
        }
      />
      <ShareLinkFact
        icon={PermissionIcon}
        label="Permission"
        value={permissionLabel(permission)}
      />
      {createdAt ? (
        <ShareLinkFact
          icon={CalendarDays}
          label="Created"
          value={formatDateTime(createdAt)}
        />
      ) : null}
      <ShareLinkFact
        icon={CalendarClock}
        label="Expires"
        value={expirationValue(expiresAt)}
        className={createdAt ? undefined : "sm:col-span-2"}
      />
    </dl>
  );
}

function ShareLinkFact({
  icon: Icon,
  label,
  value,
  className,
}: {
  icon: typeof Globe2;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2.5", className)}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-background/65 text-primary">
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] leading-4 text-muted-foreground">{label}</dt>
        <dd className="break-words text-xs font-medium leading-4">{value}</dd>
      </div>
    </div>
  );
}

function ChoiceCard({
  name,
  value,
  checked,
  onChange,
  icon: Icon,
  title,
  description,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange(): void;
  icon: typeof Globe2;
  title: string;
  description: string;
}) {
  return (
    <Label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
        checked ? "border-primary bg-primary/5" : "hover:bg-muted/40",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <Icon
        className="mt-0.5 size-4 shrink-0 text-primary"
        aria-hidden="true"
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">
          {description}
        </span>
      </span>
    </Label>
  );
}

async function requestCreateShareLink({
  itemId,
  accessScope,
  permission,
  recipientUsername,
  expiresInSeconds,
  csrfToken,
}: {
  itemId: string;
  accessScope: AccessScope;
  permission: Permission;
  recipientUsername: string | null;
  expiresInSeconds: number | null;
  csrfToken: string;
}): Promise<CreatedShareLink> {
  const response = await fetch("/api/share-links", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({
      fileId: itemId,
      accessScope,
      permission,
      recipientUsername,
      expiresInSeconds,
    }),
  });

  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(message || "The share link could not be created.");
  }

  return (await response.json()) as CreatedShareLink;
}

async function requestOwnedLinks(
  itemId: string,
  signal: AbortSignal,
  cursor?: string,
): Promise<OwnedShareLinkPage> {
  const response = await fetch(
    `/api/share-links?${new URLSearchParams({
      fileId: itemId,
      ...(cursor ? { cursor } : {}),
    })}`,
    {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok) {
    throw new Error("Existing share links could not be loaded.");
  }
  return (await response.json()) as OwnedShareLinkPage;
}

async function requestRevokeShareLink(
  linkId: string,
  csrfToken: string,
): Promise<void> {
  const response = await fetch(
    `/api/share-links/${encodeURIComponent(linkId)}`,
    {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    },
  );
  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(message || "The share link could not be revoked.");
  }
}

async function requestRotateShareLink(
  linkId: string,
  csrfToken: string,
): Promise<{ urlPath: string }> {
  const response = await fetch(
    `/api/share-links/${encodeURIComponent(linkId)}/rotate`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-CSRF-Token": csrfToken,
      },
    },
  );
  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(message || "The share link could not be replaced.");
  }
  return (await response.json()) as { urlPath: string };
}

function permissionLabel(permission: Permission): string {
  return permission === "editor" ? "Can modify" : "Can view and download";
}

function formatDateTime(value: string): string {
  return `${shareDateTimeFormatter.format(new Date(value))} UTC`;
}

function expirationValue(value: string | null): string {
  return value ? formatDateTime(value) : "Never";
}

function getExpirationSeconds(
  choice: ExpirationChoice,
  customExpiration: CustomExpirationValue | null,
): number | null | undefined {
  if (choice === "never") return null;
  if (choice !== "custom") return Number(choice);
  if (!customExpiration || !/^\d{2}:\d{2}$/.test(customExpiration.time)) {
    return undefined;
  }

  const [hoursText, minutesText] = customExpiration.time.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (hours > 23 || minutes > 59) return undefined;

  const expiresAt = new Date(customExpiration.date);
  expiresAt.setHours(hours, minutes, 0, 0);
  const seconds = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
  if (
    seconds < MIN_LINK_LIFETIME_SECONDS ||
    seconds > MAX_LINK_LIFETIME_SECONDS
  ) {
    return undefined;
  }
  return seconds;
}

function createDefaultCustomExpiration(): CustomExpirationValue {
  const now = new Date();
  const date = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  date.setSeconds(0, 0);

  const earliestDate = new Date(now);
  earliestDate.setHours(0, 0, 0, 0);
  const latestDate = new Date(now.getTime() + MAX_LINK_LIFETIME_SECONDS * 1000);
  latestDate.setHours(23, 59, 59, 999);

  return {
    date,
    time: `${String(date.getHours()).padStart(2, "0")}:${String(
      date.getMinutes(),
    ).padStart(2, "0")}`,
    earliestDate,
    latestDate,
  };
}

function isExpirationChoice(value: string): value is ExpirationChoice {
  return expirationOptions.some((option) => option.value === value);
}

function toAbsoluteShareUrl(urlPath: string): string {
  return new URL(urlPath, window.location.origin).toString();
}
