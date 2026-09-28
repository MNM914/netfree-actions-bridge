# Authenticated Actions bridge

This public repository contains only the HTTP/JSON bridge server and a manually triggered workflow. It contains no client vault, bridge key, GitHub token, browsing data, or connection settings.

The owner must configure the repository Actions secret `BRIDGE_KEY` before running the workflow. The key must be at least 16 characters and match the local client's encrypted vault. Never supply a key as a workflow input or commit it to this repository.

Run **Actions → Temporary bridge → Run workflow**. Once the tunnel is ready, the workflow publishes `status/current.json` with only the temporary URL and run ID. The local client reads this public file, confirms through GitHub's API that the specified workflow run is still active, then sends an authenticated health request before changing its configuration. No GitHub token or pasted address is needed on the client. The URL also appears in the run summary and artifact. The workflow ends after at most 350 minutes; start a new run for another session. An old status file is ignored when its run is no longer active.

The workflow also starts on a UTC schedule every four hours at minute 17. Runs can overlap; the previous runner stays online until its own 350-minute timeout while the newer runner publishes its address. The client checks for a newer active run every five minutes and routes new connections to it without restarting the local proxy. Connections already open on the old runner stay there and may be interrupted when that runner exits. GitHub may delay or drop scheduled runs, and schedules in inactive public repositories can be disabled after 60 days, so this is not an uptime guarantee. A manual **Run workflow** remains available.

The workflow has `contents: write` to update `status/current.json`. Its GitHub token is exposed only to the publishing step, not the bridge or tunnel processes. The status file is public and contains no key. Anyone with the client bridge key can use a live endpoint, so protect the encrypted client package and use a strong vault password. If automatic GitHub API discovery is unavailable on a network, the client also accepts a manually pasted URL from the active run summary.

The local client requires HTTPS, checks the certificate, and fails closed if the bridge is unavailable. The bridge requires the key for all `/api/bridge` requests, permits only ports 80/443 and public IPv4 destinations, and listens only on the runner's loopback interface. The public `/healthz` endpoint reveals only a boolean.

There is no assertion here that a Quick Tunnel is reachable through NetFree. That must be tested on NetFree itself. Cloudflare says Quick Tunnels are intended for testing, have no uptime guarantee, and currently allow up to 200 concurrent in-flight requests.

