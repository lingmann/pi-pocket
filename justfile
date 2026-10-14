set default-list
set positional-arguments

# Use the macOS app's CLI when available; TAILSCALE_BIN can override it.
tailscale_app := '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
tailscale_cli := if path_exists(tailscale_app) == 'true' { tailscale_app } else { 'tailscale' }
export TAILSCALE_BIN := env('TAILSCALE_BIN', tailscale_cli)

# Prepare Victor speech assets.
[group('run')]
prepare-victor:
    @node scripts/victor/prepare-victor-assets.mjs

# Start Pi Pocket with Tailscale HTTPS.
[group('run')]
start: tailscale-setup start-local

# Start Pi Pocket locally without configuring Tailscale.
[group('run')]
start-local: prepare-victor
    npm start -- --access local --host 127.0.0.1 --port 8787 --cwd "${PI_POCKET_CWD:-$PWD}"

# Enable Pi Pocket's Tailscale HTTPS proxy.
[group('tailscale')]
tailscale-setup:
    "$TAILSCALE_BIN" serve --bg --https=8443 http://127.0.0.1:8787

# Disable Pi Pocket's Tailscale HTTPS proxy.
[group('tailscale')]
tailscale-stop:
    "$TAILSCALE_BIN" serve --https=8443 off

# Show Tailscale Serve routes.
[group('tailscale')]
tailscale-status:
    "$TAILSCALE_BIN" serve status

# Fetch upstream and show repository status.
[group('repo')]
repo-status:
    @node scripts/victor/fork.mjs status

# Run TypeScript and focused tests.
[group('repo')]
check:
    @node scripts/victor/fork.mjs check

# Create a feature branch.
[arg('slug', help='Branch suffix, e.g. voice-fix; creates $USER/SLUG from fetched origin/main. Requires a clean checkout and confirmation.')]
[group('repo')]
feature slug:
    @node scripts/victor/fork.mjs feature "$@"

# Merge upstream updates on a new branch.
[arg('name', help='Branch label, e.g. v0.13.3; creates sync/upstream-NAME and merges upstream/main. Requires a clean checkout and confirmation. Does not push.')]
[group('repo')]
upstream-update name:
    @node scripts/victor/fork.mjs upstream-update "$@"

# Push this branch and open a pull request.
[arg('description', help='Quoted PR description; required for features, optional for upstream updates. Must not start with - after ignoring leading whitespace. Requires a clean checkout and confirmation.')]
[group('repo')]
pr description='':
    @node scripts/victor/fork.mjs pr "$@"

# Publish a Victor release tag.
[arg('version', help='X.Y.Z, e.g. 1.2.3; publishes victor/vX.Y.Z from reviewed/tested clean main after confirmation. Does not run local checks or deploy.')]
[group('repo')]
release version:
    @node scripts/victor/fork.mjs release "$@"
