// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdministratorTopHeader } from "@/app/[locale]/(secure)/app/administrator/_components/administrator-top-header";
import { SidebarProvider } from "@/components/ui/flexsidebar";
import { renderWithIntl } from "../helpers/render-with-intl";

const push = vi.fn();

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push }),
}));

/** The header hosts a SidebarTrigger, which needs the admin layout's provider. */
function renderHeader(ui: React.ReactElement) {
  return renderWithIntl(<SidebarProvider>{ui}</SidebarProvider>);
}

describe("AdministratorTopHeader", () => {
  it("renders a square desktop menubar with only visible administrator groups", () => {
    renderHeader(
      <AdministratorTopHeader
        locale="en"
        permissions={["admin.users.read", "admin.users.create", "admin.roles.read"]}
      />,
    );

    const menubar = screen.getByRole("menubar", { name: "Administrator" });

    expect(menubar).toHaveClass("rounded-none", "p-0", "shadow-none", "space-x-0");
    expect(menubar.closest(".sticky")).toHaveClass("top-0");
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("Identity")).toBeInTheDocument();
    expect(screen.getByText("Access")).toBeInTheDocument();
    expect(screen.queryByText("Apps")).not.toBeInTheDocument();
  });

  it("opens administrator menus with real destinations and actions", async () => {
    push.mockReset();
    const user = userEvent.setup();

    renderHeader(
      <AdministratorTopHeader
        locale="en"
        permissions={["admin.users.read", "admin.users.create"]}
      />,
    );

    await user.click(screen.getByRole("menuitem", { name: "Identity" }));

    const usersItem = await screen.findByRole("menuitem", { name: "Users" });
    expect(usersItem.closest("[data-radix-menubar-content]"))?.toHaveClass(
      "rounded-t-none",
      "rounded-b-lg",
      "border",
      "border-border",
      "bg-background",
    );
    expect(await screen.findByRole("menuitem", { name: "New user" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "New user" }));
    expect(push).toHaveBeenCalledWith("/app/administrator/users/new", { locale: "en" });
  });

  it("hides create actions when the caller only has read access", async () => {
    const user = userEvent.setup();

    renderHeader(<AdministratorTopHeader locale="en" permissions={["admin.users.read"]} />);

    await user.click(screen.getByRole("menuitem", { name: "Identity" }));

    expect(await screen.findByRole("menuitem", { name: "Users" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "New user" })).not.toBeInTheDocument();
  });
});
