# 微信个人号 iLink Bot API — 协议全解 + 裸调实证

> S142 研究资产（2026-08-31 深夜协议解密 + 实证裸调；2026-08-31 重建后落盘）。
> 目的：dsp 微信桥（weixin-bridge service）的协议真相源——**不依赖 OpenClaw 平台**，腾讯官方 iLink API 纯 fetch 可调。
> 关联：`docs/acp-wecom-design.md`（F4c 企微路线，长连接/回调）、`docs/knowledge-ccc-release-research.md`（微信桥 B1/B2 调研）。

---

## 1. 定位与关键结论

- **iLink** = 腾讯官方开放微信个人 Bot API（`ilinkai.weixin.qq.com`，HTTP/JSON，无需 SDK）
- **openclaw-weixin 插件** = 腾讯官方 `@tencent-weixin/openclaw-weixin`（社区镜像 `hyonex/openclaw-weixin`，41 TS 文件），本文件以该插件源码为协议基准 + 裸调实证交叉验证
- **✅ 决定性实证（2026-08-31，ubuntu 裸 curl，无 OpenClaw）**：`get_bot_qrcode` 直接返回二维码 → **不需要 OpenClaw 账号体系/平台审核，扫码即用**（原关键未知 ② 已解决）
- **风险条款**：腾讯仅提供管道，可随时限速/终止；bot_type=3 语义未官方文档化（实证可用）

## 2. 端点与公共头

| 项 | 值 |
|----|----|
| API Base | `https://ilinkai.weixin.qq.com` |
| CDN Base | `https://novac2c.cdn.weixin.qq.com/c2c` |
| 公共头 | `iLink-App-Id: bot` + `iLink-App-ClientVersion: <int>` |
| ClientVersion 算法 | `(major<<16)|(minor<<8)|patch`；2.1.1 → `131329` |

```bash
# 裸调实证（成功，ubuntu）：
curl -s -m 10 \
  -H 'iLink-App-Id: bot' -H 'iLink-App-ClientVersion: 131329' \
  'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3'
# → {"qrcode":"d32f...","qrcode_img_content":"https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=...&bot_type=3","ret":0}
```

## 3. 鉴权流（扫码登录）

```
1. GET  /ilink/bot/get_bot_qrcode?bot_type=3
   → { qrcode, qrcode_img_content }        # qrcode_img_content 给用户扫
2. GET  /ilink/bot/get_qrcode_status?qrcode=<qrcode>    # 轮询（1s 间隔，5min TTL）
   → status: wait | scaned | scaned_but_redirect | confirmed | expired
   → confirmed 时返回: bot_token / ilink_bot_id / baseurl / ilink_user_id
3. 保存 { token: bot_token, baseUrl, userId: ilink_user_id } → 后续 Bearer 鉴权
```

带 token 后的请求头（每请求必带）：
```http
Content-Type: application/json
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: <random-uint32-base64>      # 随机防重放
Authorization: Bearer <bot_token>
iLink-App-Id: bot
iLink-App-ClientVersion: 131329
```

## 4. 消息收发

### 收消息（长轮询）
```
POST /ilink/bot/getupdates
body: { "get_updates_buf": "<游标>" }      # 首轮 ""，后续回传响应的 get_updates_buf
→ { ret, msgs: WeixinMessage[], get_updates_buf, longpolling_timeout_ms }
```
- 长轮询 hold ≈ 35s（AbortController 超时兜底，超时返回空 msgs 不报错）
- 游标协议：`get_updates_buf` 从响应原样带回，是增量续传的唯一状态

### 发消息（必须回带 context_token 关联对话）
```
POST /ilink/bot/sendmessage
body: { "msg": {
  "from_user_id": "",
  "to_user_id": "<对方 from_user_id>",
  "client_id": "<随机客户端 id>",
  "message_type": 2,        # 1=USER 2=BOT
  "message_state": 2,       # 0=NEW 1=GENERATING 2=FINISH
  "item_list": [ { "type": 1, "text_item": { "text": "..." } } ],
  "context_token": "<收到消息时回带的 context_token>"
}}
```

