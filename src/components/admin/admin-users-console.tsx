"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

interface AdminUsersConsoleProps {
    appStatusByAuthUserId: Record<string, string>;
}

interface BetterAuthAdminUser {
    id: string;
    email: string;
    name: string;
    role?: string | string[] | null;
    banned?: boolean | null;
    banReason?: string | null;
}

export function AdminUsersConsole({ appStatusByAuthUserId }: AdminUsersConsoleProps) {
    const [users, setUsers] = useState<BetterAuthAdminUser[]>([]);
    const [total, setTotal] = useState(0);
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [actingUserId, setActingUserId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void refreshUsers();
    }, []);

    async function refreshUsers() {
        setLoading(true);
        setError(null);

        try {
            const result = await authClient.admin.listUsers({
                query: {
                    limit: 100,
                    sortBy: "createdAt",
                    sortDirection: "desc",
                },
            });

            if (result.error || !result.data) {
                setError(
                    getErrorMessage(
                        result.error,
                        "Failed to load Better Auth users. Ensure this account has Better Auth admin access.",
                    ),
                );
                return;
            }

            setUsers(
                result.data.users.map((user) => ({
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role ?? null,
                    banned: user.banned ?? false,
                    banReason: user.banReason ?? null,
                })),
            );
            setTotal(result.data.total);
        } catch {
            setError("Failed to load Better Auth users. Please try again.");
        } finally {
            setLoading(false);
        }
    }

    async function handleCreateUser(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setCreating(true);
        setError(null);

        try {
            const result = await authClient.admin.createUser({
                email,
                password,
                name,
                role: "user",
            });

            if (result.error) {
                setError(getErrorMessage(result.error, "Failed to create Better Auth user."));
                return;
            }

            setName("");
            setEmail("");
            setPassword("");
            await refreshUsers();
        } catch {
            setError("Failed to create Better Auth user.");
        } finally {
            setCreating(false);
        }
    }

    async function handleBanToggle(user: BetterAuthAdminUser) {
        setActingUserId(user.id);
        setError(null);

        try {
            const result = user.banned
                ? await authClient.admin.unbanUser({ userId: user.id })
                : await authClient.admin.banUser({
                    userId: user.id,
                    banReason: "Banned from admin console",
                });

            if (result.error) {
                setError(
                    getErrorMessage(
                        result.error,
                        user.banned ? "Failed to unban user." : "Failed to ban user.",
                    ),
                );
                return;
            }

            await refreshUsers();
        } catch {
            setError(user.banned ? "Failed to unban user." : "Failed to ban user.");
        } finally {
            setActingUserId(null);
        }
    }

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>Create Better Auth User</CardTitle>
                    <CardDescription>
                        New users appear in Better Auth immediately. Application status is created after the
                        user signs in for the first time.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleCreateUser} className="grid gap-4 md:grid-cols-4">
                        <div className="space-y-2 md:col-span-1">
                            <Label htmlFor="admin-create-name">Name</Label>
                            <Input
                                id="admin-create-name"
                                name="name"
                                autoComplete="name"
                                required
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </div>
                        <div className="space-y-2 md:col-span-1">
                            <Label htmlFor="admin-create-email">Email</Label>
                            <Input
                                id="admin-create-email"
                                name="email"
                                autoComplete="email"
                                required
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                            />
                        </div>
                        <div className="space-y-2 md:col-span-1">
                            <Label htmlFor="admin-create-password">Password</Label>
                            <Input
                                id="admin-create-password"
                                name="password"
                                autoComplete="new-password"
                                required
                                type="password"
                                minLength={8}
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                            />
                        </div>
                        <div className="flex items-end">
                            <Button type="submit" className="w-full" disabled={creating}>
                                {creating ? "Creating..." : "Create user"}
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>

            <div className="border-shell-border overflow-hidden rounded-lg border">
                <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
                    <div>
                        <h2 className="text-base font-semibold">Better Auth Users</h2>
                        <p className="text-sm text-neutral-600">{total} users</p>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => void refreshUsers()}
                        disabled={loading || creating || actingUserId !== null}
                    >
                        Refresh
                    </Button>
                </div>

                {error ? (
                    <p role="alert" className="border-b px-4 py-3 text-sm text-red-700">
                        {error}
                    </p>
                ) : null}

                {loading && users.length === 0 ? (
                    <p className="px-4 py-6 text-sm text-neutral-600">Loading Better Auth users...</p>
                ) : users.length === 0 ? (
                    <p className="px-4 py-6 text-sm text-neutral-600">No Better Auth users found.</p>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-neutral-500">
                                <th className="px-4 py-2">Email</th>
                                <th className="px-4 py-2">Name</th>
                                <th className="px-4 py-2">Role</th>
                                <th className="px-4 py-2">Auth access</th>
                                <th className="px-4 py-2">App status</th>
                                <th className="px-4 py-2">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map((user) => {
                                const appStatus = appStatusByAuthUserId[user.id] ?? "not provisioned";
                                const authAccess = user.banned ? "banned" : "active";

                                return (
                                    <tr key={user.id} className="border-t align-top">
                                        <td className="px-4 py-3">{user.email}</td>
                                        <td className="px-4 py-3">{user.name}</td>
                                        <td className="px-4 py-3">{formatRole(user.role)}</td>
                                        <td className="px-4 py-3">
                                            <div>{authAccess}</div>
                                            {user.banned && user.banReason ? (
                                                <div className="text-xs text-neutral-500">{user.banReason}</div>
                                            ) : null}
                                        </td>
                                        <td className="px-4 py-3">{appStatus}</td>
                                        <td className="px-4 py-3">
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant={user.banned ? "outline" : "destructive"}
                                                disabled={actingUserId === user.id}
                                                onClick={() => void handleBanToggle(user)}
                                            >
                                                {actingUserId === user.id
                                                    ? user.banned
                                                        ? "Unbanning..."
                                                        : "Banning..."
                                                    : user.banned
                                                        ? "Unban"
                                                        : "Ban"}
                                            </Button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

function formatRole(role: BetterAuthAdminUser["role"]): string {
    if (Array.isArray(role)) {
        return role.join(", ");
    }

    if (typeof role === "string" && role.length > 0) {
        return role;
    }

    return "user";
}

function getErrorMessage(error: unknown, fallback: string): string {
    if (
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof (error as { message?: unknown }).message === "string"
    ) {
        return (error as { message: string }).message;
    }

    return fallback;
}