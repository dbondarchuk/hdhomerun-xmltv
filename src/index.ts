import compression from "compression";
import express, { type Request, type Response } from "express";
import os from "node:os";

const app = express();

const PORT = Number(process.env.PORT ?? 8080);
const LAN_CIDRS = (process.env.LAN_CIDRS ?? process.env.LAN_CIDR ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
const GUIDE_REFRESH_INTERVAL_MS = Number(
  process.env.GUIDE_REFRESH_INTERVAL_MS ?? 12 * 60 * 60 * 1000
);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 2500);
const SCAN_CONCURRENCY = Math.max(1, Number(process.env.SCAN_CONCURRENCY ?? 64));
const MAX_ADDRESSES_PER_CIDR = 65536;
const MAX_GUIDE_BYTES = Number(process.env.MAX_GUIDE_BYTES ?? 100 * 1024 * 1024);

interface HDHomeRunDevice {
  ip: string;
  deviceId: string;
  deviceAuth: string;
  modelNumber?: string;
  friendlyName?: string;
  firmwareName?: string;
  firmwareVersion?: string;
}

interface DiscoverResponse {
  DeviceID?: string;
  DeviceAuth?: string;
  ModelNumber?: string;
  FriendlyName?: string;
  FirmwareName?: string;
  FirmwareVersion?: string;
}

let devices: HDHomeRunDevice[] = [];
let guideXml: string | null = null;
let guideFetchedAt: number | null = null;
let lastScanAt: number | null = null;
let refreshInFlight: Promise<void> | null = null;
let lastError: string | null = null;

function log(message: string, details?: unknown): void {
  if (details) console.log(`[${new Date().toISOString()}] ${message}`, details);
  else console.log(`[${new Date().toISOString()}] ${message}`);
}

async function fetchWithTimeout(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<globalThis.Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

function ipv4ToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function numberToIpv4(value: number): string {
  const n = value >>> 0;
  return [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255
  ].join(".");
}

/**
 * Expands an IPv4 CIDR into usable host addresses.
 * /31 and /32 are handled as their actual addresses.
 */
function expandCidr(cidr: string): string[] {
  const [ip, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);

  if (!ip || prefixText === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }

  const ipNumber = ipv4ToNumber(ip);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipNumber & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = prefix === 32 ? 1 : prefix === 31 ? 2 : Math.max(0, broadcast - network - 1);

  if (total > MAX_ADDRESSES_PER_CIDR) {
    throw new Error(`${cidr} contains ${total} addresses; maximum is ${MAX_ADDRESSES_PER_CIDR}`);
  }

  if (prefix === 32) return [numberToIpv4(network)];
  if (prefix === 31) return [numberToIpv4(network), numberToIpv4(broadcast)];

  return Array.from({ length: total }, (_, index) => numberToIpv4(network + index + 1));
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );

  return results;
}

async function probeDevice(ip: string): Promise<HDHomeRunDevice | null> {
  try {
    const response = await fetchWithTimeout(`http://${ip}/discover.json`);
    if (!response.ok) return null;

    const data = (await response.json()) as DiscoverResponse;
    if (!data.DeviceID || !data.DeviceAuth) return null;

    return {
      ip,
      deviceId: data.DeviceID,
      deviceAuth: data.DeviceAuth,
      modelNumber: data.ModelNumber,
      friendlyName: data.FriendlyName,
      firmwareName: data.FirmwareName,
      firmwareVersion: data.FirmwareVersion
    };
  } catch {
    return null;
  }
}

function getLocalCidrs(): string[] {
  const cidrs: string[] = [];
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const prefix = entry.cidr?.split("/")[1];
      if (entry.cidr && prefix) cidrs.push(entry.cidr);
    }
  }

  return [...new Set(cidrs)];
}

async function discoverDevices(): Promise<void> {
  const cidrs = LAN_CIDRS.length ? LAN_CIDRS : getLocalCidrs();

  if (!cidrs.length) {
    throw new Error("No IPv4 CIDRs found. Set LAN_CIDRS, for example 192.168.1.0/24");
  }

  const addresses = [...new Set(cidrs.flatMap(expandCidr))];
  log(`Scanning ${addresses.length} addresses from: ${cidrs.join(", ")}`);

  const found = await mapWithConcurrency(addresses, SCAN_CONCURRENCY, probeDevice);
  const unique = new Map<string, HDHomeRunDevice>();

  for (const device of found) {
    if (device) unique.set(device.deviceId, device);
  }

  devices = [...unique.values()];
  lastScanAt = Date.now();

  log(`Discovered ${devices.length} HDHomeRun tuner(s)`);
}

