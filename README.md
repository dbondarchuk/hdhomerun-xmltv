# HDHomeRun XMLTV for Jellyfin

A small TypeScript/Node.js service that:

1. Scans configured IPv4 LAN subnets for HDHomeRun devices.
2. Reads `DeviceID` and `DeviceAuth` from each device's `/discover.json`.
3. Combines the `DeviceAuth` values and requests SiliconDust's XMLTV feed.
4. Caches the last successful guide.
5. Serves XMLTV to Jellyfin with HTTP gzip compression when the client advertises gzip.

The service does not store tuner credentials on disk and never returns `DeviceAuth` from its HTTP API.

## Run with Docker Compose

1. Copy this project to a machine that can reach the HDHomeRun tuners.
2. Edit `compose.yaml` and set `LAN_CIDRS` to the LAN subnet containing your tuners.
   Example: `192.168.1.0/24`.
3. Start it:

   ```sh
   docker compose up -d --build
   ```

4. Check discovery:

   ```sh
   curl http://localhost:8080/health
   curl http://localhost:8080/devices
   ```

5. Open the guide:

   ```sh
   curl -H 'Accept-Encoding: gzip' \
     http://localhost:8080/guide.xml \
     --output guide.xml.gz
   ```

   `curl` saves the compressed response when using `--raw`; without `--raw`, curl may transparently decompress it. To inspect the response headers:

   ```sh
   curl -I -H 'Accept-Encoding: gzip' http://localhost:8080/guide.xml
   ```

   The `compression` middleware only compresses when the request includes `Accept-Encoding: gzip` and the response is large enough to benefit.

## Jellyfin setup

1. In Jellyfin, open **Dashboard → Live TV**.
2. Add an **XMLTV** guide data provider.
3. Use this URL, replacing the host with the machine running the service:

   ```text
   http://YOUR_SERVER_IP:8080/guide.xml
   ```

4. Save the guide provider.
5. Add/configure your HDHomeRun tuner(s) as Live TV tuner devices in Jellyfin.
6. In Live TV channel management, map the tuner channels to the XMLTV channels if Jellyfin does not match them automatically.

The XMLTV guide provides channel/program metadata; it does not proxy the actual tuner streams. Jellyfin should connect to the HDHomeRun tuner directly for live TV.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Service health, discovery count, guide timestamp, last error |
| GET | `/devices` | Discovered tuners (without DeviceAuth) |
| GET | `/guide.xml` | XMLTV guide; gzip-compressed when requested |
| GET | `/xmltv.xml` | Alias for `/guide.xml` |
| POST | `/refresh` | Force device discovery and guide refresh |

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `8080` | HTTP listen port |
| `LAN_CIDRS` | auto-detect | Comma-separated IPv4 CIDRs to scan |
| `SCAN_INTERVAL_MS` | `21600000` | Rescan interval (6 hours) |
| `GUIDE_REFRESH_INTERVAL_MS` | `43200000` | XMLTV refresh interval (12 hours) |
| `SCAN_CONCURRENCY` | `64` | Parallel device probes |
| `REQUEST_TIMEOUT_MS` | `2500` | Per-device HTTP timeout |
| `MAX_GUIDE_BYTES` | `104857600` | Maximum XMLTV response size |

If `LAN_CIDRS` is omitted, the service scans IPv4 CIDRs found on its own network interfaces. In Docker, explicitly setting `LAN_CIDRS` is recommended.

## Network notes

- The container needs outbound access to the tuner subnet on TCP port 80.
- It also needs outbound HTTPS access to `api.hdhomerun.com`.
- On Linux, `network_mode: host` is an option if bridge networking cannot reach the tuner subnet. If you enable it, remove the `ports` mapping.
- Docker Desktop on macOS/Windows uses a VM/network layer; bridge mode with an explicit `LAN_CIDRS` is generally the first thing to try. Confirm that the Docker host can reach `http://TUNER_IP/discover.json`.
- Scanning large subnets is intentionally capped. Use the smallest relevant subnet.

## Security

This service is intended for a trusted LAN. It has no authentication. Do not expose port 8080 to the public internet. The refresh endpoint is also unauthenticated.
