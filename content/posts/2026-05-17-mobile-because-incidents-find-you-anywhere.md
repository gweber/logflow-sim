---
title: Mobile-friendly, because incidents find you anywhere
date: 2026-05-17
excerpt: An on-call engineer reaching for their laptop on a Sunday afternoon is the easy case. Sometimes you only have the phone in your pocket. We made sure that case still works.
tags: [mobile, ux, on-call]
---

# Mobile-friendly, because incidents find you anywhere

There's a quiet assumption baked into most infrastructure tooling
that the user is sitting at a desk in front of a wide monitor with
a real keyboard. For the vast majority of work, that assumption is
fine — nobody wants to write a hundred lines of YAML on a phone.

But there's a specific set of moments where the assumption breaks
down badly:

- An alert fires while you're out for groceries.
- A teammate pings you on a Sunday with "quick sanity-check this
  routing change?"
- You're at a conference, the laptop's at the hotel, and someone
  asks whether the proposed config change for next quarter is
  going to break the SIEM forwarder.
- The on-call rotation has handed you a pager, but the only screen
  you have right now is the one in your pocket.

In every one of these moments, you're not trying to do a full
day's work on a phone. You're trying to **answer one question
quickly** so you can either confirm it's fine or escalate it to
someone with a real screen.

## What we changed

We did a sweep of the UI to make sure every page is usable on a
phone, not just visible. Concretely:

**Touch targets meet accessibility guidelines.** Every button on
a touch device is at least 44 pixels tall — the threshold Apple
and Material both recommend as the minimum for reliable thumb
tapping. The same buttons on a desktop stay compact, so the dense
information layout you expect on a wide screen doesn't change.

**Inputs don't trigger iOS auto-zoom.** iOS Safari has a famously
annoying behaviour where focusing any input with a font-size
under 16px causes the page to zoom in. We bumped input fonts to
16px on touch devices specifically, so tapping into a search box
no longer hijacks the viewport.

**The Config browser switches to tabs.** On wide screens, the
Config page shows three panes side by side: file tree, file
viewer, diagnostics. On phones, that becomes a tab strip at the
top — Files / View / Diag (n) — and tapping a file or a
diagnostic auto-switches you to the relevant tab. The information
density doesn't change; the navigation does.

**The header chip row stays inside the viewport.** The dialect
picker, locale picker, mode toggle, and theme toggle all sit in
the top bar. On a 320-pixel-wide screen, they used to crowd; now
the dialect label is hidden below the small breakpoint (showing
just the dialect value), padding compacts, and gaps shrink. The
mobile nav row beneath the header scrolls horizontally with
inertia.

**Project list rows stack.** The Projects page lists your saved
configs with Use / Export / Rename / Delete actions. On a desktop
those sit inline on the right; on a phone they stack below the
name and wrap onto two rows, so each button is large enough to
tap accurately.

**The Migration page's arrow rotates.** When the From / To layout
collapses from horizontal to vertical on mobile, the connecting
arrow rotates from `→` to `↓`. Tiny detail, but it keeps the
visual logic intact.

## What still doesn't work on mobile

Two structural limitations remain, and we want to be honest about
them rather than pretend the experience is identical.

**iOS Safari doesn't support folder-upload.** The HTML
`webkitdirectory` attribute, which lets you select a whole
directory in one go, isn't implemented on iOS. If you try, Safari
falls back to single-file selection. The workaround on a phone is
to **upload a ZIP** instead — every supported config file inside
gets extracted in-browser. Folder upload still works on Android
Chrome and on every desktop browser.

**Drag-and-drop is desktop-only.** There's no useful drag-and-drop
interaction on a touch screen, so the page-wide drop zone simply
doesn't appear on phones. The four upload cards (clone, folder,
files, ZIP) work the same on every device.

Beyond those, the only thing we'd say is: a phone is great for
**checking** something. It's not great for **building** something.
If you're sitting down to refactor a 1,500-line ruleset, the phone
isn't the right tool — for reasons that have nothing to do with
logflow-sim.

## The point

We don't expect anyone to do their main config work from a phone.
That's not what this is for.

What it's for: the Sunday afternoon when a teammate pings you, and
instead of "give me ten minutes to find a laptop," you can open
the link, run the simulator, confirm the routing is fine, and get
back to your weekend. Or, when something is actually broken, see
it on the phone, decide the situation warrants a laptop, and
escalate from a position of knowing.

That's a meaningfully better on-call experience. Which is the kind
of thing we want this tool to provide.

## Try it

The next time you're holding your phone, [open the
homepage](/) and click through to the simulator. If anything
feels wrong — buttons too small, overflow, weird scroll — open
an issue. Mobile UX is the kind of thing that needs many eyes on
many devices to get right, and we'd rather hear about the issues
than guess.
