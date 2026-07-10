"use client";

import {
  LoaderCircle,
  Monitor,
  Moon,
  Pencil,
  RotateCcw,
  Save,
  Sun,
  Undo2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { AccentColorPreference } from "@/features/dashboard/accent-color-preference";
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { setTheme } = useTheme();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [themePreference, setThemePreference] = useState(
    currentUser.themePreference,
  );
  const [folderZipPromptEnabled, setFolderZipPromptEnabled] = useState(
    currentUser.folderZipPromptEnabled !== false,
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

      router.refresh();
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Settings could not be saved.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form
      action="/api/profile"
      method="post"
      encType="multipart/form-data"
      className="w-full"
      onSubmit={saveSettings}
    >
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <input
        type="hidden"
        name="remove_profile_image"
        value={removeImage ? "1" : "0"}
      />
      <input
        type="hidden"
        name="theme_preference"
        value={themePreference}
      />
      <input
        type="hidden"
        name="folder_zip_prompt_enabled"
        value={folderZipPromptEnabled ? "1" : "0"}
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
                onClick={removeImage ? restoreProfileImage : resetProfileImage}
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
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            tabIndex={-1}
            onChange={handleFileChange}
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
      </SettingsSection>

      <Separator />

      <SettingsSection title="Appearance" description="Theme and accent color">
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <Label id={themeLabelId}>Theme</Label>
            <ToggleGroup
              type="single"
              value={themePreference}
              onValueChange={updateThemePreference}
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

      <Separator />

      <SettingsSection title="Uploads" description="Folder handling">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <Label htmlFor={folderZipPromptId}>Ask how to upload folders</Label>
            <p
              id={`${folderZipPromptId}-description`}
              className="mt-1 text-xs leading-5 text-muted-foreground"
            >
              Choose between a browsable folder structure and one client-side ZIP archive.
            </p>
          </div>
          <Switch
            id={folderZipPromptId}
            checked={folderZipPromptEnabled}
            onCheckedChange={setFolderZipPromptEnabled}
            aria-describedby={`${folderZipPromptId}-description`}
          />
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
