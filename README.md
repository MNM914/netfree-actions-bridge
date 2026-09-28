# Authenticated Actions bridge

This public repository contains only the HTTP/JSON bridge server and a manually triggered workflow. It contains no client vault, bridge key, GitHub token, browsing data, or connection settings.

The owner must configure the repository Actions secret `BRIDGE_KEY` before running the workflow. The key must be at least 16 characters and match the local client's encrypted vault. Never supply a key as a workflow input or commit it to this repository.

Run **Actions → Temporary bridge → Run workflow**. When the run prints an `https://...trycloudflare.com` URL, configure the local client to use that URL plus `/api/bridge`. The URL changes each run. The workflow ends after at most 350 minutes, and the URL ceases to work. Re-run it and update the local URL for another session.

The local client requires HTTPS, checks the certificate, and fails closed if the bridge is unavailable. The bridge requires the key for all `/api/bridge` requests, permits only ports 80/443 and public IPv4 destinations, and listens only on the runner's loopback interface. The public `/healthz` endpoint reveals only a boolean.

There is no assertion here that a Quick Tunnel is reachable through NetFree. That must be tested on NetFree itself. Cloudflare says Quick Tunnels are intended for testing, have no uptime guarantee, and currently allow up to 200 concurrent in-flight requests.
