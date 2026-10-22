# 与上游的差异（PATCHES）

- 上游：`@linxin666/dsh-remote-web-ui@0.4.6`
- 本仓库：`dsh-mobile-remote@0.4.7`（fork，只分发构建产物 `lib/`）

本仓库不重新构建，直接以上游 0.4.6 的 `lib/` 为基线做最小修改，
所以下面按「文件 + 位置 + 改了什么」记录。

## 1. 新增 `lib/binary-fix.js`

`ensureCloudflaredBinary(binPath, fallback, log)`：启动隧道前的二进制自愈。

- 能跑 `--version` → 直接放行
- 存在但跑不通（截断/架构不符）→ 改名 `*.bad-<时间戳>` 留档，避免挡住重下
- 依次尝试 `gh-proxy.com` / `ghproxy.net` / GitHub 直链，**Range 断点续传**
- **PE 完整性校验**：`MZ` + `PE\0\0` + 每个节 `rawPtr + rawSize <= 文件长度`
  （截断文件的文件头是合法的，只有节表能暴露问题）
- 落盘后再跑一次 `--version` 才认
- 全部失败 → 回落上游的 `install()`，再失败才抛错
- 关键点：`spawn()` 的**同步抛错**（Windows 上 EFTYPE 就是这种）也判为不可运行，
  上游只监听了异步 `error` 事件，所以错误会漏出去变成
  `could not obtain the cloudflared binary: spawn EFTYPE`

非 Windows 平台（发布物是 `.tgz`）不在此模块处理，直接交回上游逻辑。

## 2. `lib/index.js` 两处挂钩

```diff
-import { Tunnel, bin, install } from "cloudflared";
+import { Tunnel, bin, install } from "cloudflared";
+import { ensureCloudflaredBinary } from "./binary-fix.js";
```

```diff
 async function defaultEnsureBinary() {
-	await defaultBinaryReadiness();
+	await ensureCloudflaredBinary(
+		bin,
+		defaultBinaryReadiness,
+		(message) => console.warn(`remote-web-ui: ${message}`)
+	);
 }
```

## 3. 包名与模块身份串

`package.json` 的 `name` 改成 `dsh-mobile-remote`。构建产物里把上游包名当**模块身份**
用（`window.__ModuleLoader__.load({ id })`、`mountOnce(packageName, fn)`、
CSS 的 `data-plugin` 标记等），因此 `lib/**/*.js`、`lib/**/*.d.ts` 里的
`@linxin666/dsh-remote-web-ui` 全部替换为 `dsh-mobile-remote`（18 个文件）。

## 4. 行 id 与设置卡片绑定

`cordis.patch.yml` 的行 id 用 **`remote-web-ui`**（与上游「单独安装」时的行
id 一致），而不是包名：

- 客户端用 `servedEntryId()` 在设置服务里查找
  `["web-ui-remote-web-ui", "ui-remote-web-ui", "remote-web-ui"]`，
  找不到就回退成 `remote-web-ui`；行 id 若换成别的（例如 `dsh-mobile-remote`），
  设置卡片会绑到不存在的入口
- 为防安装器生成的行 id 与包名一致，`lib/client.js` 里把
  `"dsh-mobile-remote"` 也加进了这组候选（`ENTRY_ID_OWN`，放在最前）

## 如何验证这份修改

```bash
node test-binary-fix.mjs
```

需要本机有一个可用的 `cloudflared.exe`（默认读
`~/.dsh/profiles/desktop/node_modules/cloudflared/bin/cloudflared.exe`），
测试会校验：

1. 完整二进制 → PE 完整 ✅、能跑 `--version` ✅
2. 截断副本（取前 1/4）→ PE 不完整 ✅、判为不可运行 ✅
3. 空文件 → 同上 ✅

## 如果你要基于源码重建

上游源码在它的 monorepo 里（`packages/dsh-remote-web-ui`），构建命令 `pnpm build`。
把本仓库的 `lib/binary-fix.js` 逻辑照搬到 `src/tunnel.ts` 的
`defaultEnsureBinary`（或等价位置），重跑构建，并保留第 3、4 节的替换即可。
