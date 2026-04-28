/**
 * Shared dashboard navigation list — single source of truth for both the sidebar
 * and the home page's Quick Jump customization dialog.
 */
import {
  BrainIcon,
  CalendarDotsIcon,
  ChartBarIcon,
  ChatCircleIcon,
  CreditCardIcon,
  FolderSimpleIcon,
  HouseIcon,
  LinkSimpleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import type React from "react";

export interface NavItem {
  label: string;
  icon: React.ReactNode;
  href: string;
  disabled?: boolean;
}

/**
 * Build a NavItem list at a given icon size. Quick Jump uses size=18 for the
 * tile, the dialog uses size=16 for the row, the sidebar uses size=18.
 */
export function getDashboardNav(iconSize = 18): NavItem[] {
  return [
    { label: "Home", icon: <HouseIcon size={iconSize} />, href: "/home" },
    { label: "Channels", icon: <ChatCircleIcon size={iconSize} />, href: "/channels" },
    { label: "Files", icon: <FolderSimpleIcon size={iconSize} />, href: "/files" },
    { label: "Team", icon: <UsersThreeIcon size={iconSize} />, href: "/team" },
    { label: "Scheduled Tasks", icon: <CalendarDotsIcon size={iconSize} />, href: "/scheduled-tasks" },
    { label: "Skills", icon: <BrainIcon size={iconSize} />, href: "/skills" },
    { label: "Usage", icon: <ChartBarIcon size={iconSize} />, href: "/usage" },
    { label: "Pricing", icon: <CreditCardIcon size={iconSize} />, href: "/plans" },
    { label: "Integrations", icon: <LinkSimpleIcon size={iconSize} />, href: "/integrations" },
  ];
}
