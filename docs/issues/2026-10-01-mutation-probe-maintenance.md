# 变异探针维护 + 判据盲点（2026-10-01 发 v1.16.1 时补跑发现）

> 背景：`dsh-release` skill §3 的硬门禁里有一条「有变异探针的项目：**必须全红**」。
> 发 v1.16.1 时**漏跑了这一条**（其余门禁都跑了），事后补跑，发现探针本身与判据都有问题。
> 本单登记待修项，**不影响 v1.16.1 的代码质量结论** —— 探针红/绿说的是"判据能不能拦住未来回归"，
> 不是"当前代码对不对"（v1.16.1 已通过用户实测 + 全量单测 + 三套浏览器判据 + 真实产物对账）。

## 复现（**每个探针之间必须先 `pnpm build`，见 §B**）

```powershell
foreach ($p in Get-ChildItem scripts\repro -Filter "probe-*-mutations.mjs") {
  pnpm build            # ← 关键：探针只还原因 src/，不重建 lib/
  node $p.FullName
}
```

## A. 判据盲点（变异存活 = 该处行为没有测试守得住）

| 探针 | 结果 | 存活/异常项 |
|---|---|---|
| `probe-knowledge-recall-mutations.mjs` | ✅ 46/46 全红 | — |
| `probe-knowledge-draft-overwrite-mutations.mjs` | ✅ 19/19 全红 | — |
| `probe-listview-mutations.mjs` | ✅ 基线绿、退出 0 | — |
| `probe-capacity-mutations.mjs` | ❌ | **M7**（未知优先级归 p0 而非 p3）、**M19**（面板把逾期开关勾选态写死成 false ⇒ 开关变假控件）存活 |
| `probe-model-picker-notify-mutations.mjs` | ❌ **3/10 存活** | 例：B5（发送失败重新被空 catch 吞掉，即"显示已开启但毫无反应"）—— 与 v1.15.7 修过的 P0 同源，必须守住 |
| `probe-quick-workspace-mutations.mjs` | ❌ **3/15 存活** | 例：M14（「不再记住」按钮渲染条件改成恒 false ⇒ 用户出口被静默摘掉） |

**待办**：为上述存活变异各补一条会失败的断言（优先 M19 / M14 / B5 —— 它们对应"用户可见的静默失效"）。

## B. 探针自身的问题（两类）

1. **`lib/` 污染 ⇒ 假红**：探针把 `src/` 还原了，但**不重建 `lib/`**，于是盘上留下**最后一个变异体的构建产物**。
   紧接着跑下一个探针（或其基线）就会红，看起来像"基线没过"。
   **实测**：连跑后 `node --test test/modelPickerDegrade.test.mjs test/quickIntakeClient.test.mjs
   test/quickWorkspaceDefault.test.mjs test/listViews.test.mjs` → **0/4 通过**；
   而 `pnpm build` 之后同样的命令 → **83/83 通过**。
   ⇒ **修法**：探针在还原 `src/` 之后追加一次 `pnpm build`（或让统一跑批脚本在每个探针之间构建）。
2. **源码片段漂移 ⇒ 探针失效**：`probe-capacity-mutations.mjs` 有多条打印
   `找不到替换片段（探针失效，需更新）`（M16/M17/M18 等）—— 批次1/1.5 的重构搬动了源码，
   探针锚的字符串已经不在了。**失效的探针等于没有探针**，必须一起修。

## C. 顺带发现的文档缺陷（**已修**）

`dsh-release` skill §3 写的是 `node scripts/probe-*-mutations.mjs` —— **路径过时**，
实际在 `scripts/repro/` 下。这条路径错误大概率就是"漏跑门禁"的一部分原因（照着敲会找不到文件）。

**已处置（2026-10-02）**：把该 skill **落盘为项目级** [`.dsh/skills/dsh-release/SKILL.md`](../.dsh/skills/dsh-release/SKILL.md)
（**V1.2.0**），修正了探针路径、补上"每个探针之间必须 `pnpm build`"、新增 §0.2 范围表、
重写 §7 发布成功判据、新增 §11 npm 平台变更。项目级 `rank 100` **遮蔽**用户级 `rank 400`，
所以本项目此后生效的就是这一份；跨项目源仓库 `Dely0/dsh-private-toolkit` 里那份**待回流**（否则别的项目仍是旧规矩）。

## D. 结论

- 门禁**有效**：一跑就抓到 3 处判据盲点 + 2 类探针缺陷 —— 这正是它该有的作用。
- 门禁**不能只写在 skill 里**：应把"跑全部探针"接进 `scripts/dev-verify.mjs`（现役链）或
  加一条 `scripts/release-preflight.mjs`，让"漏跑"变成**不可能**（而不是靠人记得）。