async function readResponseTextLimited(response: globalThis.Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_GUIDE_BYTES) {
    throw new Error(`Guide response is too large (${declaredLength} bytes)`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_GUIDE_BYTES) {
    throw new Error(`Guide response exceeded ${MAX_GUIDE_BYTES} bytes`);
  }

  return new TextDecoder("utf-8").decode(buffer);
}

async function fetchGuide(): Promise<void> {
  if (devices.length === 0) {
    throw new Error("No HDHomeRun devices discovered");
  }

  // SiliconDust accepts the DeviceAuth values for multiple tuners concatenated.
  const deviceAuth = devices.map((device) => device.deviceAuth).join("");
  const url = new URL("https://api.hdhomerun.com/api/xmltv");
  url.searchParams.set("DeviceAuth", deviceAuth);

  log(`Fetching XMLTV guide for ${devices.length} tuner(s)`);

  const response = await fetchWithTimeout(url.toString(), 60_000);
  if (!response.ok) {
    throw new Error(`SiliconDust XMLTV API returned HTTP ${response.status}`);
  }

  const xml = await readResponseTextLimited(response);
  if (!/<tv(?:\s|>)/i.test(xml) || !/<channel(?:\s|>)/i.test(xml)) {
    throw new Error("SiliconDust returned a response that does not look like XMLTV");
  }

  guideXml = xml;
  guideFetchedAt = Date.now();
  lastError = null;
  log(`XMLTV guide updated (${Buffer.byteLength(xml)} bytes)`);
}

async function refreshAll(forceGuide = false): Promise<void> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const scanIsStale =
        lastScanAt === null || Date.now() - lastScanAt >= SCAN_INTERVAL_MS;

      if (scanIsStale || devices.length === 0) {
        await discoverDevices();
      }

      const guideIsStale =
        guideXml === null ||
        guideFetchedAt === null ||
        Date.now() - guideFetchedAt >= GUIDE_REFRESH_INTERVAL_MS;

      if (forceGuide || guideIsStale) {
        await fetchGuide();
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

app.disable("x-powered-by");
app.use(compression());
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    discoveredDevices: devices.length,
    guideAvailable: guideXml !== null,
    guideFetchedAt: guideFetchedAt ? new Date(guideFetchedAt).toISOString() : null,
    lastScanAt: lastScanAt ? new Date(lastScanAt).toISOString() : null,
    lastError
  });
});

app.get("/devices", (_req: Request, res: Response) => {
  // DeviceAuth is deliberately never returned by this endpoint.
  res.json(
    devices.map((device) => ({
      ip: device.ip,
      deviceId: device.deviceId,
      modelNumber: device.modelNumber,
      friendlyName: device.friendlyName,
      firmwareName: device.firmwareName,
      firmwareVersion: device.firmwareVersion
    }))
  );
});

async function serveGuide(_req: Request, res: Response): Promise<void> {
  try {
    await refreshAll();
    if (!guideXml) {
      res.status(503).type("text/plain").send("Guide is not available yet");
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(guideXml);
  } catch (error) {
    log("Guide request failed", error);
    if (guideXml) {
      // Keep Jellyfin working with the last known good guide during temporary upstream failures.
      res.setHeader("Warning", '110 - "Response is stale"');
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.send(guideXml);
      return;
    }

    res.status(502).type("text/plain").send("Unable to retrieve XMLTV guide");
  }
}

app.get("/guide.xml", serveGuide);

// Alias for clients where a conventional XMLTV path is convenient.
app.get("/xmltv.xml", serveGuide);

app.post("/refresh", async (_req: Request, res: Response) => {
  try {
    await refreshAll(true);
    res.json({
      success: true,
      discoveredDevices: devices.length,
      guideFetchedAt: guideFetchedAt ? new Date(guideFetchedAt).toISOString() : null
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  log(`HDHomeRun XMLTV service listening on port ${PORT}`);
  void refreshAll(true).catch((error) => log("Initial refresh failed", error));
});

// Periodic refresh: rediscover devices, then refresh guide if needed.
const scheduler = setInterval(() => {
  void (async () => {
    try {
      await discoverDevices();
      await fetchGuide();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log("Scheduled refresh failed", error);
    }
  })();
}, SCAN_INTERVAL_MS);

function shutdown(): void {
  clearInterval(scheduler);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
