# Third-Party Notices

This project contains code patterns adapted from the following open-source projects.

## Bundled expert personas (`assets/personas/`)

Nine of the built-in expert personas under `assets/personas/engineering/` and
`assets/personas/testing/` come from the company-internal `公司内部角色库` repository,
which vendored and (for the RF batch) re-wrote material from two upstream MIT projects.
Both upstreams permit redistribution and modification; the MIT condition
— keep the copyright notice and the full license text in copies — is satisfied by this
notice plus the two `LICENSE-*` files in the repository root.

The personas are **read-only data**, not code: the plugin parses them and never writes
to any persona source. The three upstreams and what was done to each are listed below.

### 1. novotnyllc/dotnet-artisan

- Repository: https://github.com/novotnyllc/dotnet-artisan
- Copyright (c) 2026 Claire Novotny LLC
- License: MIT — full text in [`LICENSE-novotnyllc-dotnet-artisan`](LICENSE-novotnyllc-dotnet-artisan)
- Commit at vendoring time: `3db3ae6381fb665b5b4772335a4f378c7ed07e92` (2026-08-17)
- Upstream paths used: `plugins/dotnet-artisan/agents/` (top-level agent personas) and the
  `dotnet-architect` / `dotnet-blazor-specialist` / `dotnet-aspnetcore-specialist` /
  `dotnet-code-review-agent` / `dotnet-performance-analyst` /
  `dotnet-async-performance-specialist` / `dotnet-csharp-concurrency-specialist` personas

Bundled personas derived from this upstream:

| Bundled file | Persona |
|---|---|
| `assets/personas/engineering/高级-dotnet-blazor-工程师.md` | 高级 .NET / Blazor 工程师 |
| `assets/personas/engineering/dotnet-代码审查官.md` | .NET 代码审查官 |
| `assets/personas/engineering/dotnet-性能并发诊断师.md` | .NET 性能与并发诊断师 |

Modifications: composed/merged from the upstream personas listed above, condensed, and
rendered into the Chinese `# 名称` + metadata-blockquote + `## 身份` form that this
plugin's parser consumes. The vendoring step additionally dropped the upstream
`license:` frontmatter line (this plugin's parser has a closed key whitelist, so the line
would have been silently ignored and would not have carried the attribution obligation).
No upstream code is shipped.

### 2. K-Dense-AI/scientific-agents

- Repository: https://github.com/K-Dense-AI/scientific-agents
- Copyright (c) 2026 K-Dense, Inc.
- License: MIT — full text in [`LICENSE-K-Dense-scientific-agents`](LICENSE-K-Dense-scientific-agents)
- Commit at vendoring time: `acbd93d` (`--depth 1`)
- Upstream paths used: `<slug>/AGENTS.md`

Bundled personas derived from this upstream:

| Bundled file | Persona | Upstream slug |
|---|---|---|
| `assets/personas/engineering/rf-天线测量专家.md` | 天线测量专家 | `antenna-engineer` |
| `assets/personas/engineering/rf-电磁仿真与暗室测量.md` | 电磁仿真与暗室测量专家 | `electromagnetics-engineer` |
| `assets/personas/engineering/rf-微波电路与vna测量.md` | 微波电路与 VNA 测量专家 | `rf-microwave-engineer` |
| `assets/personas/engineering/rf-仪表回路与测量链.md` | 仪表回路与测量链专家 | `instrumentation-engineer` |
| `assets/personas/testing/rf-测量不确定度预算.md` | 测量不确定度预算专家 | `metrology-scientist` (split, half 1) |
| `assets/personas/testing/rf-计量溯源与校准.md` | 计量溯源与校准专家 | `metrology-scientist` (split, half 2) |

Modifications: **re-written, not copied.** For each entry the upstream English persona was
read, its decision-relevant content (troubleshooting tables, Definition-of-Done lists,
instrument/file-format inventories, rigour checkpoints) was extracted, and it was
re-authored in Chinese into the `身份 / 核心使命 / 第一原理 / 红线 / 工作纪律 / 输出格式`
structure, capped at 20000 characters. The upstream English text is deliberately **not**
bundled. `metrology-scientist` exceeded the cap even after compression, so it was split
into two personas (uncertainty budget vs. traceability/calibration). No upstream code is
shipped.

### 3. 公司内部角色库 (internal, the vendoring intermediary)

- The nine files above arrived here through the company-internal `公司内部角色库` repository
  (`personas/dotnet/`, `personas/rf/`), whose `vendor/UPSTREAM.md` is the authoritative
  provenance record for both upstreams. File names were **not** changed on import, so the
  per-persona sections above remain directly traceable; only the directory layout differs
  (`dotnet/` + `rf/` → `engineering/` + `testing/`, matching the persona `分类` declared
  in each file's metadata block).

The remaining built-in personas (`反向验证者`, `只读审查者`, `实现者`, `方案设计者`, `调研者`,
`测试工程师`) are this project's own work and are not covered by this section.

---

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

