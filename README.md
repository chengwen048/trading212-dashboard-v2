# Trading 212 实时投资看板

一个只读 Trading 212 持仓看板，支持：

- Trading 212 API key + secret key Basic 认证
- 账户总值、总盈亏、收益率、现金
- 持仓列表
- K 线图
- 相关新闻
- 5 秒自动刷新
- 分享访问码保护

## 本地运行

复制 `.env.example` 为 `.env`，填入自己的 Trading 212 凭证：

```text
TRADING212_API_KEY=your_api_key
TRADING212_SECRET_KEY=your_secret_key
TRADING212_ENV=live
PUBLIC_DASHBOARD=true
SHARE_TOKEN=811123
REFRESH_MS=5000
HOST=127.0.0.1
```

启动：

```bash
npm start
```

打开：

```text
http://127.0.0.1:4312/
```

页面会先要求输入访问密码，默认示例密码是 `811123`。

## Render 部署

不要上传 `.env`。在 Render 的 Environment Variables 里设置：

```text
TRADING212_API_KEY
TRADING212_SECRET_KEY
TRADING212_ENV=live
PUBLIC_DASHBOARD=true
SHARE_TOKEN=811123
REFRESH_MS=5000
HOST=0.0.0.0
```

Render 会自动提供 `PORT`，不需要手动设置。

部署完成后分享：

```text
https://your-service.onrender.com/
```

访问者打开网址后输入 `SHARE_TOKEN` 对应的密码即可进入。

## 安全

任何知道访问密码的人都能看到持仓和账户总值。想停止分享时，修改 `SHARE_TOKEN` 并重新部署。
