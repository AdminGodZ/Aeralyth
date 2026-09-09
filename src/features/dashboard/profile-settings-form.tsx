"use client";

import {
  Check,
  KeyRound,
  LoaderCircle,
  Monitor,
  Moon,
  Pencil,
  Sun,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getAccountAuthInfo } from "@/features/auth/auth-api";
import { AccentColorPreference } from "@/features/dashboard/accent-color-preference";
import { useRealtimeActivity } from "@/features/realtime/realtime-provider";
import { randomBytes, toBase64Url } from "@/features/vault/protocol";
import { getUnlockMaterial } from "@/features/vault/vault-api";
import { VaultCryptoClient } from "@/features/vault/vault-client";
import { VaultMigrationControl } from "@/features/vault/vault-migration-control";
import {
  normalizeVaultAutoLockMinutes,
  VAULT_AUTO_LOCK_CHANGE_EVENT,
  VAULT_AUTO_LOCK_OPTIONS,
} from "@/features/vault/vault-preferences";
import type { CurrentUser } from "@/lib/api";

type ProfileSettingsFormProps = {
  currentUser: CurrentUser;
  csrfToken: string;
};

type SaveState = "idle" | "saving" | "saved" | "error";

const TRASH_RETENTION_OPTIONS = [1, 7, 30, 60] as const;

type ProfileSettingsUpdate = {
  displayName?: string;
  themePreference?: CurrentUser["themePreference"];
  accentColor?: string;
  folderZipPromptEnabled?: boolean;
  vaultAutoLockMinutes?: number;
  trashRetentionDays?: number;
  profileImage?: File | null;
};

