"use client";

import {
  KeyRound,
  LoaderCircle,
  Monitor,
  Moon,
  Pencil,
  RotateCcw,
  Save,
  Sun,
  Undo2,
} from "lucide-react";
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
import { AccentColorPreference } from "@/features/dashboard/accent-color-preference";
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

export function ProfileSettingsForm({
  currentUser,
  csrfToken,
}: ProfileSettingsFormProps) {
  const fileInputId = useId();
  const displayNameId = useId();
  const themeLabelId = useId();
  const accentLabelId = useId();
  const folderZipPromptId = useId();
  const vaultAutoLockId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { setTheme } = useTheme();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
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
  const displayName = currentUser.displayName?.trim() || currentUser.username;
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
  }

  function restoreProfileImage() {
    setRemoveImage(false);
  }

  function updateThemePreference(value: string) {
    if (value === "system" || value === "light" || value === "dark") {
      setThemePreference(value);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSaving) {
      return;
    }

    const form = event.currentTarget;
    setIsSaving(true);
    setSaveError(null);

    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
        body: new FormData(form),
        credentials: "same-origin",
      });
      const result = new URL(response.url).searchParams.get("profile");

      if (!response.ok || result !== "updated") {
        throw new Error(getProfileSaveError(result));
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      window.dispatchEvent(
        new CustomEvent(VAULT_AUTO_LOCK_CHANGE_EVENT, {
          detail: vaultAutoLockMinutes,
        }),
      );
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Settings could not be saved.",
      );
    } finally {
      setIsSaving(false);
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
      fileInputRef={fileInputRef}
      avatarUrl={avatarUrl}
      displayName={displayName}
      removeImage={removeImage}
      isSaving={isSaving}
      saveError={saveError}
      themePreference={themePreference}
      folderZipPromptEnabled={folderZipPromptEnabled}
      vaultAutoLockMinutes={vaultAutoLockMinutes}
      onSave={saveSettings}
      onFileChange={handleFileChange}
      onResetProfileImage={resetProfileImage}
      onRestoreProfileImage={restoreProfileImage}
      onThemePreferenceChange={updateThemePreference}
      onFolderZipPromptEnabledChange={setFolderZipPromptEnabled}
      onVaultAutoLockMinutesChange={setVaultAutoLockMinutes}
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
  fileInputRef,
  avatarUrl,
  displayName,
  removeImage,
  isSaving,
  saveError,
  themePreference,
  folderZipPromptEnabled,
  vaultAutoLockMinutes,
  onSave,
  onFileChange,
  onResetProfileImage,
  onRestoreProfileImage,
  onThemePreferenceChange,
  onFolderZipPromptEnabledChange,
  onVaultAutoLockMinutesChange,
}: {
  currentUser: CurrentUser;
  csrfToken: string;
  fileInputId: string;
  displayNameId: string;
  themeLabelId: string;
  accentLabelId: string;
  folderZipPromptId: string;
  vaultAutoLockId: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  avatarUrl: string | null;
  displayName: string;
  removeImage: boolean;
  isSaving: boolean;
  saveError: string | null;
  themePreference: CurrentUser["themePreference"];
  folderZipPromptEnabled: boolean;
  vaultAutoLockMinutes: number;
  onSave(event: FormEvent<HTMLFormElement>): Promise<void>;
  onFileChange(event: ChangeEvent<HTMLInputElement>): void;
  onResetProfileImage(): void;
  onRestoreProfileImage(): void;
  onThemePreferenceChange(value: string): void;
  onFolderZipPromptEnabledChange(value: boolean): void;
  onVaultAutoLockMinutesChange(
    value: ReturnType<typeof normalizeVaultAutoLockMinutes>,
  ): void;
}) {
  return (
    <form
      action="/api/profile"
      method="post"
      encType="multipart/form-data"
      className="w-full"
      onSubmit={onSave}
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
                  {getInitials(displayName)}
                </AvatarFallback>
              </Avatar>
              <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-full bg-background/60 opacity-0 transition-opacity group-hover/photo:opacity-100 group-focus-visible/photo:opacity-100">
                <Pencil className="size-5" aria-hidden="true" />
              </span>
            </Button>

            {avatarUrl || (removeImage && currentUser.profileImageUrl) ? (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="absolute -bottom-1 -right-1 z-20 shadow-sm"
                onClick={
                  removeImage ? onRestoreProfileImage : onResetProfileImage
                }
                aria-label={
                  removeImage
                    ? "Undo profile image reset"
                    : "Reset profile image"
                }
                title={
                  removeImage
                    ? "Undo profile image reset"
                    : "Reset profile image"
                }
              >
                {removeImage ? (
                  <Undo2 className="size-4" aria-hidden="true" />
                ) : (
                  <RotateCcw className="size-4" aria-hidden="true" />
                )}
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
              defaultValue={currentUser.displayName ?? ""}
              placeholder={currentUser.username}
              maxLength={80}
              className="h-10"
            />
            <p className="text-xs text-muted-foreground">
              PNG, JPG, WebP, or GIF. Maximum 2 MB.
            </p>
          </div>
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
          <ChangePasswordDialog csrfToken={csrfToken} />
        </div>
      </SettingsSection>

      <Separator />

      <AppearanceSettingsSection
        currentUser={currentUser}
        themeLabelId={themeLabelId}
        accentLabelId={accentLabelId}
        themePreference={themePreference}
        onThemePreferenceChange={onThemePreferenceChange}
      />

      <Separator />

      {currentUser.e2eeMode === "migrate" ? (
        <>
          <SettingsSection
            title="Encrypted vault"
            description="Convert existing content"
          >
            <VaultMigrationControl csrfToken={csrfToken} />
          </SettingsSection>
          <Separator />
        </>
      ) : null}

      <SettingsSection title="Security" description="Vault and upload behavior">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <Label id={vaultAutoLockId}>Lock encrypted vault</Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Require the vault password again after a period without
                activity.
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

      <div className="flex min-h-20 items-center justify-end gap-3 border-t py-5">
        {saveError ? (
          <p className="text-sm text-destructive" role="alert">
            {saveError}
          </p>
        ) : null}
        <Button type="submit" size="lg" disabled={isSaving}>
          {isSaving ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="size-4" aria-hidden="true" />
          )}
          {isSaving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function ChangePasswordDialog({ csrfToken }: { csrfToken: string }) {
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
    if (newPasswordBytes < 12 || newPasswordBytes > 72) {
      setChangeError("Use a new password between 12 and 72 bytes.");
      return;
    }

    changingRef.current = true;
    setIsChanging(true);
    setChangeError(null);

    try {
      const response = await fetch("/api/profile/password", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
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
                maxLength={72}
                aria-describedby={`${newPasswordId}-hint`}
                disabled={isChanging}
              />
              <p
                id={`${newPasswordId}-hint`}
                className="text-xs text-muted-foreground"
              >
                Use 12 to 72 bytes and do not reuse the current password.
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
                maxLength={72}
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
}: {
  currentUser: CurrentUser;
  themeLabelId: string;
  accentLabelId: string;
  themePreference: CurrentUser["themePreference"];
  onThemePreferenceChange(value: string): void;
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
          />
        </div>
      </div>
    </SettingsSection>
  );
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
