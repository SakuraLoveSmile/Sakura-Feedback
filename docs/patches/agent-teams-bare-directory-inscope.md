# AgentTeams 插件缺陷：裸目录 inScope 匹配失败

## 现象
质量门禁在完成 implementation/repair 任务时拒绝一切 `changedPaths`：

```
Error: implementation cannot complete: apps/server/src/services/log-text.ts is undeclared
```

## 根因（插件 `@nanmicoder/dsh-agent-teams@0.1.17-rc.1`）
`lib/quality-gates.js` 的 `pathMatchesScope(path, pattern)`：
- pattern **以 `/` 结尾** → 目录前缀匹配；
- pattern **不带尾斜杠** → 仅做 `normalizedPath === normalizedPattern` **精确相等**；
- 不支持 glob（`apps/server/**` 也不匹配）。

因此任务定义里写成裸目录的 `inScope`（如 `["apps/server"]`）**匹配不到其下任何文件**，17 个改动路径全部被判 `undeclared`，报错只显示数组第一条。

同一分类器还被 `canDeclareDelivery`（`quality-gates.js:552-558`）用于交付审计，因此**即使任务完成，交付仍会以 `t2 has unaudited path ...` 被阻塞**。

## 影响面
本团队 t2 `["apps/server"]`、t3 `["packages/web", ...]`、t4 `["flutter/feedback", ...]`、
t5 `["apps/admin"]`、t6 `["docs", ...]`、t7 `["e2e"]` 全部为裸目录，收尾与交付审计都会撞同一处。
t1 之所以通过，是因为其 `inScope` 是显式文件路径。

## 修复（已应用于本机插件）
`pathMatchesScope` 在精确匹配之后，增加**按路径分段边界的目录前缀回退**：

```js
// A bare (non-trailing-slash) pattern matches the literal path first, so
// explicit file scopes such as `README.md` keep working exactly as before.
if (normalizedPath === normalizedPattern)
    return true;
// Fall back to treating it as a directory prefix on a segment boundary, so
// declared scopes like `apps/server` also cover the files beneath them.
return normalizedPath.startsWith(`${normalizedPattern}/`);
```

精确匹配优先 → 显式文件 scope（`README.md`、`docs/api.md`）行为不变；
分段边界（`pattern + "/"`）→ `apps/server-old/x.ts` **不会**被误判为 `apps/server` 范围内。

## 验证（15 条断言全部通过，直接 import 插件模块实测）
- `apps/server` 覆盖 `apps/server/src/...` ✅
- `apps/server-old/x.ts` 不匹配 `apps/server` ✅（分段边界）
- `README.md` 仍只匹配自身、不匹配 `docs/README.md` ✅
- `apps/admin/src/x.ts` 在 `["apps/server"]` 下仍为 `undeclared` ✅（越界防护未被削弱）

修复文件：
`~/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/quality-gates.js`

## 待办
该模块在 DSH 进程启动时经静态 ESM 导入（`state.js:20`）被缓存，
**源码修复需重启 DSH/插件宿主后生效**；生效前可用等价声明 `changedPaths: ["apps/server"]`（目录粒度）通过闸门与交付审计。
