import { FilesPage } from "@/routes/files";
import { createRoute } from "@tanstack/react-router";
import { dashboardRoute } from "../dashboard";
import { MockQueryProvider, hideTrialBanner } from "./mock-query-provider";

const now = new Date().toISOString();

const DEMO_CONNECTORS = {
  connectors: [
    {
      id: "c1",
      type: "google_drive",
      name: "Google Drive",
      status: "active",
      icon: "google-drive",
      fileCount: 42,
      lastSyncedAt: now,
      syncStatus: "synced",
    },
    {
      id: "c2",
      type: "notion",
      name: "Notion",
      status: "active",
      icon: "notion",
      fileCount: 18,
      lastSyncedAt: now,
      syncStatus: "synced",
    },
    {
      id: "c3",
      type: "local",
      name: "Local uploads",
      status: "active",
      icon: "upload",
      fileCount: 5,
      lastSyncedAt: now,
      syncStatus: "synced",
    },
  ],
};

const DEMO_FILES = {
  files: [
    {
      id: "f1",
      fileName: "Q4 Revenue Report.pdf",
      fileType: "pdf",
      contentCategory: "document",
      source: "google_drive",
      sourcePath: "/Finance/Reports",
      providerUrl: null,
      syncedAt: now,
      sourceCreatedAt: now,
      sourceUpdatedAt: now,
      hasSummary: true,
      accessScope: "unrestricted",
      accessCount: null,
    },
    {
      id: "f2",
      fileName: "Product Roadmap 2026.docx",
      fileType: "docx",
      contentCategory: "document",
      source: "google_drive",
      sourcePath: "/Product",
      providerUrl: null,
      syncedAt: now,
      sourceCreatedAt: now,
      sourceUpdatedAt: now,
      hasSummary: true,
      accessScope: "restricted",
      accessCount: 3,
    },
    {
      id: "f3",
      fileName: "Engineering Wiki",
      fileType: null,
      contentCategory: "document",
      source: "notion",
      sourcePath: "/Engineering",
      providerUrl: null,
      syncedAt: now,
      sourceCreatedAt: now,
      sourceUpdatedAt: now,
      hasSummary: true,
      accessScope: "unrestricted",
      accessCount: null,
    },
    {
      id: "f4",
      fileName: "Customer Feedback Tracker.csv",
      fileType: "csv",
      contentCategory: "structured",
      source: "local",
      sourcePath: null,
      providerUrl: null,
      syncedAt: now,
      sourceCreatedAt: now,
      sourceUpdatedAt: now,
      hasSummary: false,
      accessScope: "unrestricted",
      accessCount: null,
    },
    {
      id: "f5",
      fileName: "Brand Guidelines.pdf",
      fileType: "pdf",
      contentCategory: "document",
      source: "google_drive",
      sourcePath: "/Marketing",
      providerUrl: null,
      syncedAt: now,
      sourceCreatedAt: now,
      sourceUpdatedAt: now,
      hasSummary: true,
      accessScope: "unrestricted",
      accessCount: null,
    },
    {
      id: "f6",
      fileName: "Onboarding Checklist",
      fileType: null,
      contentCategory: "document",
      source: "notion",
      sourcePath: "/HR",
      providerUrl: null,
      syncedAt: now,
      sourceCreatedAt: now,
      sourceUpdatedAt: now,
      hasSummary: true,
      accessScope: "restricted",
      accessCount: 5,
    },
  ],
  total: 6,
  hasMore: false,
};

const EMPTY_CONNECTORS = { connectors: [] };
const EMPTY_FILES = { files: [], total: 0, hasMore: false };

export const filesPreviewRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/files",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider
      mocks={[
        { queryKey: ["integrations"], data: DEMO_CONNECTORS },
        { queryKey: ["all-files", 50, undefined], data: DEMO_FILES },
      ]}
    >
      <FilesPage />
    </MockQueryProvider>
  ),
});

export const filesEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/files/empty",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider
      mocks={[
        { queryKey: ["integrations"], data: EMPTY_CONNECTORS },
        { queryKey: ["all-files", 50, undefined], data: EMPTY_FILES },
      ]}
    >
      <FilesPage />
    </MockQueryProvider>
  ),
});
