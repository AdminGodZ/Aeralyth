"use client";

import {
  Ban,
  Check,
  ChevronRight,
  Clipboard,
  Clock3,
  Ellipsis,
  KeyRound,
  MailPlus,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useId, useState, useSyncExternalStore } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  AdminUser,
  AdminUsersState,
  CurrentUser,
  Invitation,
} from "@/lib/api";

const adminDateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

type UsersContentProps = {
  currentUser: CurrentUser;
  csrfToken: string;
  adminUsersState?: AdminUsersState;
  invitationToken?: string;
  initialQuery?: string;
};

export function UsersContent({
  currentUser,
  csrfToken,
  adminUsersState,
  invitationToken,
  initialQuery = "",
}: UsersContentProps) {
  const [activeTab, setActiveTab] = useState("accounts");
  const [query, setQuery] = useState(initialQuery);

  if (!adminUsersState || adminUsersState.status === "unavailable") {
    return (
      <div className="flex flex-1 flex-col px-4 py-5 sm:px-6">
        <Alert className="max-w-2xl">
          <Users className="size-4" aria-hidden="true" />
          <AlertTitle>Users unavailable</AlertTitle>
          <AlertDescription>
            The admin users API is not reachable.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (adminUsersState.status !== "ready") {
    return null;
  }

  const {
    invitations,
    invitationsHasMore,
    invitationsNextCursor,
    summary,
    users,
    usersHasMore,
    usersNextCursor,
  } = adminUsersState.data;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredUsers = normalizedQuery
    ? users.filter((user) =>
        [user.username, user.displayName ?? "", user.role, user.status].some(
          (value) => value.toLowerCase().includes(normalizedQuery),
        ),
      )
    : users;
  const filteredInvitations = normalizedQuery
    ? invitations.filter((invitation) =>
        [
          invitation.invitedUsername,
          invitation.role,
          invitation.status,
          invitation.createdByUsername,
        ].some((value) => value.toLowerCase().includes(normalizedQuery)),
      )
    : invitations;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 py-5 sm:px-6">
      <InvitationLinkDialog token={invitationToken} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <DirectoryMetric
          icon={Users}
          label="Accounts"
          value={summary.totalUsers}
        />
        <DirectoryMetric
          icon={UserCheck}
          label="Active"
          value={summary.activeUsers}
        />
        <DirectoryMetric
          icon={ShieldCheck}
          label="Admins"
          value={summary.admins}
        />
        <DirectoryMetric
          icon={MailPlus}
          label="Pending"
          value={summary.pendingInvites}
        />
      </div>

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="min-h-0 gap-0 overflow-hidden rounded-md border"
      >
        <div className="flex flex-col gap-3 border-b px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
          <TabsList variant="line" className="justify-start">
            <TabsTrigger value="accounts">
              Accounts
              <Badge variant="secondary">{users.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="invitations">
              Invitations
              <Badge variant="secondary">{invitations.length}</Badge>
            </TabsTrigger>
          </TabsList>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <form action="/users" method="get" className="flex gap-2">
              <div className="relative min-w-0 sm:w-72">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  name="q"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={
                    activeTab === "accounts"
                      ? "Search accounts"
                      : "Search invitations"
                  }
                  aria-label={
                    activeTab === "accounts"
                      ? "Search accounts"
                      : "Search invitations"
                  }
                  className="h-9 pl-9"
                />
              </div>
              <Button type="submit" variant="outline" size="sm">
                Search
              </Button>
            </form>
            <div className="flex gap-2">
              <InviteUserDialog csrfToken={csrfToken} />
              <CreateUserDialog csrfToken={csrfToken} />
            </div>
          </div>
        </div>

        <TabsContent value="accounts" className="m-0 min-h-0">
          <AccountsTable
            users={filteredUsers}
            currentUserId={currentUser.id}
            csrfToken={csrfToken}
          />
          <DirectoryPager
            cursor={usersNextCursor}
            hasMore={usersHasMore}
            cursorKey="usersCursor"
            query={initialQuery}
          />
        </TabsContent>

        <TabsContent value="invitations" className="m-0 min-h-0">
          <InvitationsTable
            invitations={filteredInvitations}
            csrfToken={csrfToken}
          />
          <DirectoryPager
            cursor={invitationsNextCursor}
            hasMore={invitationsHasMore}
            cursorKey="invitationsCursor"
            query={initialQuery}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DirectoryPager({
  cursor,
  hasMore,
  cursorKey,
  query,
}: {
  cursor: string | null;
  hasMore: boolean;
  cursorKey: "usersCursor" | "invitationsCursor";
  query?: string;
}) {
  if (!hasMore || !cursor) {
    return null;
  }

  return (
    <div className="flex justify-end border-t px-4 py-3">
      <Button asChild variant="outline" size="sm">
        <Link
          href={{
            pathname: "/users",
            query: {
              ...(query ? { q: query } : {}),
              [cursorKey]: cursor,
            },
          }}
        >
          Next page
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      </Button>
    </div>
  );
}

function DirectoryMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Users;
  label: string;
  value: number;
}) {
  return (
    <div className="flex min-h-20 items-center gap-3 rounded-md border px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="mt-0.5 font-display text-xl font-semibold tabular-nums">
          {value}
        </p>
      </div>
    </div>
  );
}

function AccountsTable({
  users,
  currentUserId,
  csrfToken,
}: {
  users: AdminUser[];
  currentUserId: string;
  csrfToken: string;
}) {
  return (
    <Table className="min-w-[760px]">
      <TableHeader className="bg-muted/35">
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[42%] px-4">Account</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="w-16 px-4 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.length ? (
          users.map((user) => {
            const isCurrentUser = user.id === currentUserId;
            const displayName = user.displayName?.trim() || user.username;

            return (
              <TableRow key={user.id}>
                <TableCell className="px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar>
                      {user.profileImageUrl ? (
                        <AvatarImage src={user.profileImageUrl} alt="" />
                      ) : null}
                      <AvatarFallback className="bg-primary/10 font-medium text-primary">
                        {getInitials(displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">
                          {displayName}
                        </span>
                        {isCurrentUser ? (
                          <Badge variant="outline">You</Badge>
                        ) : null}
                      </div>
                      {displayName !== user.username ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {user.username}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <RoleBadge role={user.role} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={user.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(user.createdAt)}
                </TableCell>
                <TableCell className="px-4 text-right">
                  <UserActions
                    user={user}
                    csrfToken={csrfToken}
                    isCurrentUser={isCurrentUser}
                  />
                </TableCell>
              </TableRow>
            );
          })
        ) : (
          <TableRow>
            <TableCell colSpan={5} className="h-40 text-center">
              <p className="font-medium">No matching accounts</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Try a different search.
              </p>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function InvitationsTable({
  invitations,
  csrfToken,
}: {
  invitations: Invitation[];
  csrfToken: string;
}) {
  return (
    <Table className="min-w-[800px]">
      <TableHeader className="bg-muted/35">
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[34%] px-4">Invitation</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created by</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead className="w-16 px-4 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invitations.length ? (
          invitations.map((invitation) => (
            <TableRow key={invitation.id}>
              <TableCell className="px-4 py-3 font-medium">
                {invitation.invitedUsername}
              </TableCell>
              <TableCell>
                <RoleBadge role={invitation.role} />
              </TableCell>
              <TableCell>
                <InvitationStatusBadge status={invitation.status} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {invitation.createdByUsername}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(invitation.expiresAt)}
              </TableCell>
              <TableCell className="px-4 text-right">
                <InvitationActions
                  invitation={invitation}
                  csrfToken={csrfToken}
                />
              </TableCell>
            </TableRow>
          ))
        ) : (
          <TableRow>
            <TableCell colSpan={6} className="h-40 text-center">
              <p className="font-medium">No matching invitations</p>
              <p className="mt-1 text-sm text-muted-foreground">
                New invitations will appear here.
              </p>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function CreateUserDialog({ csrfToken }: { csrfToken: string }) {
  const usernameId = useId();
  const passwordId = useId();
  const roleId = useId();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <UserPlus className="size-4" aria-hidden="true" />
          Create account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form action="/api/admin/users" method="post" className="contents">
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <DialogHeader>
            <DialogTitle>Create account</DialogTitle>
            <DialogDescription>
              Add an account with a temporary password.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor={usernameId}>Username</Label>
              <Input
                id={usernameId}
                name="username"
                autoComplete="off"
                required
                minLength={3}
                maxLength={32}
                pattern="[A-Za-z0-9_.-]{3,32}"
                placeholder="username"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={passwordId}>Temporary password</Label>
              <Input
                id={passwordId}
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>
            <div className="grid gap-2">
              <Label id={roleId}>Role</Label>
              <Select name="role" defaultValue="user">
                <SelectTrigger className="w-full" aria-labelledby={roleId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">
              <UserPlus className="size-4" aria-hidden="true" />
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InviteUserDialog({ csrfToken }: { csrfToken: string }) {
  const usernameId = useId();
  const roleId = useId();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button">
          <MailPlus className="size-4" aria-hidden="true" />
          Invite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          action="/api/admin/invitations"
          method="post"
          className="contents"
        >
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <DialogHeader>
            <DialogTitle>Create invitation</DialogTitle>
            <DialogDescription>
              Generate a seven-day account setup link.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor={usernameId}>Username</Label>
              <Input
                id={usernameId}
                name="username"
                autoComplete="off"
                required
                minLength={3}
                maxLength={32}
                pattern="[A-Za-z0-9_.-]{3,32}"
                placeholder="username"
              />
            </div>
            <div className="grid gap-2">
              <Label id={roleId}>Role</Label>
              <Select name="role" defaultValue="user">
                <SelectTrigger className="w-full" aria-labelledby={roleId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">
              <MailPlus className="size-4" aria-hidden="true" />
              Generate link
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UserActions({
  user,
  csrfToken,
  isCurrentUser,
}: {
  user: AdminUser;
  csrfToken: string;
  isCurrentUser: boolean;
}) {
  const statusFormId = useId();
  const deleteFormId = useId();
  const [editOpen, setEditOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const nextStatus = user.status === "active" ? "disabled" : "active";

  return (
    <>
      <form
        id={statusFormId}
        action={`/api/admin/users/${user.id}/status`}
        method="post"
        className="hidden"
      >
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <input type="hidden" name="status" value={nextStatus} />
      </form>
      <form
        id={deleteFormId}
        action={`/api/admin/users/${user.id}/delete`}
        method="post"
        className="hidden"
      >
        <input type="hidden" name="csrf_token" value={csrfToken} />
      </form>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="rounded-md"
            aria-label={`Manage ${user.username}`}
            title={`Manage ${user.username}`}
          >
            <Ellipsis className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>Account actions</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => {
              setEditOpen(true);
            }}
          >
            <Pencil className="size-4" aria-hidden="true" />
            Edit account
          </DropdownMenuItem>
          {!isCurrentUser ? (
            <>
              <DropdownMenuSeparator />
              {nextStatus === "active" ? (
                <DropdownMenuItem asChild>
                  <button type="submit" form={statusFormId} className="w-full">
                    <UserCheck className="size-4" aria-hidden="true" />
                    Enable account
                  </button>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onSelect={() => {
                    setDisableOpen(true);
                  }}
                >
                  <Ban className="size-4" aria-hidden="true" />
                  Disable account
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  setDeleteOpen(true);
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Delete account
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <EditUserDialog
        user={user}
        csrfToken={csrfToken}
        isCurrentUser={isCurrentUser}
        open={editOpen}
        onOpenChange={setEditOpen}
      />

      <AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Ban className="size-7 text-destructive" aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>Disable {user.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              This account will no longer be able to sign in until it is enabled
              again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="submit"
              form={statusFormId}
              variant="secondary"
              className="text-destructive hover:text-destructive"
            >
              Disable account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 className="size-7 text-destructive" aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete {user.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the account, its sessions, shared data,
              and all files owned by this user. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="submit"
              form={deleteFormId}
              variant="secondary"
              className="text-destructive hover:text-destructive"
            >
              Delete account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function EditUserDialog({
  user,
  csrfToken,
  isCurrentUser,
  open,
  onOpenChange,
}: {
  user: AdminUser;
  csrfToken: string;
  isCurrentUser: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const displayNameId = useId();
  const usernameId = useId();
  const roleId = useId();
  const statusId = useId();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          action={`/api/admin/users/${user.id}`}
          method="post"
          className="contents"
        >
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <DialogHeader>
            <DialogTitle>Edit account</DialogTitle>
            <DialogDescription>
              Update this account&apos;s identity and access settings.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor={displayNameId}>Name</Label>
              <Input
                id={displayNameId}
                name="display_name"
                defaultValue={user.displayName ?? ""}
                maxLength={80}
                placeholder={user.username}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={usernameId}>Username</Label>
              <Input
                id={usernameId}
                name="username"
                defaultValue={user.username}
                autoComplete="off"
                required
                minLength={3}
                maxLength={32}
                pattern="[A-Za-z0-9_.-]{3,32}"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label id={roleId}>Role</Label>
                <Select
                  name={isCurrentUser ? undefined : "role"}
                  defaultValue={user.role}
                  disabled={isCurrentUser}
                >
                  <SelectTrigger className="w-full" aria-labelledby={roleId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
                {isCurrentUser ? (
                  <input type="hidden" name="role" value={user.role} />
                ) : null}
              </div>
              <div className="grid gap-2">
                <Label id={statusId}>Status</Label>
                <Select
                  name={isCurrentUser ? undefined : "status"}
                  defaultValue={user.status}
                  disabled={isCurrentUser}
                >
                  <SelectTrigger className="w-full" aria-labelledby={statusId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="disabled">Disabled</SelectItem>
                  </SelectContent>
                </Select>
                {isCurrentUser ? (
                  <input type="hidden" name="status" value={user.status} />
                ) : null}
              </div>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">
              <Pencil className="size-4" aria-hidden="true" />
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InvitationActions({
  invitation,
  csrfToken,
}: {
  invitation: Invitation;
  csrfToken: string;
}) {
  const rotateFormId = useId();
  const revokeFormId = useId();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const canRegenerate = invitation.status !== "accepted";
  const canRevoke = invitation.status === "pending";

  if (!canRegenerate && !canRevoke) {
    return <span className="text-muted-foreground">-</span>;
  }

  return (
    <>
      <form
        id={rotateFormId}
        action={`/api/admin/invitations/${invitation.id}/rotate`}
        method="post"
        className="hidden"
      >
        <input type="hidden" name="csrf_token" value={csrfToken} />
      </form>
      <form
        id={revokeFormId}
        action={`/api/admin/invitations/${invitation.id}/revoke`}
        method="post"
        className="hidden"
      >
        <input type="hidden" name="csrf_token" value={csrfToken} />
      </form>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="rounded-md"
            aria-label={`Manage invitation for ${invitation.invitedUsername}`}
          >
            <Ellipsis className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>Invitation actions</DropdownMenuLabel>
          {canRegenerate ? (
            <DropdownMenuItem asChild>
              <button type="submit" form={rotateFormId} className="w-full">
                <RefreshCw className="size-4" aria-hidden="true" />
                Generate new link
              </button>
            </DropdownMenuItem>
          ) : null}
          {canRevoke ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={(event) => {
                  event.preventDefault();
                  setRevokeOpen(true);
                }}
              >
                <Ban className="size-4" aria-hidden="true" />
                Revoke invitation
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Ban className="size-7 text-destructive" aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              The setup link for {invitation.invitedUsername} will stop working
              immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="submit"
              form={revokeFormId}
              variant="secondary"
              className="text-destructive hover:text-destructive"
            >
              Revoke invitation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function InvitationLinkDialog({ token }: { token?: string }) {
  const [open, setOpen] = useState(Boolean(token));
  const origin = useSyncExternalStore(
    subscribeToOrigin,
    getBrowserOrigin,
    getServerOrigin,
  );
  const [copied, setCopied] = useState(false);

  if (!token) {
    return null;
  }

  const path = `/invite/${encodeURIComponent(token)}`;
  const link = origin ? `${origin}${path}` : path;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);

        if (!nextOpen) {
          window.history.replaceState(null, "", "/users");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invitation link ready</DialogTitle>
          <DialogDescription>
            This link expires in seven days and can be used once.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 gap-2">
          <Input
            value={link}
            readOnly
            aria-label="Invitation link"
            className="min-w-0 font-mono text-xs"
          />
          <Button type="button" onClick={copyLink}>
            {copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Clipboard className="size-4" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

function subscribeToOrigin(): () => void {
  return () => undefined;
}

function getBrowserOrigin(): string {
  return window.location.origin;
}

function getServerOrigin(): string {
  return "";
}

function RoleBadge({ role }: { role: AdminUser["role"] }) {
  return (
    <Badge variant={role === "admin" ? "default" : "outline"}>
      {role === "admin" ? (
        <ShieldCheck className="size-3" aria-hidden="true" />
      ) : null}
      <span className="capitalize">{role}</span>
    </Badge>
  );
}

function StatusBadge({ status }: { status: AdminUser["status"] }) {
  return (
    <Badge variant={status === "active" ? "secondary" : "destructive"}>
      <span
        className={
          status === "active"
            ? "size-1.5 rounded-full bg-emerald-500"
            : "size-1.5 rounded-full bg-current"
        }
        aria-hidden="true"
      />
      <span className="capitalize">{status}</span>
    </Badge>
  );
}

function InvitationStatusBadge({ status }: { status: Invitation["status"] }) {
  if (status === "pending") {
    return (
      <Badge variant="secondary">
        <Clock3 className="size-3" aria-hidden="true" />
        Pending
      </Badge>
    );
  }

  if (status === "accepted") {
    return (
      <Badge variant="secondary">
        <Check className="size-3 text-emerald-500" aria-hidden="true" />
        Accepted
      </Badge>
    );
  }

  return (
    <Badge variant="outline">
      <KeyRound className="size-3" aria-hidden="true" />
      <span className="capitalize">{status}</span>
    </Badge>
  );
}

function getInitials(username: string) {
  const initials = username
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return initials || "A";
}

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return adminDateFormatter.format(date);
}
