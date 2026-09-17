# Third-Party Notices

This project contains code patterns adapted from the following open-source projects.

## dsh-task-board (part of dsh-web-ui)

- Repository: https://github.com/zhu1090093659/dsh-web-ui
- Package: @linxin666/dsh-client-ui-task-board
- Copyright (c) 2026, zhu1090093659
- License: BSD 3-Clause

Adapted material: the DOM-level sidebar entry injection and center-column takeover
pattern (selectors, MutationObserver self-healing, cross-panel activation protocol).
The adapted code has been rewritten for this plugin, but the structural approach
is derived from dsh-task-board.

BSD 3-Clause License text:

Copyright (c) 2026, zhu1090093659
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## dsh-genui

- Repository: https://github.com/omdsh-dev/dsh-genui
- Copyright (c) 2026 dsh-external
- License: MIT

Adapted material: the tsdown build configuration pattern that emits the DSH
`window.__ModuleLoader__.load` client bundle wrapper. The build config has been
rewritten for this plugin, but the wrapper approach derives from dsh-genui.
MIT license text is available at the repository link above.

## Guojing6/dsh-workbench (fork of this project)

- Repository: https://github.com/Guojing6/dsh-workbench
- Upstream: a fork of Dely0/dsh-personal-workbench
- License: MIT (same as this project)

Adapted material: the design and implementation approach for **task folders keyed by task id**
(including pre-allocating the task id at clarification time so the folder name and the task id
are the same thing), **quick-intake attachments** (PDF/DOCX text extraction, and images through
the host's multimodal `PromptContentPart` pipeline), the **quick-intake model picker**, the
**`/workbench` slash command**, and **consolidating the duplicated request-fence helpers**
(loopback check / JSON response / body reader). Also credited for locating two real bugs this
project had been carrying: `ws.items[0]` picking an unrelated workspace when a task had no path,
and building the clarification folder name out of the user's raw sentence.

Nothing was copied verbatim: that branch is based on v1.10.1, and this repository has since
been restructured (`src/api/routes.ts` → `src/api/routes/*`, `src/db/repo.ts` → `src/db/repo/*`,
client split into `src/client/components/*`), so every item was re-implemented against the
current modules — with deliberate differences, e.g. an added legacy-path compatibility rule
for task folders, and a rewritten decompression guard in the attachment parser.

## SnowNight777/dsh-personal-workbench (contributor, v1.15.3)

- Contributor: https://github.com/SnowNight777
- Reports: issues #4 / #5 / #7 · Pull requests #6 / #8
- License: MIT (same as this project) — the changes were accepted as upstream contributions

Accepted contributions (v1.15.3). These are **contributed changes, not adapted third-party
material** — they are listed here so every piece of externally-authored code in this repository
is traceable from one place:

- **Task-reminder creation for three missing paths.** `addReminder` had only two call sites
  (the parent task at draft confirmation, and the manual `POST /tasks/:id/reminders` route), so
  subtasks produced by `walkChildren`, tasks created through `POST /api/workbench/tasks`, and
  tasks whose due date was set later via `PATCH /api/workbench/tasks/:id` never got a reminder
  row — and the scheduler only reads `task_reminders`, so those tasks could never fire.
  The contributed patch adds the same "explicit offset → type default → priority default"
  resolution used for the parent task, and guards the `PATCH` path against duplicates.
- **Delivery-target cache.** `GET /api/workbench/reminders/channel` now resolves the target
  before reporting status, so a bound target is no longer mis-reported as "not configured"
  after a restart.
- **Reusable-session availability predicate.** New pure module `src/client/aiSessionReuse.ts`
  (`isAiSessionReusable`) plus table-driven tests, applied to five places that previously opened
  a stored `session_id` without checking whether it was still usable (registry reuse, the report
  row's own `sessionId` fallback, "enter review session", the task-detail session tab, and the
  draft banner). When the predicate does not hold, those paths fall back to creating a new
  session or surface an explicit notice instead of failing silently.

One maintainer revision on top of the contribution (`c78416e`): the last branch of
`isTargetConfigured` was tightened from `return adapter.available()` to `return false`, so users
who never bound a delivery target keep the previous "do nothing" behaviour instead of repeatedly
attempting and failing delivery. See [`docs/releases/v1.15.3.md`](docs/releases/v1.15.3.md) §3.

