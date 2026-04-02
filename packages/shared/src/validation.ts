import { z } from "zod";

export const whatsappNumberSchema = z
  .string()
  .min(8, "Phone number must be at least 8 characters")
  .startsWith("+", "Phone number must start with +");

export const emailSchema = z.string().email("Invalid email address");

// File path validation schemas for workspace API
export const filePathSchema = z
  .string()
  .min(1, "Path cannot be empty")
  .refine((path) => !path.startsWith("/"), "Absolute paths are not allowed")
  .refine((path) => !path.includes(".."), "Path cannot contain parent directory references");

export const descriptionSchema = z.string().max(500, "Description must be under 500 characters");

export const userTypeSchema = z.enum(["human", "agent"]);
export const roleSchema = z.string().max(100, "Role must be under 100 characters");

export const fileNameSchema = z
  .string()
  .min(1, "Name cannot be empty")
  .max(255, "Name must be less than 255 characters")
  .refine((name) => {
    // Check for special characters: <>:"|?*
    if (/[<>:"|?*]/.test(name)) return false;
    // Check for control characters (0x00-0x1f)
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i);
      if (code >= 0x00 && code <= 0x1f) return false;
    }
    return true;
  }, "Name contains invalid characters")
  .refine(
    (name) => !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name.split(".")[0] ?? ""),
    "Name is a reserved system name",
  )
  .refine((name) => !name.endsWith(".") && !name.endsWith(" "), "Name cannot end with dot or space");
