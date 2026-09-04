import type { AimfoxLead } from "./aimfox-client";

export interface LinkedinAimfoxPersonSeed {
  leadId: string;
  name: string;
  publicIdentifier: string;
  profileUrl: string;
  emails: string[];
  phones: Array<{ number: string; type?: string; country?: string }>;
  currentCompanyName: string | null;
  currentCompanyUniversalName: string | null;
  currentCompanyLinkedinUrl: string | null;
  currentCompanyWebsiteDomains: string[];
  title: string | null;
  location: string | null;
  headline: string | null;
  metadata: Record<string, unknown>;
}

const COMPANY_SUFFIX_RE =
  /\b(inc\.?|corp\.?|corporation|llc|ltd\.?|limited|co\.?|company|group|holdings|plc|gmbh|s\.?a\.?|ag|pvt\.?|private)\b/gi;
const BOGUS_COMPANY_NAMES = new Set([
  "self employed",
  "self-employed",
  "freelance",
  "freelancer",
  "independent",
  "independent consultant",
  "consultant",
  "none",
  "n/a",
]);

export function buildLinkedinProfileUrl(publicIdentifier: string): string {
  return `https://www.linkedin.com/in/${publicIdentifier}`;
}

export function normalizeCompanyName(name: string): string {
  return name.replace(COMPANY_SUFFIX_RE, "").replace(/[.,]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function isBogusCompanyName(name: string | null | undefined): boolean {
  if (!name) return true;
  return BOGUS_COMPANY_NAMES.has(normalizeCompanyName(name));
}

export function buildPersonSeed(lead: AimfoxLead): LinkedinAimfoxPersonSeed | null {
  const publicIdentifier = lead.public_identifier?.trim().toLowerCase();
  const name = (lead.full_name || `${lead.first_name ?? ""} ${lead.last_name ?? ""}`).trim();
  if (!lead.id || !publicIdentifier || !name) return null;

  const current = lead.current_experience?.[0] ?? null;
  const companyName = current?.company?.name?.trim() || null;
  const companyUniversalName = current?.company?.universal_name?.trim().toLowerCase() || null;
  const currentCompanyLinkedinUrl = companyUniversalName
    ? `https://www.linkedin.com/company/${companyUniversalName}`
    : null;
  const title = current?.job_title?.trim() || lead.occupation?.trim() || null;
  const emails = extractEmails(lead);
  const phones = extractPhones(lead);
  const profileUrl = buildLinkedinProfileUrl(publicIdentifier);
  const currentCompanyWebsiteDomains = extractWebsiteDomains(lead.websites ?? []);

  return {
    leadId: String(lead.id),
    name,
    publicIdentifier,
    profileUrl,
    emails,
    phones,
    currentCompanyName: companyName,
    currentCompanyUniversalName: companyUniversalName,
    currentCompanyLinkedinUrl,
    currentCompanyWebsiteDomains,
    title,
    location: lead.location?.name?.trim() || null,
    headline: lead.about?.trim() || null,
    metadata: formatPersonAttributes(lead, { profileUrl, publicIdentifier, title, companyName }),
  };
}

function extractEmails(lead: AimfoxLead): string[] {
  const raw = [lead.email, ...(lead.emails ?? []).map((email) => email.address)];
  return [
    ...new Set(
      raw
        .filter((email): email is string => typeof email === "string")
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.includes("@")),
    ),
  ];
}

function extractPhones(lead: AimfoxLead): Array<{ number: string; type?: string; country?: string }> {
  const raw = [...(lead.phones ?? []), ...(lead.contact_info?.phone_numbers ?? [])];
  const seen = new Set<string>();
  const phones: Array<{ number: string; type?: string; country?: string }> = [];
  for (const phone of raw) {
    const number = phone.number?.trim();
    if (!number || seen.has(number)) continue;
    seen.add(number);
    phones.push({ number, type: phone.type, country: phone.country });
  }
  return phones;
}

function extractWebsiteDomains(websites: Array<string | { url?: string }>): string[] {
  const domains = new Set<string>();
  for (const website of websites) {
    const raw = typeof website === "string" ? website : website.url;
    if (!raw?.trim()) continue;
    try {
      const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
      const domain = url.hostname.toLowerCase().replace(/^www\./, "");
      if (domain?.includes(".")) domains.add(domain);
    } catch {}
  }
  return [...domains].sort();
}

function formatPersonAttributes(
  lead: AimfoxLead,
  params: { profileUrl: string; publicIdentifier: string; title: string | null; companyName: string | null },
): Record<string, unknown> {
  return {
    linkedinProfileUrl: params.profileUrl,
    linkedinPublicIdentifier: params.publicIdentifier,
    aimfoxLeadId: String(lead.id),
    title: params.title,
    company: params.companyName,
    location: lead.location?.name ?? null,
    headline: lead.about ?? null,
    pictureUrl: lead.picture_url || null,
    connections: lead.connections ?? null,
    followers: lead.followers ?? null,
    premium: lead.premium ?? null,
    skills: (lead.skills ?? []).map((skill) => skill.name).filter(Boolean),
    source: "aimfox",
  };
}
