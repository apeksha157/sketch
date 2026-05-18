/**
 * Icon picks for the Sketch v1 design system — all Phosphor.
 *
 * The rest of the product uses Phosphor (the AppSidebar, dashboard-nav, activity
 * cards on /old/home/member). Lucide produces a thinner, line-art look that
 * doesn't match. This module routes every spec icon (the ti-* names in the
 * design doc) to its Phosphor equivalent — and crucially, uses Phosphor's
 * real brand glyphs for Slack and WhatsApp instead of the hand-rolled SVGs.
 *
 * Export names are kept stable (HomeIcon, MailIcon, etc.) so consumers don't
 * change — only the underlying icon family swaps.
 */
export {
  ArrowLeftIcon, // ti-arrow-left
  ArrowRightIcon, // ti-arrow-right
  ArrowUpIcon, // ti-arrow-up
  ArrowsClockwiseIcon as RefreshIcon, // ti-refresh
  BrowserIcon, // in-product / dashboard conversations — "this happened in the web app"
  CalendarDotsIcon as CalendarTimeIcon, // ti-calendar-time
  CaretRightIcon as ChevronRightIcon, // ti-chevron-right — used for the collapsed-sidebar expand toggle
  CaretUpIcon as ChevronUpIcon, // ti-chevron-up
  ChartBarIcon, // ti-chart-bar
  CheckIcon, // ti-check
  ChatCircleIcon as MessageCircle2Icon, // ti-message-circle-2
  ChatIcon as MessageSquareIcon, // ti-message-2
  ChatsCircleIcon as ChannelsIcon, // sidebar "Channels" nav — neutral, not Slack-coded
  DotsThreeIcon as DotsIcon, // ti-dots
  EnvelopeIcon as MailIcon, // ti-mail
  FileIcon, // ti-file
  FilesIcon, // ti-files
  HashIcon, // ti-hash
  HouseIcon as HomeIcon, // ti-home
  LightbulbIcon as BulbIcon, // ti-bulb
  MagnifyingGlassIcon as SearchIcon, // ti-search
  PencilSimpleIcon as PencilIcon, // ti-pencil
  PuzzlePieceIcon as PuzzleIcon, // ti-puzzle
  SidebarSimpleIcon as SidebarCollapseIcon, // ti-layout-sidebar-left-collapse
  SidebarSimpleIcon as SidebarExpandIcon, // ti-layout-sidebar-left-expand (same glyph; rotates via CSS)
  SlackLogoIcon as SlackBrandIcon, // ti-brand-slack — real Phosphor brand glyph
  SparkleIcon as SparklesIcon, // ti-sparkles
  UserPlusIcon, // ti-user-plus
  UsersThreeIcon as UsersIcon, // ti-users
  WarningIcon as AlertTriangleIcon, // ti-alert-triangle
  WhatsappLogoIcon as WhatsappBrandIcon, // ti-brand-whatsapp — real Phosphor brand glyph
} from "@phosphor-icons/react";

import type { IconProps as PhosphorIconProps } from "@phosphor-icons/react";

/**
 * Re-exported Phosphor icon prop type. Gives consumers the full surface
 * (size, weight, color, mirrored, alt + standard SVG attrs) without each
 * site needing to import from Phosphor directly.
 */
export type IconProps = PhosphorIconProps;
