"use client";

import { useCallback, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDialogs } from "@/components/ui/dialog-manager";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { useZodForm } from "@/lib/forms/use-zod-form";
import { createInvitationSchema, type CreateInvitationInput } from "@/lib/validation/invitations";
import { DataGrid } from "../../_components/grid/data-grid";

/**
 * Invitations panel on the organization detail's Members tab (0008).
 *
 * Reuses the shared `DataGrid` over
 * `/api/administrator/organizations/:id/invitations`; the header hosts the
 * "Invite member" dialog (email + optional org-scoped role). Row actions:
 * resend (rotates the token + expiry in place — the old link dies) and
 * revoke, both pending-only.
 */
interface InvitationRow {
  id: string;
  email: string;
  status: string;
  role_name: string | null;
  invited_by_display_name: string | null;
  expires_at: string;
}

interface RoleOption {
  id: string;
  name: string;
}

const NO_ROLE = "__none__";

export function OrganizationInvitationsPanel({
  orgId,
  canUpdate,
}: {
  orgId: string;
  canUpdate: boolean;
}) {
  const t = useTranslations("administrator.orgs.invitations");
  const tErr = useTranslations("administrator.errors");
  const locale = useLocale();
  const dialogs = useDialogs();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const [reloadKey, setReloadKey] = useState(0);
  const [rowNotice, setRowNotice] = useState<{ kind: "error" | "success"; text: string } | null>(
    null,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [roles, setRoles] = useState<RoleOption[]>([]);

  const form = useZodForm<CreateInvitationInput>(createInvitationSchema, {
    defaultValues: { email: "", roleId: null },
  });

  const openDialog = useCallback(async () => {
    form.reset({ email: "", roleId: null });
    setDialogOpen(true);
    // Best-effort role options; the dialog works without them.
    try {
      const res = await fetch(
        `/api/administrator/roles?filter[organization]=${orgId}&pageSize=100`,
        { credentials: "same-origin" },
      );
      if (res.ok) {
        const body = (await res.json()) as { items: Array<{ id: string; name: string }> };
        setRoles(body.items.map((r) => ({ id: r.id, name: r.name })));
      }
    } catch {
      setRoles([]);
    }
  }, [form, orgId]);

  const onInvite = async (values: CreateInvitationInput) => {
    form.clearErrors("root");
    try {
      const res = await fetch(`/api/administrator/organizations/${orgId}/invitations`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: values.email.trim(), roleId: values.roleId ?? null }),
      });
      if (res.status === 201) {
        setDialogOpen(false);
        setRowNotice({ kind: "success", text: t("sent") });
        setReloadKey((k) => k + 1);
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === "member_exists") {
        form.setError("email", { type: "server", message: tErr("memberExists") });
        return;
      }
      if (body?.error === "invitation_exists") {
        form.setError("email", { type: "server", message: tErr("invitationExists") });
        return;
      }
      form.setError("root", { type: "server", message: t("sendError") });
    } catch {
      form.setError("root", { type: "server", message: t("sendError") });
    }
  };

  const onResend = useCallback(
    async (invitationId: string) => {
      setRowNotice(null);
      const res = await fetch(
        `/api/administrator/organizations/${orgId}/invitations/${invitationId}/resend`,
        { method: "POST", credentials: "same-origin" },
      );
      if (!res.ok) {
        setRowNotice({ kind: "error", text: t("resendError") });
        return;
      }
      setRowNotice({ kind: "success", text: t("resent") });
      setReloadKey((k) => k + 1);
    },
    [orgId, t],
  );

  const onRevoke = useCallback(
    async (invitationId: string, email: string) => {
      const ok = await dialogs.confirm({
        title: t("revokeConfirm"),
        description: email,
        destructive: true,
      });
      if (!ok) return;
      setRowNotice(null);
      const res = await fetch(
        `/api/administrator/organizations/${orgId}/invitations/${invitationId}`,
        { method: "DELETE", credentials: "same-origin" },
      );
      if (!res.ok) {
        setRowNotice({ kind: "error", text: t("revokeError") });
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [dialogs, orgId, t],
  );

  const columns = useMemo<ColumnDef<InvitationRow, unknown>[]>(
    () => [
      {
        id: "email",
        accessorKey: "email",
        header: () => t("columns.email"),
        cell: ({ row }) => row.original.email,
      },
      {
        id: "status",
        accessorKey: "status",
        header: () => t("columns.status"),
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "role_name",
        enableSorting: false,
        header: () => t("columns.role"),
        cell: ({ row }) => row.original.role_name ?? "—",
      },
      {
        id: "invited_by",
        enableSorting: false,
        header: () => t("columns.invitedBy"),
        cell: ({ row }) => row.original.invited_by_display_name ?? "—",
      },
      {
        id: "expires_at",
        accessorKey: "expires_at",
        header: () => t("columns.expires"),
        cell: ({ row }) => {
          const d = new Date(row.original.expires_at);
          return Number.isNaN(d.getTime()) ? row.original.expires_at : dateFormatter.format(d);
        },
      },
      ...(canUpdate
        ? [
            {
              id: "actions",
              enableSorting: false,
              header: () => "",
              cell: ({ row }: { row: { original: InvitationRow } }) =>
                row.original.status === "pending" ? (
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onResend(row.original.id)}
                    >
                      {t("resendButton")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onRevoke(row.original.id, row.original.email)}
                    >
                      {t("revokeButton")}
                    </Button>
                  </div>
                ) : null,
            } as ColumnDef<InvitationRow, unknown>,
          ]
        : []),
    ],
    [t, dateFormatter, canUpdate, onResend, onRevoke],
  );

  const rootError = form.formState.errors.root?.message;

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      {rowNotice ? (
        <p
          className={
            rowNotice.kind === "error" ? "text-destructive text-sm" : "text-success text-sm"
          }
          role={rowNotice.kind === "error" ? "alert" : "status"}
        >
          {rowNotice.text}
        </p>
      ) : null}
      <DataGrid<InvitationRow>
        key={reloadKey}
        name={`administrator.org-invitations.${orgId}`}
        endpoint={`/api/administrator/organizations/${orgId}/invitations`}
        columns={columns}
        options={{
          defaultPageSize: 10,
          defaultSort: [{ field: "created_at", direction: "desc" }],
        }}
        headerActions={
          canUpdate ? (
            <Button type="button" size="sm" onClick={openDialog}>
              {t("inviteButton")}
            </Button>
          ) : null
        }
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>
          <Form {...form} schema={createInvitationSchema}>
            <form className="space-y-4" onSubmit={form.handleSubmit(onInvite)} noValidate>
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("emailLabel")}</FormLabel>
                    <FormControl>
                      <Input type="email" autoComplete="off" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="roleId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("roleLabel")}</FormLabel>
                    <Select
                      value={field.value ?? NO_ROLE}
                      onValueChange={(v) => field.onChange(v === NO_ROLE ? null : v)}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NO_ROLE}>{t("noRole")}</SelectItem>
                        {roles.map((role) => (
                          <SelectItem key={role.id} value={role.id}>
                            {role.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {rootError ? (
                <p className="text-destructive text-sm" role="alert">
                  {rootError}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  {t("send")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
