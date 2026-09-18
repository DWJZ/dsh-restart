---
description: "dsh-restart: a Settings page that restarts the dsh Web host process with one click."
---

# dsh-restart

English | [中文](README.zh.md)

A **Restart** page in the DeepSeek Harness (dsh) Web settings panel: one button replaces the running host process with a fresh one.

![The Restart page in Settings](assets/preview.png)

## What it does

- **Host half** registers two routes on the Web server, both limited to direct same-origin loopback requests:
  - `GET /dsh-restart/status` — boot id, PID, start time, and serving port of the current process
  - `POST /dsh-restart/restart` — replaces the current process (the host exits after answering `202`)
- **Browser half** registers a `settings.section` page showing that identity plus a restart button. It polls `/dsh-restart/status` after the click and reloads the page as soon as a different boot id answers.

The restart itself is done by a detached helper: the host exits after 400 ms, and the helper waits until the port stops accepting connections before spawning the replacement with **exactly the same launch invocation** (Node binary, `execArgv`, absolute entry path, remaining argv, working directory). That ordering is what keeps the replacement from dying of `EADDRINUSE` while the old socket is still held. Logs land in the system temp directory as `dsh-restart-<timestamp>.out.log` / `.err.log`.

Sessions live on disk and survive the restart, and plugins that are installed but not active yet load on the next boot.

## Install

```sh
# from GitHub
dsh plugin --profile web add github:DWJZ/dsh-restart

# local development (the profile links the checkout, so edits apply directly)
dsh plugin --profile web add link:/path/to/dsh-restart
```

The first install needs one restart before the page exists — restart the host from a terminal, or use dshmarket's restart button once. After that, this page is the way to restart.

## Endpoint contract

`POST /dsh-restart/restart` accepts only requests whose peer is loopback and whose `Origin` matches `Host`; any forwarding header (`Forwarded`, `X-Forwarded-For`, `X-Real-IP`) or non-loopback peer is refused with `403`. It answers `202`, then the host exits and the helper starts the replacement.

## Test

```sh
node test/smoke.mjs
```

Covers: the detached helper really starts a replacement process, all four refusal paths of the same-origin guard, and the client bundle's registration and render. Set `DSH_CHECKOUT=<dsh checkout>` to add an SSR render assertion using that checkout's React; without it that one assertion is skipped.

## License

[MIT](LICENSE)
