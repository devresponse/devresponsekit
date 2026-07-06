// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { BlockedAccountPanel } from "@/components/auth/blocked-account-panel";
import { EmailVerifiedPanel } from "@/components/auth/email-verified-panel";
import { LoggedOutPanel } from "@/components/auth/logged-out-panel";
import { PendingApprovalPanel } from "@/components/auth/pending-approval-panel";
import { VerifyEmailPanel } from "@/components/auth/verify-email-panel";
import { renderWithIntl } from "../helpers/render-with-intl";

describe("BlockedAccountPanel", () => {
  it("renders the localized blocked title and a sign-out affordance", () => {
    renderWithIntl(<BlockedAccountPanel locale="en" />);
    // Title appears twice (CardTitle + AlertTitle).
    expect(screen.getAllByText(/Account access is restricted/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });

  it("does not leak admin-only operational details", () => {
    renderWithIntl(<BlockedAccountPanel locale="en" />);
    expect(screen.queryByText(/banned by/i)).toBeNull();
    expect(screen.queryByText(/reason:/i)).toBeNull();
  });
});

describe("PendingApprovalPanel", () => {
  it("renders the localized pending title and a sign-out affordance", () => {
    renderWithIntl(<PendingApprovalPanel locale="en" />);
    expect(screen.getAllByText(/pending approval/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });
});

describe("VerifyEmailPanel", () => {
  it("renders the localized verify title, guidance, and a resend affordance", () => {
    renderWithIntl(<VerifyEmailPanel locale="en" />);
    // Title appears twice (CardTitle + AlertTitle).
    expect(screen.getAllByText(/verify your email/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/verification link/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resend verification email/i })).toBeInTheDocument();
  });
});

describe("EmailVerifiedPanel", () => {
  it("confirms the address is verified and links to sign in", () => {
    renderWithIntl(<EmailVerifiedPanel locale="en" />);
    // Title appears twice (CardTitle + AlertTitle).
    expect(screen.getAllByText(/email verified/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/you can now sign in/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /proceed to sign in/i });
    expect(link).toHaveAttribute("href", "/en/sign-in");
  });
});

describe("LoggedOutPanel", () => {
  it("renders the localized logged-out title and a localized sign-in link", () => {
    renderWithIntl(<LoggedOutPanel locale="en" />);
    expect(screen.getByText(/signed out/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /sign in/i });
    expect(link).toHaveAttribute("href", "/en/sign-in");
  });
});
