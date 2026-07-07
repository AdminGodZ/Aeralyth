"use client";

import { Save, Upload, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useTheme } from "next-themes";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AccentColorPreference } from "@/features/dashboard/accent-color-preference";
import type { CurrentUser } from "@/lib/api";
import { cn } from "@/lib/utils";

type ProfileSettingsFormProps = {
  currentUser: CurrentUser;
  csrfToken: string;
};

export function ProfileSettingsForm({
  currentUser,
  csrfToken,
}: ProfileSettingsFormProps) {
  const fileInputId = useId();
  const themeSelectId = useId();
  const displayNameId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { setTheme } = useTheme();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [themePreference, setThemePreference] = useState(
    currentUser.themePreference,
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

  function removeProfileImage() {
    setRemoveImage(true);

    if (previewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(previewUrl);
    }

    setPreviewUrl(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <form
      action="/api/profile"
      method="post"
      encType="multipart/form-data"
      className="space-y-4"
    >
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <input
        type="hidden"
        name="remove_profile_image"
        value={removeImage ? "1" : "0"}
      />

      <section className="w-full overflow-hidden rounded-md border">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">Profile</p>
        </div>
        <div className="divide-y">
          <div className="grid gap-4 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <p className="text-sm font-medium">Profile image</p>
              <p className="mt-1 text-xs text-muted-foreground">
                PNG, JPG, WebP, or GIF up to 2 MB.
              </p>
            </div>
            <div className="flex min-w-0 items-center gap-3 sm:justify-end">
              <span className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-primary/10 text-sm font-semibold text-primary">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  getInitials(displayName)
                )}
              </span>
              <input
                id={fileInputId}
                ref={fileInputRef}
                name="profile_image"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="sr-only"
                onChange={handleFileChange}
              />
              <Label
                htmlFor={fileInputId}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  "cursor-pointer",
                )}
              >
                <Upload className="size-4" aria-hidden="true" />
                Upload
              </Label>
              {currentUser.profileImageUrl || previewUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={removeProfileImage}
                >
                  <X className="size-4" aria-hidden="true" />
                  Remove
                </Button>
              ) : null}
            </div>
          </div>

          <SettingsFormRow
            label="Name"
            description="Shown in your profile and account controls."
          >
            <Input
              id={displayNameId}
              name="display_name"
              defaultValue={currentUser.displayName ?? ""}
              placeholder={currentUser.username}
              maxLength={80}
              className="h-9 w-full min-w-0 sm:w-64"
            />
          </SettingsFormRow>

          <SettingsFormRow label="Username">
            <span className="text-sm text-muted-foreground">
              {currentUser.username}
            </span>
          </SettingsFormRow>

          <SettingsFormRow label="Role">
            <span className="text-sm capitalize text-muted-foreground">
              {currentUser.role}
            </span>
          </SettingsFormRow>

          <SettingsFormRow label="Status">
            <span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-medium capitalize text-primary">
              {currentUser.status}
            </span>
          </SettingsFormRow>
        </div>
      </section>

      <section className="w-full overflow-hidden rounded-md border">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">Preferences</p>
        </div>
        <div className="divide-y">
          <SettingsFormRow
            label="Appearance"
            description="Saved as your default theme on this account."
          >
            <select
              id={themeSelectId}
              name="theme_preference"
              value={themePreference}
              onChange={(event) => {
                const nextTheme = event.currentTarget.value as
                  | "system"
                  | "light"
                  | "dark";
                setThemePreference(nextTheme);
              }}
              className="h-9 min-w-36 rounded-full border bg-background px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </SettingsFormRow>

          <SettingsFormRow
            label="Accent color"
            description="Saved for buttons, highlights, focus rings, and selected states."
          >
            <AccentColorPreference
              initialColor={currentUser.accentColor}
              inputName="accent_color"
            />
          </SettingsFormRow>
        </div>
      </section>

      <div className="flex justify-end">
        <Button type="submit" size="lg">
          <Save className="size-4" aria-hidden="true" />
          Save changes
        </Button>
      </div>
    </form>
  );
}

function SettingsFormRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description ? (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center sm:justify-end">{children}</div>
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
