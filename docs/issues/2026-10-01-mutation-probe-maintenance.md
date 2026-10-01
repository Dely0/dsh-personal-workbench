# 变异探针维护 + 判据盲点（2026-10-01 发 v1.16.1 时补跑发现；2026-10-02 精确分类）

> 背景：`dsh-release` skill §3 的硬门禁里有一条「有变异探针的项目：**必须全红**」。
> 发 v1.16.1 时**漏跑了这一条**（skill 里写的路径过时，照着敲找不到文件），事后补跑。
> **不影响 v1.16.1 的代码质量结论** —— 探针红/绿说的是"判据能不能拦住未来回归"，
> 不是"当前代码对不对"（v1.16.1 已通过用户实测 + 全量单测 + 三套浏览器判据 + 真实产物对账）。

## 0. 读这张单子必须先知道的一件事

探针输出的 `✖` **有两种完全不同的含义**，混在一起看会让欠账清单严重失真：

| 详情行 | 含义 | 义务 |
|---|---|---|
| `装回缺陷后**仍然全绿**` | **真盲点**：这个行为没有被任何断言守住 | **补判据** |
| `变异点没匹配上（源码结构变了…）` / `找不到替换片段（探针失效，需更新）` | **探针失效**：源码重构搬走了它锚的片段，变异根本没装上 | **重锚探针**（补判据没用 —— 缺陷压根没装回去） |

> 我们差点因为只看粗粒度输出，去补 9 条**根本不存在**的判据。2026-10-02 逐条核对后才有下表。

## A. 真盲点（6 条，**要补判据**）

| 探针 | 变异 | 现状 |
|---|---|---|
| `probe-capacity-mutations` | **M11** `saveEditDraft` 的 payload 删掉 `estimatedMinutes` | 装回后仍全绿 |
| `probe-capacity-mutations` | **M12** `editDraft` 初值改回常量（打开编辑框看不到库里真实值） | 同上 |
| `probe-capacity-mutations` | **M13** 客户端不再就地校验非法耗时 | 同上 |
| `probe-capacity-mutations` | **M14** 删掉乐观更新（改完要刷新才看到「已排」变） | 同上 |
| `probe-capacity-mutations` | **M19** 面板把逾期开关的勾选态写死 `false`（**开关变成假控件：点了不勾**） | 同上 |
| `probe-quick-workspace-mutations` | **M10** 调用点把 `recent` 传成空数组（判定对、喂错了） | 同上 |

**优先级**：M19 与 M10（都是"用户可见的静默失效"）→ 再 M11–M14。

## B. 探针失效（19 条，**要重锚**）

| 探针 | 失效变异 | 根因 |
|---|---|---|
| `probe-capacity-mutations` | M1–M10、M15–M18（**14 条**） | 容量计算已从 `src/client/capacity.ts` **迁到共享模块**；该文件现在只剩 `clampEstimatedMinutes` 之类的工具，探针锚的全是旧实现的字符串 |
| `probe-quick-workspace-mutations` | M6、M14（2 条） | 接入 `WorkspacePicker` 后调用点变了：`setQuickWorkspace(e.target.value)` 已不存在，现在是 `setQuickWorkspace(path)` / `setQuickWorkspace(picked)`；「不再记住」按钮移进组件（渲染条件在组件里，不在 `index.tsx`） |
| `probe-model-picker-notify-mutations` | B7、B8、B10（3 条） | 同一次重构：`selectionApplication = selectionToApply(...)`、`unavailableReason: reason`、`clearExitReachable: ...` 的写法/位置都变了 |

> 这 19 条**必须重锚**才有意义：`M6` 这类"换个入口重新引入污染"的守卫，正是最该活着的那些。

## C. 探针自身的两类缺陷（**已修一部分**）

1. **`lib/` 污染 ⇒ 假红**（**已修**：`release-preflight.mjs` 在每个探针之间自动 `pnpm build`）：
   探针把 `src/` 还原了却不重建 `lib/`，盘上留下**最后一个变异体的构建产物**。
   **实测**：连跑后 `node --test test/modelPickerDegrade.test.mjs test/quickIntakeClient.test.mjs
   test/quickWorkspaceDefault.test.mjs test/listViews.test.mjs` → **0/4 通过**；
   `pnpm build` 之后同样的命令 → **83/83 通过**。
2. **两种汇总约定**（**已修**：`scripts/lib/releasePreflight.mjs` 两种都认，认不出按不通过）：
   约定 A `✅ N/N 条变异都被断言抓到`（knowledge-recall / draft-overwrite / model-picker / quick-workspace）；
   约定 B `变异探针：N/M 条变异都变红`（capacity / listview）。

## D. 复现与验收

```powershell
# 门禁一键跑（探针已在其中，且每个之间自动 pnpm build）
node scripts/release-preflight.mjs --only probes

# 单独跑某个探针时，**它前面要有一次 pnpm build**
pnpm build; node scripts\repro\probe-capacity-mutations.mjs
```

**修完这一单的判据**：`KNOWN_PROBE_DEBT`（`scripts/release-preflight.mjs`）清空后，
`--only probes` 仍然 exit 0。**清空名单是硬要求** —— 名单里已经不红的项会让 preflight 直接判失败，
这正是"欠账还清必须销账"的机制。

## E. 结论

- 门禁**有效**：一跑就分出了 6 条真盲点与 19 条失效探针（虽然要逐条核对才分得清）。
- 门禁**不能只写在 skill 里**：已接进 `scripts/release-preflight.mjs`，"漏跑"从此是可见的失败。
- **教训**：变异探针的"存活"必须再分一层（装不上 vs 装上了没守住），否则欠账清单会同时**虚高**（假盲点）
  与**虚低**（失效探针掩盖了真实覆盖率的下降）。
