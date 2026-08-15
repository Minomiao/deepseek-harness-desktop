# DeepSeek Harness Desktop

DeepSeek Harness Web 界面的桌面客户端（跨平台）。

## 项目简介

DeepSeek Harness 是 DeepSeek 官方的 Agent 开发框架，原版通过命令行 `npx @deepseek-ai/dsh web` 启动服务后在浏览器访问。本项目用 Electron 把它封装成桌面应用：

- 双击即用：自动拉起本机 dsh 服务，界面内嵌在应用窗口中，无需命令行和浏览器
- 关闭窗口自动停止服务，不留后台进程
- 自定义图标、标题，隐藏 Electron 默认菜单栏
- 跨平台：Windows / macOS / Linux

## 安装

| 平台 | 文件 |
|---|---|
| Windows | `DSH Desktop Setup 0.1.0.exe`（安装版）/ `DSH Desktop-0.1.0-win-x64.zip`（免安装，解压即用） |
| macOS (Apple Silicon) | `DSH Desktop-0.1.0-arm64.dmg` |
| Linux | `DSH Desktop-0.1.0.AppImage` |

> macOS 版本未签名，首次打开请右键选择"打开"；Linux 需先 `chmod +x "DSH Desktop-0.1.0.AppImage"`。

## 首次使用

1. 打开应用，等待服务就绪后自动进入 Harness 界面
2. 配置 API Key：设置环境变量 `DEEPSEEK_API_KEY`，或编辑 `~/.dsh/settings.yaml`
3. 在输入框开始对话

## 开发

```bash
cd desktop-app
npm install        # 安装依赖
npm start          # 开发模式运行
npm run dist       # 打包当前平台安装包
```

## 多平台构建

本仓库通过 GitHub Actions 矩阵构建三平台产物（`.github/workflows/build.yml`）：

- 手动触发：Actions 页面 Run workflow
- 打 tag 自动触发：`git tag v0.1.0 && git push origin v0.1.0`

## 技术栈

- Electron 35 + Node.js 22
- DeepSeek Harness（@deepseek-ai/dsh）
