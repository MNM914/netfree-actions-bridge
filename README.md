# Authenticated Actions bridge

This public repository contains only the HTTP/JSON bridge server and a manually triggered workflow. It contains no client vault, bridge key, GitHub token, browsing data, or connection settings.

The owner must configure the repository Actions secret `BRIDGE_KEY` before running the workflow. The key must be at least 16 characters and match the local client's encrypted vault. Never supply a key as a workflow input or commit it to this repository.

The published workflow currently remains read-only. Run **Actions → Temporary bridge → Run workflow**, copy the URL from the run summary, and paste it into the local client's GitHub Actions address field. The URL is temporary and the workflow ends after at most 350 minutes.

The workflow in this local source folder contains a proposed automatic-discovery update that has **not been published** to the public repository. If approved and deployed, it will publish `status/current.json` with only the temporary URL and run ID. The client will confirm through GitHub's API that the run remains active and then send an authenticated health request before changing its configuration. An old status file will be ignored.

The proposed workflow needs `contents: write` to update `status/current.json`. Its GitHub token would be exposed only to the publishing step, not the bridge or tunnel processes. Automatic approval review rejected this permission expansion pending explicit approval. The status file would be public and contain no key. Anyone with the client bridge key can use a live endpoint, so protect the encrypted client package and use a strong vault password.

The local client requires HTTPS, checks the certificate, and fails closed if the bridge is unavailable. The bridge requires the key for all `/api/bridge` requests, permits only ports 80/443 and public IPv4 destinations, and listens only on the runner's loopback interface. The public `/healthz` endpoint reveals only a boolean.

There is no assertion here that a Quick Tunnel is reachable through NetFree. That must be tested on NetFree itself. Cloudflare says Quick Tunnels are intended for testing, have no uptime guarantee, and currently allow up to 200 concurrent in-flight requests.

