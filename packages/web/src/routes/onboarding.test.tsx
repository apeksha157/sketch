import { OnboardingChat } from "@/components/onboarding-v2";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return { ...actual, useNavigate: () => vi.fn() };
});

// jsdom doesn't implement scrollTo
Element.prototype.scrollTo = vi.fn();

describe("OnboardingChat", () => {
  it("renders the initial Sketch greeting messages", async () => {
    renderWithProviders(<OnboardingChat />);

    await waitFor(() => {
      expect(screen.getByText("Hey! I'm Sketch — your new AI coworker.")).toBeInTheDocument();
    });
  });

  it("shows the auth picker after greeting", async () => {
    renderWithProviders(<OnboardingChat />);

    await waitFor(
      () => {
        expect(screen.getByText("Add to Slack")).toBeInTheDocument();
        expect(screen.getByText("Sign in with Google")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  it("shows user selection as a message after picking Slack", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingChat />);

    await waitFor(
      () => {
        expect(screen.getByText("Add to Slack")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    await user.click(screen.getByText("Add to Slack"));

    await waitFor(() => {
      expect(screen.getByText("Connecting to Slack...")).toBeInTheDocument();
    });
  });

  it("renders the step indicator with all 4 steps", async () => {
    renderWithProviders(<OnboardingChat />);

    expect(screen.getByText("Sign In")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Platforms")).toBeInTheDocument();
    expect(screen.getByText("API Key")).toBeInTheDocument();
  });

  it("renders header with sketch logo image", () => {
    renderWithProviders(<OnboardingChat />);

    expect(screen.getByAltText("Sketch")).toBeInTheDocument();
  });
});