export function ProfileSettingsForm({
  currentUser,
  csrfToken,
}: ProfileSettingsFormProps) {
  const router = useRouter();
  const fileInputId = useId();
  const displayNameId = useId();
  const themeLabelId = useId();
  const accentLabelId = useId();
  const folderZipPromptId = useId();
  const vaultAutoLockId = useId();
  const trashRetentionId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveInFlightRef = useRef(false);
  const pendingUpdateRef = useRef<ProfileSettingsUpdate | null>(null);
  const { setTheme } = useTheme();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  useRealtimeActivity(saveState === "saving");
  const [saveError, setSaveError] = useState<string | null>(null);
  // These values are editable form drafts, not rendered copies of immutable props.
  // react-doctor-disable-next-line react-doctor/no-derived-useState
  const [displayNameDraft, setDisplayNameDraft] = useState(
    currentUser.displayName ?? "",
  );
  // This is an editable form draft, not a rendered copy of immutable props.
  // react-doctor-disable-next-line react-doctor/no-derived-useState
  const [themePreference, setThemePreference] = useState(
    currentUser.themePreference,
  );
  const [folderZipPromptEnabled, setFolderZipPromptEnabled] = useState(
    currentUser.folderZipPromptEnabled !== false,
  );
  const [vaultAutoLockMinutes, setVaultAutoLockMinutes] = useState(() =>
    normalizeVaultAutoLockMinutes(currentUser.vaultAutoLockMinutes),
  );
  const [trashRetentionDays, setTrashRetentionDays] = useState(() =>
    normalizeTrashRetentionDays(currentUser.trashRetentionDays),
  );
  const previousServerUser = useRef(currentUser);
  useEffect(() => {
    const previous = previousServerUser.current;
    previousServerUser.current = currentUser;
    // Merge remote preferences only into untouched drafts. A server refresh
    // arriving while the user types must not replace their unsaved input.
    setDisplayNameDraft((draft) =>
      draft === (previous.displayName ?? "")
        ? (currentUser.displayName ?? "")
        : draft,
    );
    setThemePreference((draft) =>
      draft === previous.themePreference ? currentUser.themePreference : draft,
    );
    setFolderZipPromptEnabled((draft) =>
      draft === (previous.folderZipPromptEnabled !== false)
        ? currentUser.folderZipPromptEnabled !== false
        : draft,
    );
    setVaultAutoLockMinutes((draft) =>
      draft === normalizeVaultAutoLockMinutes(previous.vaultAutoLockMinutes)
        ? normalizeVaultAutoLockMinutes(currentUser.vaultAutoLockMinutes)
        : draft,
    );
    setTrashRetentionDays((draft) =>
      draft === normalizeTrashRetentionDays(previous.trashRetentionDays)
        ? normalizeTrashRetentionDays(currentUser.trashRetentionDays)
        : draft,
    );
  }, [currentUser]);
  const profileName = displayNameDraft.trim() || currentUser.username;
  const avatarUrl = removeImage
    ? null
    : previewUrl || currentUser.profileImageUrl;

  useEffect(() => {
    setTheme(themePreference);
  }, [setTheme, themePreference]);

  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  // A confirmed server avatar change resets the local upload draft atomically.
  // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
  // biome-ignore lint/correctness/useExhaustiveDependencies: The server URL intentionally triggers the reset even though its value is not read.
  useEffect(() => {
    setPreviewUrl((currentPreviewUrl) => {
      if (currentPreviewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(currentPreviewUrl);
      }

      return null;
    });
    setRemoveImage(false);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [currentUser.profileImageUrl]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];

    if (!file) {
      return;
    }

    if (previewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(previewUrl);
    }

    // The previous URL is revoked above and the active URL is revoked by the
    // previewUrl effect cleanup on replacement or unmount.
    // react-doctor-disable-next-line react-doctor/no-create-object-url-without-revoke
    setPreviewUrl(URL.createObjectURL(file));
    setRemoveImage(false);
    queueSettingsUpdate({ profileImage: file });
  }

  function resetProfileImage() {
    setRemoveImage(true);

    if (previewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(previewUrl);
    }

    setPreviewUrl(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    queueSettingsUpdate({ profileImage: null });
  }

  function updateThemePreference(value: string) {
    if (value === "system" || value === "light" || value === "dark") {
      setThemePreference(value);
      queueSettingsUpdate({ themePreference: value });
    }
  }

  function updateDisplayName(event: ChangeEvent<HTMLInputElement>) {
    const value = event.currentTarget.value;
    setDisplayNameDraft(value);
    queueSettingsUpdate({ displayName: value });
  }

  function updateAccentColor(value: string) {
    queueSettingsUpdate({ accentColor: value });
  }

  function updateFolderZipPromptEnabled(value: boolean) {
    setFolderZipPromptEnabled(value);
    queueSettingsUpdate({ folderZipPromptEnabled: value });
  }

  function updateVaultAutoLockMinutes(value: number) {
    const normalizedValue = normalizeVaultAutoLockMinutes(value);
    setVaultAutoLockMinutes(normalizedValue);
    queueSettingsUpdate({ vaultAutoLockMinutes: normalizedValue });
  }

  function updateTrashRetentionDays(value: number) {
    const normalizedValue = normalizeTrashRetentionDays(value);
    setTrashRetentionDays(normalizedValue);
    queueSettingsUpdate({ trashRetentionDays: normalizedValue });
  }

  function queueSettingsUpdate(update: ProfileSettingsUpdate) {
    pendingUpdateRef.current = mergeSettingsUpdates(
      pendingUpdateRef.current,
      update,
    );
    setSaveState("saving");
    setSaveError(null);
    void drainSettingsQueue();
  }

  async function drainSettingsQueue() {
    if (saveInFlightRef.current) {
      return;
    }

    saveInFlightRef.current = true;
    let shouldRefreshProfile = false;
    let queueError: string | null = null;

    try {
      while (pendingUpdateRef.current) {
        const update = pendingUpdateRef.current;
        pendingUpdateRef.current = null;

        try {
          await saveSettings(update);

          if (
            update.profileImage instanceof File &&
            fileInputRef.current?.files?.[0] === update.profileImage
          ) {
            fileInputRef.current.value = "";
          }

          if (update.vaultAutoLockMinutes !== undefined) {
            window.dispatchEvent(
              new CustomEvent(VAULT_AUTO_LOCK_CHANGE_EVENT, {
                detail: update.vaultAutoLockMinutes,
              }),
            );
          }

          if (
            update.displayName !== undefined ||
            update.profileImage !== undefined
          ) {
            shouldRefreshProfile = true;
          }
        } catch (error) {
          queueError =
            error instanceof Error
              ? error.message
              : "Settings could not be saved.";
        }
      }
    } finally {
      saveInFlightRef.current = false;

      if (shouldRefreshProfile) {
        router.refresh();
      }

      if (queueError) {
        setSaveError(queueError);
        setSaveState("error");
      } else {
        setSaveState("saved");
      }
    }
  }

  async function saveSettings(update: ProfileSettingsUpdate) {
    const response = await fetch("/api/profile", {
      method: "POST",
      headers: { "x-csrf-token": csrfToken },
      body: createProfileSettingsFormData(csrfToken, update),
      credentials: "same-origin",
    });
    const result = new URL(response.url).searchParams.get("profile");

    if (!response.ok || result !== "updated") {
      throw new Error(getProfileSaveError(result));
    }
  }

  return (
    <ProfileSettingsFormView
      currentUser={currentUser}
      csrfToken={csrfToken}
      fileInputId={fileInputId}
      displayNameId={displayNameId}
      themeLabelId={themeLabelId}
      accentLabelId={accentLabelId}
      folderZipPromptId={folderZipPromptId}
      vaultAutoLockId={vaultAutoLockId}
      trashRetentionId={trashRetentionId}
      fileInputRef={fileInputRef}
      avatarUrl={avatarUrl}
      profileName={profileName}
      displayNameDraft={displayNameDraft}
      removeImage={removeImage}
      saveState={saveState}
      saveError={saveError}
      themePreference={themePreference}
      folderZipPromptEnabled={folderZipPromptEnabled}
      vaultAutoLockMinutes={vaultAutoLockMinutes}
      trashRetentionDays={trashRetentionDays}
      onFileChange={handleFileChange}
      onResetProfileImage={resetProfileImage}
      onDisplayNameChange={updateDisplayName}
      onThemePreferenceChange={updateThemePreference}
      onAccentColorChange={updateAccentColor}
      onFolderZipPromptEnabledChange={updateFolderZipPromptEnabled}
      onVaultAutoLockMinutesChange={updateVaultAutoLockMinutes}
      onTrashRetentionDaysChange={updateTrashRetentionDays}
    />
  );
}

function ProfileSettingsFormView({
  currentUser,
  csrfToken,
  fileInputId,
  displayNameId,
  themeLabelId,
  accentLabelId,
  folderZipPromptId,
  vaultAutoLockId,
  trashRetentionId,
  fileInputRef,
  avatarUrl,
  profileName,
  displayNameDraft,
  removeImage,
  saveState,
  saveError,
  themePreference,
  folderZipPromptEnabled,
  vaultAutoLockMinutes,
  trashRetentionDays,
  onFileChange,
  onResetProfileImage,
  onDisplayNameChange,
  onThemePreferenceChange,
  onAccentColorChange,
  onFolderZipPromptEnabledChange,
  onVaultAutoLockMinutesChange,
  onTrashRetentionDaysChange,
}: {
  currentUser: CurrentUser;
  csrfToken: string;
  fileInputId: string;
  displayNameId: string;
  themeLabelId: string;
  accentLabelId: string;
  folderZipPromptId: string;
  vaultAutoLockId: string;
  trashRetentionId: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  avatarUrl: string | null;
  profileName: string;
  displayNameDraft: string;
  removeImage: boolean;
  saveState: SaveState;
  saveError: string | null;
  themePreference: CurrentUser["themePreference"];
  folderZipPromptEnabled: boolean;
  vaultAutoLockMinutes: number;
  trashRetentionDays: number;
  onFileChange(event: ChangeEvent<HTMLInputElement>): void;
  onResetProfileImage(): void;
  onDisplayNameChange(event: ChangeEvent<HTMLInputElement>): void;
  onThemePreferenceChange(value: string): void;
  onAccentColorChange(value: string): void;
  onFolderZipPromptEnabledChange(value: boolean): void;
  onVaultAutoLockMinutesChange(
    value: ReturnType<typeof normalizeVaultAutoLockMinutes>,
  ): void;
  onTrashRetentionDaysChange(value: number): void;
}) {
  return (
    <form
      action="/api/profile"
      method="post"
      encType="multipart/form-data"
      className="w-full"
      onSubmit={preventSettingsSubmit}
    >
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <input
        type="hidden"
        name="remove_profile_image"
        value={removeImage ? "1" : "0"}
      />
      <input type="hidden" name="theme_preference" value={themePreference} />
      <input
        type="hidden"
        name="folder_zip_prompt_enabled"
        value={folderZipPromptEnabled ? "1" : "0"}
      />
      <input
        type="hidden"
        name="vault_auto_lock_minutes"
        value={vaultAutoLockMinutes}
      />
      <input
        type="hidden"
        name="trash_retention_days"
        value={trashRetentionDays}
      />

      <SettingsSection title="Profile" description="Photo and display name">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <div className="group relative w-fit shrink-0">
            <Button
              type="button"
              variant="ghost"
              className="group/photo relative size-24 rounded-full p-0 hover:bg-transparent"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Change profile image"
              title="Change profile image"
            >
              <Avatar className="size-24 bg-primary/10">
                {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
                <AvatarFallback className="bg-primary/10 text-xl font-semibold text-primary">
                  {getInitials(profileName)}
                </AvatarFallback>
              </Avatar>
              <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-full bg-background/60 opacity-0 transition-opacity group-hover/photo:opacity-100 group-focus-visible/photo:opacity-100">
                <Pencil className="size-5" aria-hidden="true" />
              </span>
            </Button>

            {avatarUrl ? (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="absolute -bottom-1 -right-1 z-20 shadow-sm"
                onClick={onResetProfileImage}
                aria-label="Remove profile image"
                title="Remove profile image"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>

          <input
            id={fileInputId}
            ref={fileInputRef}
            name="profile_image"
            type="file"
            aria-label="Choose a profile image"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            tabIndex={-1}
            onChange={onFileChange}
          />

          <div className="grid w-full max-w-md gap-2">
            <Label htmlFor={displayNameId}>Name</Label>
            <Input
              id={displayNameId}
              name="display_name"
              value={displayNameDraft}
              placeholder={currentUser.username}
              maxLength={80}
              className="h-10"
              onChange={onDisplayNameChange}
            />
            <p className="text-xs text-muted-foreground">
              PNG, JPG, WebP, or GIF. Maximum 2 MB.
            </p>
          </div>
        </div>
      </SettingsSection>

      <Separator />

      <SettingsSection title="Trash" description="Automatic deletion">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <Label id={trashRetentionId}>Delete items after</Label>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Items are permanently deleted after this many days in Trash.
            </p>
          </div>
          <Select
            value={String(trashRetentionDays)}
            onValueChange={(value) => onTrashRetentionDaysChange(Number(value))}
          >
            <SelectTrigger
              className="h-10 w-full min-w-40 sm:w-44"
              aria-labelledby={trashRetentionId}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRASH_RETENTION_OPTIONS.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  After {days} {days === 1 ? "day" : "days"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SettingsSection>

      <Separator />

      <SettingsSection title="Account" description="Identity and access">
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
          <AccountDetail label="Username">
            <span className="font-mono text-sm">{currentUser.username}</span>
          </AccountDetail>
          <AccountDetail label="Role">
            <Badge variant="outline" className="capitalize">
              {currentUser.role}
            </Badge>
          </AccountDetail>
          <AccountDetail label="Status">
            <Badge className="capitalize">{currentUser.status}</Badge>
          </AccountDetail>
        </dl>
        <div className="mt-6 flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Login password</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Changing it signs this account out on every device.
            </p>
          </div>
          <ChangePasswordDialog
            csrfToken={csrfToken}
            currentUser={currentUser}
          />
        </div>
      </SettingsSection>

      <Separator />

      <AppearanceSettingsSection
        currentUser={currentUser}
        themeLabelId={themeLabelId}
        accentLabelId={accentLabelId}
        themePreference={themePreference}
        onThemePreferenceChange={onThemePreferenceChange}
        onAccentColorChange={onAccentColorChange}
      />

      <Separator />

      {currentUser.e2eeMode === "migrate" ? (
        <>
          <SettingsSection
            title="Encrypted files"
            description="Convert existing content"
          >
            <VaultMigrationControl csrfToken={csrfToken} />
          </SettingsSection>
          <Separator />
        </>
      ) : null}

      <SettingsSection
        title="Security"
        description="Encrypted-file access and uploads"
      >
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <Label id={vaultAutoLockId}>Automatic lock</Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Require your{" "}
                {currentUser.onePasswordEnabled ? "account" : "vault"} password
                again to access encrypted files after inactivity.
              </p>
            </div>
            <Select
              value={String(vaultAutoLockMinutes)}
              onValueChange={(value) =>
                onVaultAutoLockMinutesChange(
                  normalizeVaultAutoLockMinutes(Number(value)),
                )
              }
            >
              <SelectTrigger
                className="h-10 w-full min-w-40 sm:w-44"
                aria-labelledby={vaultAutoLockId}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VAULT_AUTO_LOCK_OPTIONS.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    After {minutes} minutes
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <Label htmlFor={folderZipPromptId}>
                Ask how to upload folders
              </Label>
              <p
                id={`${folderZipPromptId}-description`}
                className="mt-1 text-xs leading-5 text-muted-foreground"
              >
                Choose between a browsable folder structure and one client-side
                ZIP archive.
              </p>
            </div>
            <Switch
              id={folderZipPromptId}
              checked={folderZipPromptEnabled}
              onCheckedChange={onFolderZipPromptEnabledChange}
              aria-describedby={`${folderZipPromptId}-description`}
            />
          </div>
        </div>
      </SettingsSection>

      <div
        className="flex min-h-16 items-center justify-end gap-3 border-t py-5"
        aria-live="polite"
      >
        {saveError ? (
          <p className="text-sm text-destructive" role="alert">
            {saveError}
          </p>
        ) : saveState === "saving" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Saving...
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            {saveState === "saved" ? (
              <Check className="size-4 text-primary" aria-hidden="true" />
            ) : null}
            {saveState === "saved"
              ? "Saved automatically"
              : "Changes save automatically"}
          </p>
        )}
      </div>
    </form>
  );
}

function ChangePasswordDialog({
  csrfToken,
  currentUser,
}: {
  csrfToken: string;
  currentUser: CurrentUser;
}) {
  const currentPasswordId = useId();
  const newPasswordId = useId();
  const confirmPasswordId = useId();
  const changingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [isChanging, setIsChanging] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);

  function changeOpen(nextOpen: boolean) {
    if (!isChanging) {
      setOpen(nextOpen);
      if (!nextOpen) {
        setChangeError(null);
      }
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (changingRef.current) {
      return;
    }

    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("current_password") ?? "");
    const newPassword = String(data.get("new_password") ?? "");
    const confirmPassword = String(data.get("confirm_password") ?? "");
    const newPasswordBytes = new TextEncoder().encode(newPassword).byteLength;

    if (newPassword !== confirmPassword) {
      setChangeError("The new passwords do not match.");
      return;
    }
    if (newPasswordBytes < 12 || newPasswordBytes > 128) {
      setChangeError("Use a new password between 12 and 128 bytes.");
      return;
    }
    if (currentPassword === newPassword) {
      setChangeError("Choose a password different from the current one.");
      return;
    }

    changingRef.current = true;
    setIsChanging(true);
    setChangeError(null);

    try {
      let path = "/api/profile/password";
      let body: object = { currentPassword, newPassword };
      if (currentUser.onePasswordEnabled) {
        const client = new VaultCryptoClient();
        try {
          const authInfo = await getAccountAuthInfo(currentUser.username);
          const currentCredential = await client.deriveAuthCredential(
            currentUser.username,
            currentPassword,
            authInfo.salt,
          );
          const newSalt = toBase64Url(randomBytes(16));
          const newCredential = await client.deriveAuthCredential(
            currentUser.username,
            newPassword,
            newSalt,
          );
          const vault = currentUser.vaultConfigured
            ? await client.rewrapPassword(
                currentPassword,
                newPassword,
                await getUnlockMaterial(),
              )
            : undefined;
          path = "/api/vault/change-one-password";
          body = { currentCredential, newCredential, newSalt, vault };
        } finally {
          await client.close();
        }
      }

      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(getPasswordChangeError(response.status, detail));
      }

      window.location.assign("/login?password=changed");
    } catch (error) {
      changingRef.current = false;
      setChangeError(
        error instanceof Error
          ? error.message
          : "The password could not be changed.",
      );
      setIsChanging(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <KeyRound className="size-4" aria-hidden="true" />
          Change password
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form className="contents" onSubmit={changePassword}>
          <DialogHeader>
            <DialogTitle>Change login password</DialogTitle>
            <DialogDescription>
              Enter your current password and choose a new one. You will need to
              sign in again afterward.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor={currentPasswordId}>Current password</Label>
              <Input
                id={currentPasswordId}
                name="current_password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                disabled={isChanging}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={newPasswordId}>New password</Label>
              <Input
                id={newPasswordId}
                name="new_password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                aria-describedby={`${newPasswordId}-hint`}
                disabled={isChanging}
              />
              <p
                id={`${newPasswordId}-hint`}
                className="text-xs text-muted-foreground"
              >
                Use 12 to 128 bytes and do not reuse the current password.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={confirmPasswordId}>Confirm new password</Label>
              <Input
                id={confirmPasswordId}
                name="confirm_password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                disabled={isChanging}
              />
            </div>
            {changeError ? (
              <p className="text-sm text-destructive" role="alert">
                {changeError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isChanging}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isChanging}>
              {isChanging ? (
                <LoaderCircle
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <KeyRound className="size-4" aria-hidden="true" />
              )}
              {isChanging ? "Changing..." : "Change password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function getPasswordChangeError(status: number, detail: string) {
  if (detail.includes("current password is incorrect")) {
    return "The current password is incorrect.";
  }
  if (detail.includes("new password must be different")) {
    return "Choose a password different from the current one.";
  }
  if (detail.includes("12 to 72 bytes")) {
    return "Use a new password between 12 and 72 bytes.";
  }
  if (detail.includes("vault password material")) {
    return "The encrypted vault changed. Sign in again and retry.";
  }
  if (status === 409) {
    return "The password changed in another session. Sign in again and retry.";
  }
  if (status === 429) {
    return "Too many password attempts. Wait a moment and try again.";
  }

  return "The password could not be changed.";
}

function AppearanceSettingsSection({
  currentUser,
  themeLabelId,
  accentLabelId,
  themePreference,
  onThemePreferenceChange,
  onAccentColorChange,
}: {
  currentUser: CurrentUser;
  themeLabelId: string;
  accentLabelId: string;
  themePreference: CurrentUser["themePreference"];
  onThemePreferenceChange(value: string): void;
  onAccentColorChange(value: string): void;
}) {
  return (
    <SettingsSection title="Appearance" description="Theme and accent color">
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <Label id={themeLabelId}>Theme</Label>
          <ToggleGroup
            type="single"
            value={themePreference}
            onValueChange={onThemePreferenceChange}
            aria-labelledby={themeLabelId}
            className="w-full rounded-full border bg-muted/40 p-1 sm:w-auto"
          >
            <ToggleGroupItem
              type="button"
              value="system"
              aria-label="Use system theme"
              className="flex-1 rounded-full px-3 data-[state=on]:bg-background data-[state=on]:shadow-none dark:data-[state=on]:shadow-sm sm:flex-none"
            >
              <Monitor className="size-4" aria-hidden="true" />
              System
            </ToggleGroupItem>
            <ToggleGroupItem
              type="button"
              value="light"
              aria-label="Use light theme"
              className="flex-1 rounded-full px-3 data-[state=on]:bg-background data-[state=on]:shadow-none dark:data-[state=on]:shadow-sm sm:flex-none"
            >
              <Sun className="size-4" aria-hidden="true" />
              Light
            </ToggleGroupItem>
            <ToggleGroupItem
              type="button"
              value="dark"
              aria-label="Use dark theme"
              className="flex-1 rounded-full px-3 data-[state=on]:bg-background data-[state=on]:shadow-none dark:data-[state=on]:shadow-sm sm:flex-none"
            >
              <Moon className="size-4" aria-hidden="true" />
              Dark
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <Separator />

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <Label id={accentLabelId}>Accent color</Label>
          <AccentColorPreference
            initialColor={currentUser.accentColor}
            inputName="accent_color"
            labelId={accentLabelId}
            onColorChange={onAccentColorChange}
          />
        </div>
      </div>
    </SettingsSection>
  );
}

function mergeSettingsUpdates(
  current: ProfileSettingsUpdate | null,
  update: ProfileSettingsUpdate,
): ProfileSettingsUpdate {
  return { ...(current ?? {}), ...update };
}

function createProfileSettingsFormData(
  csrfToken: string,
  update: ProfileSettingsUpdate,
) {
  const formData = new FormData();
  formData.append("csrf_token", csrfToken);

  if (update.displayName !== undefined) {
    formData.append("display_name", update.displayName);
  }
  if (update.themePreference !== undefined) {
    formData.append("theme_preference", update.themePreference);
  }
  if (update.accentColor !== undefined) {
    formData.append("accent_color", update.accentColor);
  }
  if (update.folderZipPromptEnabled !== undefined) {
    formData.append(
      "folder_zip_prompt_enabled",
      update.folderZipPromptEnabled ? "1" : "0",
    );
  }
  if (update.vaultAutoLockMinutes !== undefined) {
    formData.append(
      "vault_auto_lock_minutes",
      String(update.vaultAutoLockMinutes),
    );
  }
  if (update.trashRetentionDays !== undefined) {
    formData.append("trash_retention_days", String(update.trashRetentionDays));
  }
  if (update.profileImage === null) {
    formData.append("remove_profile_image", "1");
  } else if (update.profileImage) {
    formData.append("profile_image", update.profileImage);
  }

  return formData;
}

function normalizeTrashRetentionDays(value: number): number {
  return TRASH_RETENTION_OPTIONS.includes(
    value as (typeof TRASH_RETENTION_OPTIONS)[number],
  )
    ? value
    : 30;
}

function preventSettingsSubmit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
}

function getProfileSaveError(result: string | null) {
  if (result === "invalid-image") {
    return "Choose a PNG, JPG, WebP, or GIF image.";
  }

  if (result === "image-too-large") {
    return "The profile image must be 2 MB or smaller.";
  }

  return "Settings could not be saved.";
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-5 py-8 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-10">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function AccountDetail({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="mb-2 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-h-5 items-center">{children}</dd>
    </div>
  );
}

function getInitials(value: string) {
  const initials = value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return initials || "A";
}
