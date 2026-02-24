import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as cheerio from "cheerio";
import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const BASE_URL = process.env.BASE_URL || "https://kerebyudlejning.dk";
const STATE_PATH = process.env.STATE_PATH || path.join(projectRoot, "state", "seen.json");
const CHECK_PATHS = (process.env.CHECK_PATHS ||
  "/,/ledige-lejemaal,/udlejning,/lejligheder,/boliger")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const RENTALS_API_BASE_URL = process.env.RENTALS_API_BASE_URL || "https://api.jorato.com";
const RENTALS_API_KEY = process.env.RENTALS_API_KEY || "2gXoBtKvFMMgKJ1VBJ5G5pNr2GD";
const SOURCE_VERSION = 2;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_AUTH_METHOD = (process.env.SMTP_AUTH_METHOD || "password").trim().toLowerCase();
const SMTP_OAUTH_CLIENT_ID = process.env.SMTP_OAUTH_CLIENT_ID;
const SMTP_OAUTH_CLIENT_SECRET = process.env.SMTP_OAUTH_CLIENT_SECRET;
const SMTP_OAUTH_REFRESH_TOKEN = process.env.SMTP_OAUTH_REFRESH_TOKEN;
const SMTP_OAUTH_TENANT_ID = process.env.SMTP_OAUTH_TENANT_ID || "common";
const SMTP_OAUTH_ACCESS_URL =
  process.env.SMTP_OAUTH_ACCESS_URL ||
  `https://login.microsoftonline.com/${SMTP_OAUTH_TENANT_ID}/oauth2/v2.0/token`;
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_SUBJECT_PREFIX = process.env.EMAIL_SUBJECT_PREFIX || "Ny lejlighed på Kereby";
const MAX_RENT = Number(process.env.MAX_RENT || 16000);
const MIN_ROOMS = Number(process.env.MIN_ROOMS || 3);

const LISTING_HINTS = [
  "lejlighed",
  "lejemal",
  "lejemaal",
  "ledig",
  "udlejning",
  "bolig",
  "til-leje",
  "tilleje",
  "for-rent",
  "apartment",
  "property"
];

const EXCLUDE_HINTS = [
  "kontakt",
  "persondata",
  "privacy",
  "cookie",
  "login",
  "admin",
  "wp-json",
  "wp-content",
  "feed",
  "sitemap",
  "category",
  "tag"
];

function normalizeText(value) {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function validateConfig() {
  const required = [
    ["SMTP_HOST", SMTP_HOST],
    ["SMTP_USER", SMTP_USER],
    ["EMAIL_FROM", EMAIL_FROM],
    ["EMAIL_TO", EMAIL_TO]
  ];
  const authMethod = SMTP_AUTH_METHOD || "password";

  if (authMethod === "password") {
    required.push(["SMTP_PASS", SMTP_PASS]);
  } else if (authMethod === "oauth2") {
    required.push(["SMTP_OAUTH_CLIENT_ID", SMTP_OAUTH_CLIENT_ID]);
    required.push(["SMTP_OAUTH_CLIENT_SECRET", SMTP_OAUTH_CLIENT_SECRET]);
    required.push(["SMTP_OAUTH_REFRESH_TOKEN", SMTP_OAUTH_REFRESH_TOKEN]);
  } else {
    throw new Error(`Ugyldig SMTP_AUTH_METHOD: ${SMTP_AUTH_METHOD}. Brug 'password' eller 'oauth2'.`);
  }

  const missing = required.filter((entry) => !entry[1]).map((entry) => entry[0]);
  if (missing.length) {
    throw new Error(`Mangler env vars: ${missing.join(", ")}`);
  }
  if (!Number.isFinite(SMTP_PORT) || SMTP_PORT <= 0) {
    throw new Error(`Ugyldig SMTP_PORT: ${process.env.SMTP_PORT}`);
  }
  if (!Number.isFinite(MAX_RENT) || MAX_RENT <= 0) {
    throw new Error(`Ugyldig MAX_RENT: ${process.env.MAX_RENT}`);
  }
  if (!Number.isFinite(MIN_ROOMS) || MIN_ROOMS <= 0) {
    throw new Error(`Ugyldig MIN_ROOMS: ${process.env.MIN_ROOMS}`);
  }
}

function getSmtpAuth() {
  if (SMTP_AUTH_METHOD === "oauth2") {
    return {
      type: "OAuth2",
      user: SMTP_USER,
      clientId: SMTP_OAUTH_CLIENT_ID,
      clientSecret: SMTP_OAUTH_CLIENT_SECRET,
      refreshToken: SMTP_OAUTH_REFRESH_TOKEN,
      accessUrl: SMTP_OAUTH_ACCESS_URL
    };
  }

  return {
    user: SMTP_USER,
    pass: SMTP_PASS
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "KerebyMonitor/1.0 (+https://github.com/)"
    },
    redirect: "follow"
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "KerebyMonitor/1.0 (+https://github.com/)"
    },
    redirect: "follow"
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

function toAbsoluteUrl(href, origin) {
  try {
    const url = new URL(href, origin);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function isLikelyListing(urlString, title, baseHost) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }

  if (parsed.host !== baseHost) return false;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.pathname === "/" || parsed.pathname.length < 2) return false;
  if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|js|css)$/i.test(parsed.pathname)) return false;

  const pathAndTitle = normalizeText(`${parsed.pathname} ${title || ""}`);
  if (EXCLUDE_HINTS.some((hint) => pathAndTitle.includes(hint))) return false;

  const hasListingHint = LISTING_HINTS.some((hint) => pathAndTitle.includes(hint));
  if (hasListingHint) return true;

  const segments = parsed.pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] || "";
  const looksLikeDetailPage =
    segments.length >= 2 &&
    (/-/.test(lastSegment) || /\d{2,}/.test(lastSegment) || lastSegment.length >= 16);

  return looksLikeDetailPage;
}

