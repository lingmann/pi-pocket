<div align="center">

# Pi Pocket

**Your Pi coding agent, in your pocket.**

A durable, multiplayer, mobile-first web app for Pi agents, built on [Pi Durable](https://earendil.com/posts/pi-durable/).<br>
Runs on your own machine or directly on your phone. No cloud VM.

[![Release](https://img.shields.io/github/v/release/TannerMidd/pi-pocket?color=7aa2f7)](https://github.com/TannerMidd/pi-pocket/releases)
[![Node.js 22.19+](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-ff9e64)](LICENSE)

[Website](https://tannermidd.github.io/pi-pocket/) · [Quick start](#quick-start) · [Feature tour](docs/features.md) · [Docs](https://tannermidd.github.io/pi-pocket/docs/)

<img src="docs/showcase-0.12.1.png" alt="Pi Pocket in the Tokyo Night theme, on a desktop and a phone. On the desktop, the session list beside a conversation where Pi has fixed a sign-in redirect loop, its edits and a passing run of 48 tests folded into a timeline. On the phone, the same session after a teammate, Alex, asks for the push: Lancet Guard waits for approval before git push." width="100%">

</div>

## Highlights

- **Durable.** Every model call, tool call, and subagent is stored as it happens. Restart the server mid-run, and the work continues.
- **Multiplayer.** Share a live session with presence, a side chat Pi does not see, invites, and roles.
- **Made for phones.** Push notifications, dictation, sharing into Pi from other apps, and a home-screen app.
- **Victor (experimental, English).** This fork's separate on-device conversation mode recognizes speech and reads Pi's replies locally. Tap **Victor**, then say “send it” to submit. Prepare the pinned assets with `node scripts/victor/prepare-victor-assets.mjs`; the first browser download is about 149 MB. See [Victor setup and limits](docs/victor.md).
- **PiP.** An assistant that starts, follows, and reports on your other sessions, and watches GitHub for you.
- **Your models.** Pi's own providers, sign-ins, skills, and prompt templates, with the model chosen per session.
- **Live-editable.** No build step. Pi can change Pi Pocket while it runs, and you can add your own extensions.

The [feature tour](docs/features.md) covers everything else, from plan mode and peek tiles to the built-in browser.

## Quick start

Requires Node.js 22.19 or newer. Runs on Linux, macOS, Windows, and Android (Termux); Linux is the most tested. Sign in to a provider with Pi first (`pi`, then `/login`), or later from the app's Providers sheet.

```bash
npm install -g pi-pocket
pi-pocket
```

Or try it with `npx pi-pocket`. To change Pi Pocket's code, or to update it from the app, run a git checkout instead:

```bash
git clone https://github.com/TannerMidd/pi-pocket.git
cd pi-pocket
npm install
npm start
```

The launcher asks how your devices should connect, then prints a sign-in link and a QR code. The link is the owner's key: keep it private. `--rotate-token` replaces it and signs out every device that used it.

While it runs: **q** quit · **r** restart server · **a** change access · **o** open in browser · **s** show QR code.

**Victor fork:** self-update is disabled. The update sheet only reports upstream releases for manual review; use the [fork workflow](docs/fork-workflow.md) and [Victor deployment steps](docs/victor.md#updates). The automatic update behavior below describes upstream Pi Pocket.

**Updating:** Menu → **Update Pi Pocket** updates a git checkout run with `npm start` and restarts, and goes back by itself if the new version does not start ([features](docs/features.md)). By hand: stop the server, back up `~/.pi-pocket`, pull, run `npm install`, and start again. An npm install updates with `npm install -g pi-pocket@latest`. Read the [release notes](https://github.com/TannerMidd/pi-pocket/releases) first: 0.21.0 upgrades the database one way, so going back needs the backup.

### Other ways to run it

- **Docker or Podman:** `docker compose up -d --build`. See [docs/docker.md](docs/docker.md).
- **Nix:** `nix run github:TannerMidd/pi-pocket`, or the NixOS module `services.pi-pocket.enable = true;` ([nix/module.nix](nix/module.nix)).
- **Android (Termux):**

    ```bash
    pkg update && pkg upgrade && pkg install nodejs git
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent
    pi    # /login, then quit
    git clone https://github.com/TannerMidd/pi-pocket.git
    cd pi-pocket && npm install --ignore-scripts && termux-wake-lock && npm start
    ```

    Lancet Guard may not load on Android. If it is on but fails, start with `PI_POCKET_GUARD=off`.

## Remote access

Choose a mode in the launcher, or pass `--access`:

| Mode         | Who can connect      | Notes                                                    |
| ------------ | -------------------- | -------------------------------------------------------- |
| `local`      | This machine         | `127.0.0.1`; bring your own tunnel to port 8787          |
| `lan`        | Your local network   | Plain http                                               |
| `cloudflare` | Anyone with the link | Free https quick tunnel, no account; needs `cloudflared` |
| `tailscale`  | Your tailnet         | Tailscale address only                                   |

Other options: `--port` (8787), `--cwd`, `--data` (`~/.pi-pocket`), `--host`, and `-y` to reuse the last access choice. `npm start -- --help` lists them all. `PI_POCKET_BROWSER` and `PI_POCKET_BROWSER_ARGS` pick the built-in browser and its flags when Chromium or Chrome is not found by itself.

### HTTPS with Tailscale Serve

With Tailscale connected and `just` installed, run `just start` from this checkout. It configures a persistent, tailnet-only HTTPS proxy on port **8443**, leaving any service on port 443 untouched, then starts Pi Pocket on `127.0.0.1:8787`. Open the HTTPS address printed by Tailscale on your phone, with Tailscale connected there too. Sign in again on the new address; HTTPS enables browser dictation and push notifications.

Set `PI_POCKET_CWD` to choose the agent's working directory, e.g. `PI_POCKET_CWD="$HOME/code/my-project" just start`; it defaults to this checkout, even when invoking `just` from a subdirectory.

Run `just` to list recipes and their descriptions; use `just --usage <recipe>` for arguments, not `just <recipe> --help`. Fork operations are explained in [the fork workflow](docs/fork-workflow.md). The launch recipes include:

- `just tailscale-setup`: configure the HTTPS proxy without starting Pi Pocket.
- `just start-local`: start Pi Pocket on loopback without changing Serve's configuration.
- `just dev`: prepare Victor assets and configure a separate, tailnet-only Tailscale HTTPS endpoint on port **8444**, forwarding to `127.0.0.1:8788`. Pocket data stays separate in `~/.pi-pocket-dev`. Like regular Pi Pocket, it shares the host's Pi authentication credentials and model configuration.
- `just tailscale-stop`: remove only the port-8443 proxy, leaving Pi Pocket running.
- `just tailscale-status`: show the configured routes and addresses.

On macOS the recipes use the Tailscale app's CLI when installed; elsewhere they use `tailscale` from `PATH`. Set `TAILSCALE_BIN` to override that path. Serve's `--bg` configuration survives restarts, but Pi Pocket runs in the foreground. Stop Pi Pocket with `q` or Ctrl+C, then run `just tailscale-stop` if you also want to remove its HTTPS proxy. Port 443 stays untouched. These recipes do not start Pi Pocket at system login. Stop any existing Pi Pocket instance before running either start recipe; `just dev` can run alongside production.

Development sessions start in this checkout, or `PI_POCKET_CWD` when set. No separate provider sign-in is needed: development uses the same Pi agent directory as regular Pi Pocket (`~/.pi/agent` by default, or the inherited `PI_CODING_AGENT_DIR` override). Changes to Pi credentials or model configuration affect both instances. **Use a unique browser profile for development:** cookies are shared across ports on the same host, including the two Tailscale HTTPS endpoints. Use the HTTPS address printed by Tailscale for phone microphone testing. The development proxy persists after quitting; remove only it with `tailscale serve --https=8444 off` (on macOS, use `/Applications/Tailscale.app/Contents/MacOS/Tailscale` if `tailscale` is not on `PATH`).

> [!WARNING]
> Anyone who can steer a session can make Pi run commands on this machine, as you. That reaches your files, Pi Pocket's own settings and tokens, and its code. Invite only people you would trust at your keyboard. View-only users cannot make Pi act. [SECURITY.md](SECURITY.md) says what is protected and what is not.

## Documentation

- [Feature tour](docs/features.md): every feature, in full.
- [Docs site](https://tannermidd.github.io/pi-pocket/docs/): customizing Pi without code, and writing extensions.
- [Engineering](https://tannermidd.github.io/pi-pocket/engineering.html) and [code map](docs/map.md): how Pi Pocket is built.

## Development

```bash
npm run check   # type-check
npm test        # server tests with a scripted model
npm run format  # ESLint's layout fixes, then Prettier
npm run lint    # check the layout rules
```

`web/` changes reload every open browser, and extensions reload into the running server. `node test/serve.ts` runs a throwaway copy to check a change on. [AGENTS.md](AGENTS.md) covers editing Pi Pocket safely from inside itself, and [CONTRIBUTING.md](CONTRIBUTING.md) how to send a change.

## Limitations

- Pi Durable is experimental, and its API can change between releases. Versions are pinned in `package.json`.
- Only one server process can use the database at a time.
- Pi's own extensions are not supported. Pi Pocket runs its own, on Pi Durable.
- A git worktree keeps a session's files apart; it is not a sandbox.
- The built-in browser needs Chromium, Chrome, Brave, or Edge on the server. It is tested on Linux and macOS.

The [full list](docs/features.md#limitations) has the details.

## Credits and license

Inspired by [Mario Zechner's demo](https://x.com/badlogicgames/status/2106452296087302173) of his own Pi app. Pi Pocket is an independent project, not affiliated with Earendil. The bundled fonts keep their own licenses, which are beside them in [web/fonts/](web/fonts/).

[MIT](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
