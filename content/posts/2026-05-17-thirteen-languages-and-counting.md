---
title: logflow-sim now speaks thirteen languages
date: 2026-05-17
excerpt: Log pipelines aren't an English-speaking-team problem. We translated the UI into thirteen languages so the simulator works the same way for an operator in São Paulo as for one in Stockholm.
tags: [i18n, accessibility, internationalisation]
---

# logflow-sim now speaks thirteen languages

A small but stubborn assumption sits inside most open-source infra
tooling: that the people using it read English well enough to follow
the UI. It's an understandable assumption — English is the working
language of most open-source projects, and the people contributing
the tool are usually fluent enough that the issue doesn't come up.

But the people *using* the tool are a much wider group than the
people writing it. A junior SRE at a bank in Lisbon, a security
engineer on shift in Tokyo, a sysadmin at a regional hospital in
Hyderabad — they're all the audience for a tool like logflow-sim,
and they don't all have the same English fluency.

When the UI is English-only, those people pay a small but
permanent tax. Every label is a translation step in their head.
Every error message lands with a bit less context. Every
documentation paragraph is slower to skim. None of it is
prohibitive; all of it is friction.

## What we translated

logflow-sim's UI is now available in thirteen languages:

- **English** (en)
- **German** (Deutsch)
- **French** (Français)
- **Spanish** (Español)
- **Portuguese** (Português)
- **Italian** (Italiano)
- **Japanese** (日本語)
- **Chinese** (中文)
- **Korean** (한국어)
- **Russian** (Русский)
- **Hindi** (हिन्दी)
- **Turkish** (Türkçe)
- **Vietnamese** (Tiếng Việt)

The locale picker lives in the top bar — a small chip next to the
dialect picker. The picker remembers your choice across sessions
and, where present, picks up a locale set by the parent site (so
if you reach logflow-sim from a multi-locale portal that has
already chosen a language for you, that choice carries over).

## What we deliberately didn't translate

A handful of strings stay in English regardless of locale. They're
all **technical names** that exist as identifiers in the underlying
tools, not as translatable concepts:

- Tool and dialect names: `rsyslog`, `syslog-ng`, `Fluent Bit`,
  `Vector`, `OpenTelemetry`.
- Domain vocabulary that's English in the tools themselves:
  `ruleset`, `template`, `lookup table`, `replay`, `diff`.
- File extensions, API endpoints, protocol names.

The reason is consistency with the tools you're analyzing. If you
open `rsyslog.conf` in your editor, you'll see the word `ruleset`
in English. The simulator using the same word makes the bridge
between the two seamless. Translating it would create a vocabulary
that exists only inside logflow-sim — a translation layer you'd
have to learn just to use the tool.

The general rule: anything that is part of the **product language**
gets translated. Anything that is part of the **subject matter** —
the configs and protocols logflow-sim is analyzing — stays in its
original form.

## Where the translations came from

Two languages — English and German — were written by the project
maintainers and reviewed in detail. The remaining eleven were
produced from the English source with care given to terminology
consistency, then reviewed for surface-level correctness.

We're calling all thirteen "shipping" — they cover the entire UI,
no key falls back to English. But they vary in idiom polish, and
some specialised vocabulary may not match the wording your team
uses internally. If you spot something that reads awkwardly or
that has a more natural phrasing in your locale, the catalogs are
small JSON files in
[`src/ui/i18n/locales/`](https://github.com/gweber/logflow-sim/tree/main/src/ui/i18n/locales)
and a PR is welcome.

## Why this matters more than it might seem

There's a school of thought that goes "anyone working in infra
reads English; localisation is a luxury." It's a tempting position
because it justifies not doing the work.

But the test for whether localisation matters isn't whether the
target user *can* read English. It's whether they read it as
fluently as their primary language. The on-call engineer at 3 AM
who has to make a routing decision under stress will think faster
in their first language than in a second. The new hire learning
the tool will absorb concepts faster when the labels match the
words they already know. The team training a junior member will
spend less time explaining the UI.

These are small wins individually. They compound.

## What's next

A few things we'd like to add to the i18n machinery, in roughly
descending order of likelihood:

- **RTL layout support** for languages like Arabic and Hebrew. The
  current locale set is all left-to-right; adding RTL is a layout
  question, not just a translation question.
- **Date / number formatting** that respects the locale. Currently
  most numbers are bare digits and dates use the user's
  browser-supplied formatting. That's mostly fine, but there are
  spots where it could be better.
- **Translated documentation.** The blog and docs pages are
  currently English-only. Translating them is a much larger
  ongoing commitment than translating the UI, so it's lower
  priority — but we'd be open to community-driven translations
  for the most-read pages.

## Try it

If your browser is already set to a non-English language, the UI
should be in that language when you arrive. Otherwise, click the
locale chip in the top right — the small two-letter code next to
the dialect picker — and pick the language you want.

Switching is instant and doesn't reload the page. Your choice is
remembered.
