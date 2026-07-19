# GitHub 与更新发布说明

## 推荐仓库内容

将整个 `bilibili-getnote-sync-extension/` 目录作为独立 GitHub 仓库发布，但不要提交：

- 用户的 Get笔记 API Key、Client ID；
- Chrome 本地存储数据；
- 导出的个人同步 JSON；
- Chrome 自动生成的 `_metadata/`。

每次发布时更新 `manifest.json` 和 `package.json` 的版本号，并创建 GitHub Release，上传打包 ZIP。

## 用户更新方式

### Chrome Web Store（推荐）

发布到 Chrome Web Store 后，浏览器会自动检查和安装新版本。用户不需要手动点击更新，这是最稳定的分发方式。

### GitHub Release

通过 GitHub 安装的解压版扩展无法静默自更新。可以在插件中增加“检查更新”按钮，用 GitHub Releases API 比较版本并打开下载页，但用户仍需下载新版并在扩展管理页重新加载。

### 自托管 CRX

技术上可以配置 `update_url` 和更新 XML，但 Chrome 在 macOS/Windows 上通常限制商店外扩展的自动安装，不建议作为普通用户分发方案。

## 建议路线

1. GitHub 开源仓库：版本管理、问题反馈、源码下载；
2. GitHub Actions：自动打包 ZIP 和创建 Release；
3. Chrome Web Store：面向普通用户安装与自动更新；
4. 插件内“检查更新”：作为 GitHub 版用户的辅助入口。
