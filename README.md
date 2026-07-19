# B站收藏 → 得到大脑

当前版本：`1.6.1`

完整教程：https://blog.brmys.cn/bilibili-favorites-to-getnote-20260719

项目主页：https://github.com/brmysss/bilibili-favorites-to-getnote

Chrome / Edge Manifest V3 插件。定期读取 B站收藏夹中的视频 ID，与本地基线比较后，将新增视频链接提交给得到大脑/Get笔记自动解析。

## 安装

1. 在 Chrome 打开 `chrome://extensions/`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录 `bilibili-getnote-sync-extension/`。
5. 在浏览器中登录 B站。
6. 打开插件“设置”，填写 Get笔记 OpenAPI 的 API Key 和 Client ID。
7. 起始日期保持 `2026-07-19` 并保存设置。
8. 点击“检查收藏夹新增”，首次运行会建立现有收藏基线。

## 工作方式

- 不调用被风控的 `/x/v3/fav/resource/list` 详情接口。
- 使用轻量的 `/x/v3/fav/resource/ids` 接口，只读取 AV ID，不获取标题、封面、作者等多余信息。
- 首次检查建立完整基线，不上传历史收藏；后续只同步新出现的 ID。
- 默认每 10 分钟自动检查，也可以手动点击“检查收藏夹新增”。
- 使用 BVID 本地去重；成功和 Get笔记已存在都会标记为已处理。
- 链接笔记提交后，插件会在后台查询解析结果。
- 设置目标知识库 ID 后，解析成功的笔记会自动加入该知识库。
- Get笔记已经存在的重复链接会自动去重。
- 手机或其他设备上的收藏也会在浏览器下一次检查时被发现。
- 得到大脑请求按 800ms 间隔串行执行；遇到 `429/qps_global_exceeded` 时自动指数退避重试。
- 每次处理新增链接前，自动审计带“B站收藏/自动同步”标签但未加入目标知识库的历史笔记，并先行补归档。

## 安全说明

- API Key 和 Client ID 只保存在 `chrome.storage.local`。
- 插件源码、日志和仓库中均不包含密钥。
- 本地安装的浏览器扩展仍能访问其本地存储；不要把已配置后的浏览器配置目录分享给他人。

## 开发检查

```bash
npm test
npm run check
```
