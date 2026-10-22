# dsh-mobile-remote

手机扫码即可远程使用 DSH Web GUI 的插件——本仓库是
**@linxin666/dsh-remote-web-ui 0.4.6 的修订分发版（fork）**，
只为一个现实问题：**cloudflared 二进制下载截断导致公网隧道永远起不来**。

## 根据谁的作品改的

| 项 | 内容 |
|---|---|
| 原作者 | **linxin666** |
| 原仓库 | <https://github.com/zhu1090093659/dsh-web> |
| 原包 | `@linxin666/dsh-remote-web-ui` |
| 本仓库基于 | **0.4.6** 的构建产物（lib/） |
| 许可 | Apache-2.0（保留原 `LICENSE`，附加 `NOTICE`） |

原版安装命令（引用，非本仓库）：

```bash
dsh plugin --profile web add @linxin666/dsh-remote-web-ui@latest
```

## 为什么改

上游启动公网隧道时，会用 npm 包 `cloudflared` 的 `install()` 从 GitHub 直链
下载二进制。这个下载**没有断点续传、也没有完整性校验**：网络一中断，就会在
`node_modules/cloudflared/bin/cloudflared.exe` 留下一个**半个文件**。

Windows 执行被截断的 PE 会返回 `EFTYPE`，而插件的探测只监听异步 `error`
事件、没有捕获同步抛出，于是现象是：

```
公网隧道启动失败：could not obtain the cloudflared binary: spawn EFTYPE
```

实测证据：文件 12,974,592 字节，而 PE 节表数据最远到 51,946,496 字节
（完整文件 55,329,336 字节）——文件头合法，但内容被截断。

## 改了什么

只动「怎么拿到 cloudflared」，不动远程访问的任何功能逻辑：

1. **新增 `lib/binary-fix.js`**：启动隧道前自愈
   - 现成二进制能跑 `--version` → 直接用
   - 存在但跑不通（截断/架构不符）→ 改名留档，不挡重下
   - 依次尝试 `gh-proxy.com` / `ghproxy.net` / GitHub 直链，**带 Range 断点续传**
   - **PE 完整性校验**（每个节 `rawPtr + rawSize` 不越过文件末尾）通过才落盘
   - 落盘后再验证一次 `--version`；全部失败才回落到上游 `install()`
   - 同步 `spawn` 抛错也当作「不可运行」（上游漏在这）
2. **`lib/index.js` 两处挂钩**：引入模块；把 `defaultEnsureBinary()` 改为调用它
3. 分发**构建产物** `lib/`（上游构建依赖 monorepo 工具链，本仓库不重复造）；
   精确改动见 [`PATCHES.md`](PATCHES.md)

## 安装

装到你的 profile（DSH 的 Web 端以 `dsh web` 启动）：

```bash
dsh plugin add github:zfy10086/dsh-mobile-remote
```

或用本地路径：

```bash
dsh plugin add link:/path/to/dsh-mobile-remote
```

### 如果你已经装了 `@linxin666/dsh-web-all`

全家桶里有一行指向原版（`@linxin666/dsh-remote-web-ui`），两边同时挂载会冲突
（两套 `/api/pair` 路由）。装本插件前，先在 profile 的 `cordis.patch.yml` 里
**禁用那一行**：

```yaml
- id: web-ui-remote-web-ui
  disabled: true
```

然后再执行上面的安装命令。想回到全家桶版本：删掉本插件、删掉这段 `disabled`。

## 使用

1. 设置 → Web 插件 → 远程访问（没装全家桶时在「设置 → 插件 → 本插件行」）
2. 需要家里 Wi-Fi 直连：打开「局域网访问」（把服务绑到 `0.0.0.0`，**重启 DSH 生效**）
3. 需要外网：打开「自动公网隧道」；「固定域名中继」默认开启，会给一个固定地址
4. 点侧栏底部的**电话图标** → 扫码配对 → 手机进入官方 Web GUI（竖屏自动套触摸层）
5. 手机不用时：面板点「停止」会撤销所有配对设备与令牌；**但它不停隧道**。
   要彻底不挂公网，把「自动公网隧道」关掉（或 `autoTunnel: false` 后重启）

## 已知限制

- **设置卡片**：本 fork 已把行 id 对齐成上游「单独安装」使用的 `remote-web-ui`，并把
  包名登记进客户端的候选列表，安装后设置卡片应能正常绑定。若仍提示
  「部署未接受这些值，已保留供你修改」，那是上游与宿主版本之间的兼容问题，
  临时办法是直接改 profile 的 `cordis.patch.yml`（字段：`autoTunnel` / `relay` /
  `lanBind` / `tunnelToken` / `publicBaseUrl`）。
- **依赖上游对 harness 内部接口的使用**（`__DSH_TRANSPORT__`、`connection.isLoopback`
  等），DSH 升级后可能失效，需跟随上游更新。
- **与全家桶共存需要处理**：装了 `@linxin666/dsh-web-all` 时，必须禁用它的
  `web-ui-remote-web-ui` 行（见上文「安装」），否则两套 `/api/pair` 路由会冲突。
- **公网隧道 = 把本机 DSH 的入口挂到公网**；配对即全权限凭证，别外传二维码或链接。
  「停止」只撤销配对、不停隧道，要彻底下线需关闭「自动公网隧道」。

## 许可证

Apache License 2.0，见 [`LICENSE`](LICENSE)。本仓库是第三方 fork，
与原作者无隶属关系；其余署名与版权见 [`NOTICE`](NOTICE)。
