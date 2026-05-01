// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminUsersConsole } from "@/components/admin/admin-users-console";
import { renderWithIntl } from "../helpers/render-with-intl";

const listUsers = vi.fn();
const createUser = vi.fn();
const banUser = vi.fn();
const unbanUser = vi.fn();

vi.mock("@/lib/auth-client", () => ({
    authClient: {
        admin: {
            listUsers: (...args: unknown[]) => listUsers(...args),
            createUser: (...args: unknown[]) => createUser(...args),
            banUser: (...args: unknown[]) => banUser(...args),
            unbanUser: (...args: unknown[]) => unbanUser(...args),
        },
    },
}));

beforeEach(() => {
    listUsers.mockReset();
    createUser.mockReset();
    banUser.mockReset();
    unbanUser.mockReset();
});

afterEach(() => {
    listUsers.mockReset();
    createUser.mockReset();
    banUser.mockReset();
    unbanUser.mockReset();
});

describe("AdminUsersConsole", () => {
    it("loads Better Auth users and renders their mapped app status", async () => {
        listUsers.mockResolvedValueOnce({
            data: {
                users: [
                    {
                        id: "auth-1",
                        email: "ada@example.com",
                        name: "Ada",
                        role: "user",
                        banned: false,
                        banReason: null,
                    },
                ],
                total: 1,
            },
            error: null,
        });

        renderWithIntl(<AdminUsersConsole appStatusByAuthUserId={{ "auth-1": "pending_approval" }} />);

        expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
        expect(screen.getByText("pending_approval")).toBeInTheDocument();
        expect(listUsers).toHaveBeenCalledWith({
            query: {
                limit: 100,
                sortBy: "createdAt",
                sortDirection: "desc",
            },
        });
    });

    it("creates a Better Auth user and refreshes the list", async () => {
        listUsers
            .mockResolvedValueOnce({ data: { users: [], total: 0 }, error: null })
            .mockResolvedValueOnce({
                data: {
                    users: [
                        {
                            id: "auth-2",
                            email: "new@example.com",
                            name: "New User",
                            role: "user",
                            banned: false,
                            banReason: null,
                        },
                    ],
                    total: 1,
                },
                error: null,
            });
        createUser.mockResolvedValueOnce({
            data: {
                user: {
                    id: "auth-2",
                    email: "new@example.com",
                    name: "New User",
                    role: "user",
                    banned: false,
                },
            },
            error: null,
        });

        const user = userEvent.setup();
        renderWithIntl(<AdminUsersConsole appStatusByAuthUserId={{}} />);

        await screen.findByText(/no better auth users found/i);
        await user.type(screen.getByLabelText(/^name$/i), "New User");
        await user.type(screen.getByLabelText(/^email$/i), "new@example.com");
        await user.type(screen.getByLabelText(/^password$/i), "Password!1234");
        await user.click(screen.getByRole("button", { name: /create user/i }));

        expect(createUser).toHaveBeenCalledWith({
            email: "new@example.com",
            password: "Password!1234",
            name: "New User",
            role: "user",
        });
        expect(await screen.findByText("new@example.com")).toBeInTheDocument();
    });

    it("bans a Better Auth user and refreshes the rendered auth state", async () => {
        listUsers
            .mockResolvedValueOnce({
                data: {
                    users: [
                        {
                            id: "auth-3",
                            email: "banme@example.com",
                            name: "Ban Me",
                            role: "user",
                            banned: false,
                            banReason: null,
                        },
                    ],
                    total: 1,
                },
                error: null,
            })
            .mockResolvedValueOnce({
                data: {
                    users: [
                        {
                            id: "auth-3",
                            email: "banme@example.com",
                            name: "Ban Me",
                            role: "user",
                            banned: true,
                            banReason: "Banned from admin console",
                        },
                    ],
                    total: 1,
                },
                error: null,
            });
        banUser.mockResolvedValueOnce({
            data: {
                user: {
                    id: "auth-3",
                    email: "banme@example.com",
                    name: "Ban Me",
                    role: "user",
                    banned: true,
                },
            },
            error: null,
        });

        const user = userEvent.setup();
        renderWithIntl(<AdminUsersConsole appStatusByAuthUserId={{}} />);

        await screen.findByText("banme@example.com");
        await user.click(screen.getByRole("button", { name: /^ban$/i }));

        expect(banUser).toHaveBeenCalledWith({
            userId: "auth-3",
            banReason: "Banned from admin console",
        });

        await waitFor(() => {
            expect(screen.getByText(/^banned$/i)).toBeInTheDocument();
        });
    });
});