function extractLinksFromHtml(html, pageUrl, baseHost) {
  const $ = cheerio.load(html);
  const found = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const url = toAbsoluteUrl(href, pageUrl);
    if (!url) return;
    const title = $(element).text().trim().replace(/\s+/g, " ");
    if (isLikelyListing(url, title, baseHost)) {
      found.push({ url, title });
    }
  });

  return found;
}

function extractUrlsFromSitemap(xml, baseUrl, baseHost) {
  const urls = [];
  const locRegex = /<loc>(.*?)<\/loc>/gims;

  for (const match of xml.matchAll(locRegex)) {
    const loc = match[1]?.trim();
    if (!loc) continue;
    const absolute = toAbsoluteUrl(loc, baseUrl);
    if (!absolute) continue;
    if (isLikelyListing(absolute, "", baseHost)) {
      urls.push({ url: absolute, title: "" });
    }
  }

  return urls;
}

function dedupeByUrl(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!map.has(entry.url)) map.set(entry.url, entry);
  }
  return [...map.values()];
}

function buildRentalSlug(address = {}) {
  const joined = `${address.street || ""} ${address.zipCode || ""} ${address.city || ""}`;
  let slug = normalizeText(joined)
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!slug) return null;
  if (slug.length > 45) slug = slug.slice(0, 45).trim();

  return slug.replace(/\s/g, "-");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toNumber(value) {
  if (!value) return null;
  let cleaned = String(value).replace(/\u00a0/g, " ").trim().replace(/\s+/g, "");
  if (!cleaned) return null;

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  if (hasComma && hasDot) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    cleaned = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  } else {
    cleaned = /\.\d{1,2}$/.test(cleaned) ? cleaned : cleaned.replace(/\./g, "");
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractByPatterns(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function parseRentAndRooms(text, title = "") {
  const normalizedText = normalizeText(text.replace(/\s+/g, " "));
  const normalizedTitle = normalizeText(title);
  const combined = `${normalizedTitle} ${normalizedText}`;

  const rentRaw = extractByPatterns(combined, [
    /husleje[^0-9]{0,40}(\d[\d.\s]*(?:,\d{1,2})?)/i,
    /maned(?:lig)?(?:\s+hus)?leje[^0-9]{0,40}(\d[\d.\s]*(?:,\d{1,2})?)/i,
    /mdr\.?\s*leje[^0-9]{0,40}(\d[\d.\s]*(?:,\d{1,2})?)/i
  ]);

  const roomsRaw = extractByPatterns(combined, [
    /vaerelser?[^0-9]{0,20}(\d+(?:[.,]\d+)?)/i,
    /(\d+(?:[.,]\d+)?)\s*vaer(?:\.|else|elser)\b/i,
    /rum[^0-9]{0,20}(\d+(?:[.,]\d+)?)/i
  ]);

  const rent = toNumber(rentRaw);
  const rooms = toNumber(roomsRaw);

  return {
    rent: rent == null ? null : Math.round(rent),
    rooms
  };
}

function meetsCriteria(listing) {
  if (listing.rent == null || listing.rooms == null) return false;
  return listing.rent <= MAX_RENT && listing.rooms >= MIN_ROOMS;
}

function formatRent(rent) {
  if (rent == null) return "ukendt";
  return new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 }).format(rent);
}

