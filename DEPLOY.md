# Trading 212 看板云端部署

要让朋友随时打开，并且你关电脑后仍然 5 秒自动更新，需要把这个 Node.js 服务部署到云端。

## 必填环境变量

在云服务的 Environment Variables / Secrets 里设置：

```text
TRADING212_API_KEY=你的 API key
TRADING212_SECRET_KEY=你的 secret key
TRADING212_ENV=live
PUBLIC_DASHBOARD=true
SHARE_TOKEN=811123
REFRESH_MS=5000
HOST=0.0.0.0
```

如果云服务自动提供 `PORT`，不要手动设置 `PORT`。如果需要固定端口，就设为 `4312`。

## 推荐部署方式

### Render / Railway / Fly.io / VPS

这些平台都可以运行这个项目：

1. 上传整个项目，但不要上传 `.env`。
2. 选择 Node.js 或 Docker 部署。
3. 启动命令使用 `npm start`，或直接用 Dockerfile。
4. 在平台后台添加上面的环境变量。
5. 部署完成后，用下面的格式分享链接：

```text
https://你的云端域名/?token=811123
```

## 安全说明

- `SHARE_TOKEN` 是看板访问码，不是 Trading 212 密码。
- 任何拿到完整链接的人都能看到你的持仓和账户总值。
- 不要把 `.env` 上传到 GitHub 或发给别人。
- 想停止分享时，改掉 `SHARE_TOKEN` 并重新部署。
