---
title: Edit log configs in your browser without uploading them anywhere
date: 2026-05-17
excerpt: Production log configs contain hostnames, IP ranges, internal service names — exactly the things you don't want to paste into a SaaS analyzer. Projects let you load and edit configs entirely in your browser, with nothing leaving the device.
tags: [privacy, projects, local-mode, workflow]
---

# Edit log configs in your browser without uploading them anywhere

A log-pipeline config is a moderately sensitive document. Not
nuclear-launch-codes sensitive, but the kind of file you'd rather not
paste into a random web tool. It typically contains:

- Internal hostnames and IP ranges, which together sketch your
  network topology.
- Service names that hint at what's running where (and sometimes
  what isn't running yet).
- Lookup tables mapping users to roles, hostnames to teams, ports
  to applications — the kind of metadata that's tedious to assemble
  and uncomfortable to leak.
- Occasionally, secret-shaped strings (auth tokens, certificate
  paths, S3 bucket names) that should never have been in a config
  file in the first place but are.

When you want to ask "what does this config actually do," the obvious
options are uncomfortable. Pasting into a SaaS analyzer means
trusting a third party with all of the above. Running the official
tool locally usually means installing the daemon (and its
dependencies), feeding it the config, and reading whatever log lines
it spits out — which is exactly the friction you wanted to avoid.

## What the Projects page is for

The [Projects page](/projects) lets you load a config into
logflow-sim in four ways:

- **Clone the live server config.** If you're running logflow-sim on
  a host where its container can read your `/etc/rsyslog.d/`, one
  click snapshots that into a browser-local project.
- **Upload a folder.** Use your browser's directory picker; every
  recognised config file under it becomes part of the project. Common
  prefixes are stripped so the bundle is keyed on relative paths.
- **Upload individual files.** Useful when your config sits next to
  unrelated files you don't want bundled.
- **Upload a ZIP archive.** For when you've got the config zipped up
  from a different machine. Or just drag-and-drop a folder or zip
  anywhere on the page.

Each of these triggers an in-browser review step. The page detects
the dialect (with a confidence score), suggests a project name,
picks a sensible entrypoint, and shows the total size. You can
override any of these before saving.

## "Stays local" means what, exactly

When a project is loaded and you're in **local mode**:

- The parser, simulator, validator, search, conversion — all of it
  runs in a Web Worker inside your browser tab.
- No project file leaves the browser. There's no API call carrying
  the bundle contents back to the server. The server doesn't see
  what you uploaded.
- Projects persist in `localStorage`, scoped to the origin. They
  don't sync to any cloud, they don't follow you across browsers,
  they don't appear on someone else's machine.
- Closing the tab keeps the project. Clearing site data deletes it.

The trade-off is the browser's `localStorage` cap, which is around
5 MB across the origin. The page warns you when a bundle is getting
close. For configs larger than that, the right answer is to mount
the directory into the server container instead — same explanatory
features, no storage limit, but the config sits on the host
filesystem rather than in your browser.

## Why have both modes

**Server mode** is for the case where logflow-sim is running on (or
near) the host that owns the config. The container reads the live
config, every browser session sees the same thing, and the workflow
is "open the URL, look at what's actually deployed." This is the
mode for ops engineers who own the host.

**Local mode** is for the case where you want to investigate a
config that isn't on the server — a colleague's config sent over
chat, a sample from a vendor, a draft of a proposed change. Or for
the case where you want to edit the config and try things without
touching anything live. Or for the case where you're just curious
about how some construct works and want to test it in isolation.

Switching between modes is one click on the toggle in the top bar.
Each mode remembers where it was — switching to local doesn't lose
the live-server view, and switching back doesn't lose the project
you were working on.

## What you can do with a project once it's loaded

Everything the server-mode UI does. Simulate messages, replay
batches, diff against another project, run validation, browse the
parsed tree, jump to source locations, search across files, run
Sigma detections, convert to another dialect. All of it operates on
the project bundle in the worker.

You can also **export** a saved project as a ZIP for sharing or
backup, **rename** it, or delete it. Multiple saved projects let
you switch between them with one click — useful when comparing two
proposed approaches without losing either.

## What's not in scope

We don't sync projects across devices. There's no account, no
cloud, no opt-in pairing. If you want the same project on your
laptop and your desktop, export the ZIP and import it on the other
end. That's a deliberate choice: the moment we add sync, we have to
explain where the data goes, and "nowhere" is a much easier story
to tell.

We also don't edit the source files in place. The project bundle is
a snapshot. Edits land in the worker's in-memory copy. When you're
done, you copy the result back into your real config (or download
the project zip and unpack it).

## Try it

Open [Projects](/projects). If there's a sample config you've been
meaning to look at, drop it in. You'll be in the simulator within
seconds, and nothing will have left the browser.
