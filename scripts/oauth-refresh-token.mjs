import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const tenantId = process.env.SMTP_OAUTH_TENANT_ID || "common";
const clientId = process.env.SMTP_OAUTH_CLIENT_ID;
const clientSecret = process.env.SMTP_OAUTH_CLIENT_SECRET;
const redirectUri = process.env.SMTP_OAUTH_REDIRECT_URI || "http://localhost";
const scope = process.env.SMTP_OAUTH_SCOPE || "offline_access https://outlook.office.com/SMTP.Send";
const envPath = process.env.ENV_PATH || path.join(projectRoot, ".env");

function getTokenUrl() {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

function getAuthorizeUrl() {
  const url = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", scope);
  return url.toString();
}

function extractCode(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (!trimmed.includes("://")) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    return url.searchParams.get("code");
  } catch {
    return null;
  }
}

function redactToken(token) {
  if (!token || token.length < 16) return "***";
  return `${token.slice(0, 8)}...${token.slice(-8)}`;
}

async function writeRefreshTokenToEnv(refreshToken) {
  let current = "";
  try {
    current = await fs.readFile(envPath, "utf8");
  } catch {
    current = "";
  }

  const newLine = `SMTP_OAUTH_REFRESH_TOKEN=${refreshToken}`;
  let updated;
  if (/^SMTP_OAUTH_REFRESH_TOKEN=.*$/m.test(current)) {
    updated = current.replace(/^SMTP_OAUTH_REFRESH_TOKEN=.*$/m, newLine);
  } else {
    const separator = current.endsWith("\n") || current.length === 0 ? "" : "\n";
    updated = `${current}${separator}${newLine}\n`;
  }

  await fs.writeFile(envPath, updated, "utf8");
}

async function exchangeCodeForRefreshToken(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    scope
  });

  const response = await fetch(getTokenUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Token-fejl (${response.status}): ${JSON.stringify(payload)}`);
  }

  if (!payload.refresh_token) {
    throw new Error(`Mangler refresh_token i svar: ${JSON.stringify(payload)}`);
  }

  return payload.refresh_token;
}

async function main() {
  if (!clientId || !clientSecret) {
    throw new Error("Mangler SMTP_OAUTH_CLIENT_ID eller SMTP_OAUTH_CLIENT_SECRET i miljøvariabler.");
  }

  const authUrl = getAuthorizeUrl();
  console.log("1) Åbn denne URL i browser og log ind:");
  console.log(authUrl);
  console.log("");
  console.log(`2) Efter redirect til ${redirectUri}, kopier hele URL'en fra browserens adressefelt.`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const pasted = await rl.question("Indsæt redirect-URL (eller kun code): ");
  const code = extractCode(pasted);
  if (!code) {
    rl.close();
    throw new Error("Kunne ikke finde authorization code i input.");
  }

  const refreshToken = await exchangeCodeForRefreshToken(code);
  console.log(`Refresh token hentet: ${redactToken(refreshToken)}`);

  const save = await rl.question(`Vil du skrive refresh token til ${envPath}? (y/N): `);
  rl.close();

  if (save.trim().toLowerCase() === "y") {
    await writeRefreshTokenToEnv(refreshToken);
    console.log(`Skrev SMTP_OAUTH_REFRESH_TOKEN til ${envPath}`);
  } else {
    console.log("Ingen filer blev ændret.");
    console.log(`Manuel værdi: SMTP_OAUTH_REFRESH_TOKEN=${refreshToken}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
