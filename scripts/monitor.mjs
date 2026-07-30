import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const SOURCE_VERSION = 1;
const DEFAULT_STATE_PATH = path.join(projectRoot, "state", "seen.json");

const config = {
  baseUrl: process.env.BASE_URL || "https://kerebyudlejning.dk",
  rentalsApiBaseUrl: process.env.RENTALS_API_BASE_URL || "https://api.jorato.com",
  rentalsApiKey: process.env.RENTALS_API_KEY || "",
  statePath: process.env.STATE_PATH || DEFAULT_STATE_PATH,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15000),
  timezone: process.env.MONITOR_TIMEZONE || "Europe/Copenhagen",
  startHour: Number(process.env.MONITOR_START_HOUR || 8),
  endHour: Number(process.env.MONITOR_END_HOUR || 16),
  maxRent: Number(process.env.MAX_RENT || 9500),
  minRooms: Number(process.env.MIN_ROOMS || 0),
  emailTo: process.env.EMAIL_TO || "emma.strandholt7000@gmail.com",
  emailFrom: process.env.EMAIL_FROM || "",
  emailSubjectPrefix: process.env.EMAIL_SUBJECT_PREFIX || "Ny lejlighed på Kereby",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || ""
};

function validateConfig() {
  const missing = [
    ["RENTALS_API_KEY", config.rentalsApiKey],
    ["EMAIL_FROM", config.emailFrom],
    ["SMTP_HOST", config.smtpHost],
    ["SMTP_USER", config.smtpUser],
    ["SMTP_PASS", config.smtpPass]
  ]
    .filter((entry) => !entry[1])
    .map((entry) => entry[0]);

  if (missing.length > 0) {
    throw new Error(`Mangler env vars: ${missing.join(", ")}`);
  }

  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 1000) {
    throw new Error(`Ugyldig POLL_INTERVAL_MS: ${process.env.POLL_INTERVAL_MS}`);
  }

  if (!Number.isFinite(config.maxRent) || config.maxRent <= 0) {
    throw new Error(`Ugyldig MAX_RENT: ${process.env.MAX_RENT}`);
  }

  if (!Number.isFinite(config.minRooms) || config.minRooms < 0) {
    throw new Error(`Ugyldig MIN_ROOMS: ${process.env.MIN_ROOMS}`);
  }

  if (!Number.isInteger(config.startHour) || config.startHour < 0 || config.startHour > 23) {
    throw new Error(`Ugyldig MONITOR_START_HOUR: ${process.env.MONITOR_START_HOUR}`);
  }

  if (!Number.isInteger(config.endHour) || config.endHour < 0 || config.endHour > 23) {
    throw new Error(`Ugyldig MONITOR_END_HOUR: ${process.env.MONITOR_END_HOUR}`);
  }

  if (config.startHour > config.endHour) {
    throw new Error("MONITOR_START_HOUR må ikke være større end MONITOR_END_HOUR.");
  }

  if (!Number.isFinite(config.smtpPort) || config.smtpPort <= 0) {
    throw new Error(`Ugyldig SMTP_PORT: ${process.env.SMTP_PORT}`);
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function slugifyAddress(address) {
  const joined = [address?.street, address?.zipCode, address?.city].filter(Boolean).join(" ");
  const normalized = normalizeText(joined)
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;
  return normalized.replace(/\s/g, "-");
}

function toNumber(value) {
  if (value == null || value === "") return null;

  let cleaned = String(value).replace(/\u00a0/g, " ").trim().replace(/\s+/g, "");
  if (!cleaned) return null;

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  if (hasComma && hasDot) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    cleaned = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (!/\.\d{1,2}$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "");
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatRent(value) {
  if (value == null) return "ukendt";
  return new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 }).format(value);
}

function formatRooms(value) {
  if (value == null) return "ukendt";
  return String(value).replace(".", ",");
}

function getCriteriaText() {
  if (config.minRooms <= 0) {
    return `Husleje maks ${formatRent(config.maxRent)} kr`;
  }

  return `Husleje maks ${formatRent(config.maxRent)} kr og mindst ${formatRooms(config.minRooms)} værelser`;
}

function getClockParts(timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const second = Number(parts.find((part) => part.type === "second")?.value);

  return { hour, minute, second };
}

function isWithinWindow() {
  const { hour, minute, second } = getClockParts(config.timezone);

  if (![hour, minute, second].every(Number.isFinite)) {
    throw new Error(`Kunne ikke læse lokal tid for timezone ${config.timezone}`);
  }

  if (hour < config.startHour || hour > config.endHour) {
    return false;
  }

  if (hour === config.endHour && (minute > 0 || second > 0)) {
    return false;
  }

  return true;
}