function formatRooms(rooms) {
  if (rooms == null) return "ukendt";
  return String(rooms).replace(".", ",");
}

async function enrichListingDetails(listing) {
  if (listing.rent != null && listing.rooms != null) {
    return listing;
  }

  try {
    const html = await fetchText(listing.url);
    const $ = cheerio.load(html);
    const bodyText = $("body").text();
    const details = parseRentAndRooms(bodyText, listing.title);
    return { ...listing, ...details };
  } catch (error) {
    console.warn(`Kunne ikke læse detaljer for ${listing.url}: ${error.message}`);
    return { ...listing, rent: null, rooms: null };
  }
}

async function enrichListings(listings) {
  const settled = await Promise.allSettled(listings.map((item) => enrichListingDetails(item)));
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    console.warn(`Detaljeanalyse fejlede for ${listings[index].url}: ${result.reason?.message || result.reason}`);
    return { ...listings[index], rent: null, rooms: null };
  });
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      initialized: Boolean(parsed.initialized),
      sourceVersion: Number(parsed.sourceVersion || 0),
      knownUrls: Array.isArray(parsed.knownUrls) ? parsed.knownUrls : []
    };
  } catch {
    return {
      initialized: false,
      sourceVersion: 0,
      knownUrls: []
    };
  }
}

async function saveState(data) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(
    STATE_PATH,
    JSON.stringify(
      {
        initialized: true,
        sourceVersion: Number(data.sourceVersion || SOURCE_VERSION),
        knownUrls: data.knownUrls,
        lastCheckedAt: new Date().toISOString()
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

async function sendEmail(newListings) {
  const secure = SMTP_PORT === 465;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure,
    auth: getSmtpAuth()
  });

  const subject = `${EMAIL_SUBJECT_PREFIX}: ${newListings.length} ny${
    newListings.length > 1 ? "e" : ""
  }`;

  const lines = [
    "Der er kommet nye lejligheder på kerebyudlejning.dk:",
    `Kriterier: husleje <= ${formatRent(MAX_RENT)} kr og vaerelser >= ${formatRooms(MIN_ROOMS)}`,
    "",
    ...newListings.map(
      (item) =>
        `- ${item.url} (husleje: ${formatRent(item.rent)} kr, vaerelser: ${formatRooms(item.rooms)})`
    ),
    "",
    `Tjekket: ${new Date().toLocaleString("da-DK", { timeZone: "Europe/Copenhagen" })}`
  ];

  const htmlList = newListings
    .map(
      (item) =>
        `<li><a href="${escapeHtml(item.url)}">${escapeHtml(item.title || item.url)}</a> (husleje: ${escapeHtml(
          formatRent(item.rent)
        )} kr, vaerelser: ${escapeHtml(formatRooms(item.rooms))})</li>`
    )
    .join("");

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text: lines.join("\n"),
    html: `
      <p>Der er kommet nye lejligheder på <a href="${BASE_URL}">kerebyudlejning.dk</a>:</p>
      <p>Kriterier: husleje &lt;= ${escapeHtml(formatRent(MAX_RENT))} kr og vaerelser &gt;= ${escapeHtml(
        formatRooms(MIN_ROOMS)
      )}</p>
      <ul>${htmlList}</ul>
      <p>Tjekket: ${new Date().toLocaleString("da-DK", { timeZone: "Europe/Copenhagen" })}</p>
    `
  });
}