### 正在输入 / 配置
```
POST /ilink/bot/sendtyping   body: { ilink_user_id, typing_ticket, status }   # 1=TYPING 0=CANCEL（对齐官方参考实现 onCleanup status=0；早期注释"2=CANCEL"为误记）
POST /ilink/bot/getconfig    body: { ilink_user_id, context_token } → { typing_ticket }
```
- 流程：收消息 → `getconfig` 拿 `typing_ticket`（每用户缓存复用）→ 处理前 `sendtyping status=1`（微信侧显示"正在输入..."）→ 处理后 `sendtyping status=0`
- 参考实现（openclaw-weixin index.ts `typingCallbacks`）：onReplyStart → status 1 / onCleanup → status 0；失败吞错不阻断主流程

## 5. 消息类型（item_list type）

| type | 内容 | 说明 |
|------|------|------|
| 1 | TEXT | `text_item.text` |
| 2 | IMAGE | `image_item.media`（CDN 加密媒体） |
| 3 | VOICE | `voice_item.media`（SILK）——**`voice_item.text` = 微信服务端自带语音转写**（官方插件直接读该字段，无需下载/ASR；v1.27.3 语音支持主路径） |
| 4 | FILE | `file_item.media` + `file_name` |
| 5 | VIDEO | `video_item.media` |

消息字段（WeixinMessage）：`seq / message_id / from_user_id / to_user_id / client_id / create_time_ms / session_id / group_id / message_type / message_state / item_list / context_token`

**多用户（发送者区分）**：`from_user_id`（形如 `xxx@im.wechat`）唯一标识发送者 → 按它映射 skiff 会话 `skiff-weixin-<userid>`。

## 6. 媒体（CDN，AES-128-ECB 加密）

```
POST /ilink/bot/getuploadurl
body: { filekey, media_type(1图/2视频/3文件/4语音), to_user_id,
        rawsize, rawfilemd5, filesize(补齐16倍数), aeskey(hex), no_need_thumb: true }
→ { upload_param?, thumb_upload_param?, upload_full_url? }

上传: POST <upload_full_url 或 CDN_BASE>/upload?encrypted_query_param=<upload_param>&filekey=<filekey>
      body = AES-128-ECB(明文, aesKey)   # aesKey = randomBytes(16)
      响应头 x-encrypted-param（或 body encrypted_query_param）→ 发送媒体时用

发送: item.media = { encrypt_query_param, aes_key: base64(hex(aesKey)), encrypt_type: 1 }
```

- 下载同理反向：媒体在消息里携带 `encrypt_query_param/aes_key` → CDN GET → AES-128-ECB 解密
- 首版文本桥可不实现媒体（微信用户发图 → 提示"暂不支持图片"或转存落盘）

## 7. 多账号

- 账号 id 自增：`wechat-1, wechat-2, ...`（auth.ts `generateAccountId`）
- 每账号独立 `{ token, baseUrl, userId }` + 独立轮询循环 + 独立会话空间
- 配置存储（dsp 落地）：**plugin 全局** `~/.dsh/serenity-hooks.json`（归属二分 D5——账号/token 是 plugin 级，非 CCC 级）

## 8. 适配注意（dsp 实现要点）

1. **零 SDK**：纯 `fetch`，Node ≥ 18 原生即可；tsdown 无新依赖（crypto 内置）
2. **markdown → 纯文本**：微信不支持 Markdown，发消息前必须转换（代码块/图片/链接/标题/粗体/表格/删除线 7 类，见 messenger.ts `markdownToPlainText`）
3. **client_id**：每消息随机（`openclaw-weixin-<uuid8>`），幂等/防重
4. **context_token**：收消息 → 回复必须回带；缺失会导致对话无法关联
5. **超时语义**：getupdates 35s 长轮询超时 = 正常（返回空），非错误
6. **bot_type=3**：默认值，实证可用；语义未官方文档化（可能=个人微信 bot 平台类型）

## 9. 实证记录（2026-08-31）

| 项 | 结果 |
|----|------|
| 裸调 `get_bot_qrcode?bot_type=3`（ubuntu curl，无 OpenClaw） | ✅ `ret:0`，返回 qrcode + liteapp 扫码链接 |
| 是否需要 OpenClaw 账号/平台审核 | ✅ **不需要**（协议级直接可取码） |
| 完整收发链（扫码 → getupdates → sendmessage） | ⏸ 待真实扫码获取 bot_token 后联调（用户侧动作） |
