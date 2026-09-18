---
description: "dsh-restart: a Settings page that restarts the dsh Web host process with one click."
---

# dsh-restart

一键重启 DeepSeek Harness(dsh)Web 宿主进程:在设置面板里多出一个「重启」页。
One-click restart of the DeepSeek Harness (dsh) Web host, from a page in Settings.

## 它做什么 / What it does

- **宿主半**在 Web 服务器上注册两个仅限本机同源访问的路由:
  - `GET /dsh-restart/status` — 当前进程的 boot id、PID、启动时间、端口
  - `POST /dsh-restart/restart` — 替换当前进程(返回 `202` 后宿主退出)
- **浏览器半**在设置面板注册「重启」页:显示宿主信息,提供重启按钮;点击后轮询状态,新宿主一旦就绪就自动刷新页面。

重启由 detached helper 完成:宿主在 400ms 后退出,helper 等到端口真正释放再按**完全相同的启动命令**拉起新进程(Node 可执行文件、`execArgv`、入口绝对路径、argv 尾巴、工作目录),因此不会出现端口占用导致的启动失败。日志写在系统临时目录的 `dsh-restart-<时间戳>.out.log` / `.err.log`。

会话记录保存在磁盘上,重启后仍然存在;已安装但尚未生效的插件会在重启后加载。

## 安装 / Install

```sh
# GitHub 源
dsh plugin --profile web add github:DWJZ/dsh-restart

# 本地开发(在插件目录里改代码,profile 直接软链)
dsh plugin --profile web add link:/path/to/dsh-restart
```

首次安装后需要重启一次宿主(用终端重启,或临时点 dshmarket 的重启按钮),「设置 → 重启」页才会出现;之后就一直用它自己重启即可。

## 端点约定 / Endpoint contract

`POST /dsh-restart/restart` 只接受来自回环地址、且 `Origin` 与 `Host` 一致的请求;任何转发头(`Forwarded`、`X-Forwarded-For`、`X-Real-IP`)或非回环来源都会拒绝,返回 `403`。返回 `202` 后宿主立即退出,由 helper 拉起替代进程。

## 测试 / Test

```sh
node test/smoke.mjs
```

覆盖:detached helper 真的能拉起替代进程、同源校验的四种拒绝路径、客户端 bundle 的注册与渲染。

设置 `DSH_CHECKOUT=<dsh 检出目录>` 时,额外用该检出里的 React 做一次 SSR 渲染断言;不设置则跳过该条。