async function collectListingsFromApi() {
  if (!RENTALS_API_KEY) {
    console.warn("RENTALS_API_KEY mangler; springer API-kilde over.");
    return [];
  }

  try {
    const endpoint = new URL("/tenancies", RENTALS_API_BASE_URL);
    endpoint.searchParams.set("visibility", "public");
    endpoint.searchParams.set("showAll", "true");
    endpoint.searchParams.set("key", RENTALS_API_KEY);

    const payload = await fetchJson(endpoint.href);
    const items = Array.isArray(payload?.items) ? payload.items : [];

    const mapped = items
      .filter((item) => item?.classification === "Residential")
      .map((item) => {
        const slug = buildRentalSlug(item.address);
        if (!slug) return null;

        const url = toAbsoluteUrl(`/bolig/${slug}`, BASE_URL);
        if (!url) return null;

        const title =
          item.title ||
          [item.address?.street, item.address?.zipCode, item.address?.city].filter(Boolean).join(", ");
        const rent = toNumber(item.monthlyRent?.value);
        const rooms = toNumber(item.rooms);

        return {
          url,
          title: title || url,
          rent: rent == null ? null : Math.round(rent),
          rooms
        };
      })
      .filter(Boolean);

    console.log(`API ${endpoint.origin}: ${mapped.length} boligkandidater`);
    return mapped;
  } catch (error) {
    console.warn(`API-kilde fejlede: ${error.message}`);
    return [];
  }
}

async function collectListings() {
  const apiCandidates = await collectListingsFromApi();
  if (apiCandidates.length > 0) {
    return dedupeByUrl(apiCandidates);
  }

  const baseHost = new URL(BASE_URL).host;
  const candidates = [];

  for (const candidatePath of CHECK_PATHS) {
    const targetUrl = toAbsoluteUrl(candidatePath, BASE_URL);
    if (!targetUrl) continue;

    try {
      const html = await fetchText(targetUrl);
      const links = extractLinksFromHtml(html, targetUrl, baseHost);
      candidates.push(...links);
      console.log(`Scannet ${targetUrl}: ${links.length} kandidater`);
    } catch (error) {
      console.warn(`Kunne ikke læse ${targetUrl}: ${error.message}`);
    }
  }

  if (candidates.length === 0) {
    try {
      const sitemapUrl = toAbsoluteUrl("/sitemap.xml", BASE_URL);
      const sitemapXml = await fetchText(sitemapUrl);
      const sitemapCandidates = extractUrlsFromSitemap(sitemapXml, BASE_URL, baseHost);
      candidates.push(...sitemapCandidates);
      console.log(`Fallback sitemap: ${sitemapCandidates.length} kandidater`);
    } catch (error) {
      console.warn(`Sitemap fallback fejlede: ${error.message}`);
    }
  }

  return dedupeByUrl(candidates);
}

async function main() {
  validateConfig();

  const [state, currentListings] = await Promise.all([loadState(), collectListings()]);

  if (currentListings.length === 0) {
    throw new Error(
      "Fandt ingen listing-links. Opdater CHECK_PATHS eller hint-regler i scripts/monitor.mjs."
    );
  }

  const knownSet = new Set(state.knownUrls);
  const newListings = currentListings.filter((item) => !knownSet.has(item.url));
  const mergedKnownUrls = [...new Set([...state.knownUrls, ...currentListings.map((item) => item.url)])];

  if (!state.initialized || state.sourceVersion !== SOURCE_VERSION) {
    const reason = !state.initialized ? "Første kørsel" : "Datakilde opdateret";
    console.log(`${reason}: gemmer baseline (${mergedKnownUrls.length} links), sender ingen mail.`);
    await saveState({ knownUrls: mergedKnownUrls, sourceVersion: SOURCE_VERSION });
    return;
  }

  if (newListings.length > 0) {
    console.log(`Nye lejligheder fundet: ${newListings.length}. Tjekker kriterier...`);
    const detailedListings = await enrichListings(newListings);
    const matchingListings = detailedListings.filter((item) => meetsCriteria(item));

    if (matchingListings.length > 0) {
      console.log(
        `Matcher kriterier (${matchingListings.length}/${newListings.length}). Sender mail til ${EMAIL_TO}.`
      );
      await sendEmail(matchingListings);
    } else {
      console.log("Ingen nye lejligheder matcher kriterierne.");
    }
  } else {
    console.log("Ingen nye lejligheder.");
  }

  await saveState({ knownUrls: mergedKnownUrls, sourceVersion: SOURCE_VERSION });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
