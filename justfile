set default-list

# Use the macOS app's CLI when available; TAILSCALE_BIN can override it.
tailscale_app := '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
tailscale_cli := if path_exists(tailscale_app) == 'true' { tailscale_app } else { 'tailscale' }
export TAILSCALE_BIN := env('TAILSCALE_BIN', tailscale_cli)

# Verify prepared Victor assets; download and rebuild the full bundle when needed.
prepare-victor:
    node scripts/prepare-victor-assets.mjs

# Configure persistent Tailscale HTTPS, then prepare Victor and start Pi Pocket.
start: tailscale-setup start-local

# Prepare Victor, then start on 127.0.0.1:8787 without changing Tailscale Serve.
start-local: prepare-victor
    npm start -- --access local --host 127.0.0.1 --port 8787

# Proxy tailnet-only HTTPS on port 8443; leave the existing port-443 service alone.
tailscale-setup:
    "$TAILSCALE_BIN" serve --bg --https=8443 http://127.0.0.1:8787

# Remove only the port-8443 HTTPS proxy; leave the port-443 service alone.
tailscale-stop:
    "$TAILSCALE_BIN" serve --https=8443 off

# Show Tailscale Serve routes and their HTTPS addresses.
tailscale-status:
    "$TAILSCALE_BIN" serve status