function getOutsideWindowMessage() {
  return `Uden for overvågningsvindue (${config.startHour}:00-${config.endHour}:00 ${config.timezone}). Springer over.`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "KerebyRenderMonitor/2.0"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

async function loadState() {
  try {
    const raw = await fs.readFile(config.statePath, "utf8");
    const parsed = JSON.parse(raw);

    return {
      initialized: Boolean(parsed.initialized),
      sourceVersion: Number(parsed.sourceVersion || 0),
      seenKeys: Array.isArray(parsed.seenKeys) ? parsed.seenKeys : []
    };
  } catch {
    return {
      initialized: false,
      sourceVersion: 0,
      seenKeys: []
    };
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(config.statePath), { recursive: true });

  const payload = {
    initialized: true,
    sourceVersion: Number(state.sourceVersion || SOURCE_VERSION),
    seenKeys: [...new Set(state.seenKeys)].sort(),
    lastCheckedAt: new Date().toISOString()
  };

  await fs.writeFile(config.statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function buildListingUrl(address) {
  const slug = slugifyAddress(address);
  if (!slug) return null;
  return new URL(`/bolig/${slug}`, config.baseUrl).href;
}

function mapListing(item) {
  if (item?.classification !== "Residential") {
    return null;
  }

  const url = buildListingUrl(item.address);
  if (!url) return null;

  const title =
    item.title ||
    [item.address?.street, item.address?.zipCode, item.address?.city].filter(Boolean).join(", ") ||
    url;

  const rent = toNumber(item.monthlyRent?.value);
  const rooms = toNumber(item.rooms);
  const key = String(item.id || url);

  return {
    key,
    url,
    title,
    rent: rent == null ? null : Math.round(rent),
    rooms
  };
}

async function collectListings() {
  const endpoint = new URL("/tenancies", config.rentalsApiBaseUrl);
  endpoint.searchParams.set("visibility", "public");
  endpoint.searchParams.set("showAll", "true");
  endpoint.searchParams.set("key", config.rentalsApiKey);

  const payload = await fetchJson(endpoint.href);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const listings = [];
  const seenKeys = new Set();

  for (const item of items) {
    const listing = mapListing(item);
    if (!listing) continue;
    if (seenKeys.has(listing.key)) continue;
    seenKeys.add(listing.key);
    listings.push(listing);
  }

  console.log(`API ${endpoint.origin}: ${listings.length} boligkandidater`);
  return listings;
}

function matchesCriteria(listing) {
  if (listing.rent == null || listing.rent > config.maxRent) {
    return false;
  }

  if (config.minRooms <= 0) {
    return true;
  }

  return listing.rooms != null && listing.rooms >= config.minRooms;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createTransport() {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass
    }
  });
}

async function sendEmail(listings) {
  const criteriaText = getCriteriaText();
  const transporter = createTransport();
  const subject = `${config.emailSubjectPrefix}: ${listings.length} ny${listings.length === 1 ? "" : "e"}`;

  const textLines = [
    "Der er kommet nye lejligheder på Kereby.",
    criteriaText,
    "",
    ...listings.map(
      (listing) =>
        `- ${listing.title}: ${listing.url} (husleje: ${formatRent(listing.rent)} kr, værelser: ${formatRooms(listing.rooms)})`
    ),
    "",
    `Tjekket: ${new Date().toLocaleString("da-DK", { timeZone: config.timezone })}`
  ];

  const htmlItems = listings
    .map(
      (listing) =>
        `<li><a href="${escapeHtml(listing.url)}">${escapeHtml(listing.title)}</a> (husleje: ${escapeHtml(
          formatRent(listing.rent)
        )} kr, værelser: ${escapeHtml(formatRooms(listing.rooms))})</li>`
    )
    .join("");

  await transporter.sendMail({
    from: config.emailFrom,
    to: config.emailTo,
    subject,
    text: textLines.join("\n"),
    html: `
      <p>Der er kommet nye lejligheder på <a href="${escapeHtml(config.baseUrl)}">Kereby</a>.</p>
      <p>${escapeHtml(criteriaText)}</p>
      <ul>${htmlItems}</ul>
      <p>Tjekket: ${escapeHtml(new Date().toLocaleString("da-DK", { timeZone: config.timezone }))}</p>
    `
  });
}

async function runMonitorCycle({ logOutsideWindow = true } = {}) {
  if (!isWithinWindow()) {
    if (logOutsideWindow) {
      console.log(getOutsideWindowMessage());
    }

    return { status: "outside-window" };
  }

  const [state, currentListings] = await Promise.all([loadState(), collectListings()]);

  if (currentListings.length === 0) {
    throw new Error("Fandt ingen boligkandidater i Kerebys API.");
  }

  const currentKeys = currentListings.map((listing) => listing.key);
  const seenSet = new Set(state.seenKeys);
  const newListings = currentListings.filter((listing) => !seenSet.has(listing.key));
  const mergedSeenKeys = [...new Set([...state.seenKeys, ...currentKeys])];

  if (!state.initialized || state.sourceVersion !== SOURCE_VERSION) {
    const reason = state.initialized ? "State-format ændret" : "Første kørsel";
    console.log(`${reason}: gemmer baseline (${mergedSeenKeys.length} kendte lejligheder), sender ingen mail.`);
    await saveState({ seenKeys: mergedSeenKeys, sourceVersion: SOURCE_VERSION });
    return { status: "baseline" };
  }

  if (newListings.length === 0) {
    console.log("Ingen nye lejligheder.");
    return { status: "no-new" };
  }

  await saveState({ seenKeys: mergedSeenKeys, sourceVersion: SOURCE_VERSION });
  console.log(`Nye lejligheder fundet: ${newListings.length}. Filtrerer på kriterier...`);

  const matchingListings = newListings.filter(matchesCriteria);
  if (matchingListings.length === 0) {
    console.log("Ingen nye lejligheder matcher kriterierne.");
    return { status: "no-match" };
  }

  console.log(`Sender ${matchingListings.length} notifikation(er) til ${config.emailTo}.`);
  await sendEmail(matchingListings);
  return { status: "sent" };
}

async function runWorker() {
  console.log(
    `Starter Render worker. Poll interval: ${Math.round(config.pollIntervalMs / 1000)} sekunder. Tidsvindue: ${config.startHour}:00-${config.endHour}:00 ${config.timezone}.`
  );

  let logOutsideWindow = true;

  while (true) {
    try {
      const result = await runMonitorCycle({ logOutsideWindow });
      logOutsideWindow = result.status !== "outside-window";
    } catch (error) {
      console.error(error);
      logOutsideWindow = true;
    }

    await sleep(config.pollIntervalMs);
  }
}

validateConfig();
runWorker().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
