set default-list

# Use the macOS app's CLI when available; TAILSCALE_BIN can override it.
tailscale_app := '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
tailscale_cli := if path_exists(tailscale_app) == 'true' { tailscale_app } else { 'tailscale' }
export TAILSCALE_BIN := env('TAILSCALE_BIN', tailscale_cli)

# Verify prepared Victor assets; download and rebuild the full bundle when needed.
[group('run')]
prepare-victor:
    node scripts/victor/prepare-victor-assets.mjs

# Configure persistent Tailscale HTTPS, then prepare Victor and start Pi Pocket.
[group('run')]
start: tailscale-setup start-local

# Prepare Victor, then start on 127.0.0.1:8787 without changing Tailscale Serve.
[group('run')]
start-local: prepare-victor
    npm start -- --access local --host 127.0.0.1 --port 8787 --cwd "${PI_POCKET_CWD:-$PWD}"

# Proxy tailnet-only HTTPS on port 8443; leave the existing port-443 service alone.
[group('tailscale')]
tailscale-setup:
    "$TAILSCALE_BIN" serve --bg --https=8443 http://127.0.0.1:8787

# Remove only the port-8443 HTTPS proxy; leave the port-443 service alone.
[group('tailscale')]
tailscale-stop:
    "$TAILSCALE_BIN" serve --https=8443 off

# Show Tailscale Serve routes and their HTTPS addresses.
[group('tailscale')]
tailscale-status:
    "$TAILSCALE_BIN" serve status

# Fetch upstream; show incoming updates, recent fork history, and local changes.
[group('repo')]
repo-status:
    @node scripts/victor/fork.mjs status

# Run TypeScript and focused Victor/shared tests; no formatting or Git changes.
[group('repo')]
check:
    node scripts/victor/fork.mjs check

# Fetch fork main, then confirm a new $USER/SLUG feature branch; requires a clean checkout.
[group('repo')]
feature $slug:
    node scripts/victor/fork.mjs feature "$slug"

# Fetch, then confirm a new sync/upstream-NAME branch merging upstream/main; never push.
[group('repo')]
upstream-update $name:
    node scripts/victor/fork.mjs upstream-update "$name"

# Confirm, push the current branch, and open a prefixed PR; omit description for upstream updates.
[group('repo')]
pr $description='':
    node scripts/victor/fork.mjs pr "$description"

# Confirm and tag already reviewed/tested clean main as victor/vVERSION (X.Y.Z); no local checks or deployment.
[group('repo')]
release $version:
    node scripts/victor/fork.mjs release "$version"
