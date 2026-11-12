# 本机音频识别后端

推荐返回项目根目录双击 `start.cmd`。默认使用 faster-whisper small 转写音频、Ollama qwen2.5:3b 提取重点、librosa pYIN 生成音高数据，结果由同一个本机网页展示。无需填写云端 API Key。

`launch_web.py` 从当前文件夹的 `.env` 读取配置，只监听 `127.0.0.1`，在 8000–8010 中选择端口。端口复用要求 `/api/health` 返回 `service=audio-insight`、`version=6` 和相同运行模式。每次双击启动时，`setup_local.py` 都会检查 Whisper、Ollama 和本地说话人模型，然后再打开已有网页或启动新服务。

`chinese_text.py` 使用 OpenCC 统一转写、分段文字及结构化重点的繁简字形，在结果保存、读取和历史接口生效；不更改音频、时间戳及音高数据。

```powershell
# 从项目根目录运行
.\start.cmd
# 不打开浏览器，保留服务窗口
.\start.cmd --no-browser
# 检查环境和模型后退出
.\start.cmd --no-browser --check
```

基础依赖见 `requirements.txt`，本地模型和音高依赖见 `requirements-local.txt`。启动器使用本目录 `.venv`，按依赖文件内容检测是否需要更新安装。

## 数据与接口

原始音频及结果保存在本目录 `data` 下。成功结果同时保留完整转写、结构化重点和音高分析数据，历史页面可再次查看。

```text
GET  /                         网页
GET  /api/health                服务身份、模式与配置状态
POST /api/recognition           上传并创建识别任务
GET  /api/recognition/status?taskId=...
POST /api/recognition/{task_id}/summary  使用已有转写重新提取重点
GET  /api/recognition/{task_id}/segments/{segment_index}/audio  获取该条原声 WAV
POST /api/recognition/{task_id}/speakers               对已有转写补做说话人分组
PATCH /api/recognition/{task_id}/speaker-labels        设置每组显示名称，JSON: {"labels":{"speaker_0":"男生A"}}
PATCH /api/recognition/{task_id}/segments/{index}/speaker  调整单条归属，JSON: {"speakerId":"speaker_0"}
GET  /api/recognition/history           历史记录
```

`POST /api/recognition` 使用 multipart 音频字段 `audioFile`，可同时提供 `format`、`sampleRate`、`duration`。创建任务返回 `taskId`，状态接口返回处理中、成功或错误原因。音高基于音频中的有声片段估计，静音和无法估计的帧不会当作 0 Hz。

已有转写的历史记录可点击“重新提取重点”，无需重新上传音频。该操作保留原文字和音高，只更新重点信息及对应处理状态；同一记录仍在处理时返回 HTTP 409。

每条转写右侧的小喇叭使用记录中保存的分段时间，在本机从原始音视频提取对应原声，以 WAV 返回。切片缓存在 `data` 下，已有记录只要保留了原始音频和分段时间也能播放。

`speaker_diarization.py` 使用 Pyannote 分段模型和 3D-Speaker 向量模型进行本地分组，再按时间重叠将结果映射到原转写段；不会改变转写段的原文或起止时间。`speakers` 保存分组及用户名称，`segments[].speakerId` 保存归属，`speakerMixed` 提示可能包含多人。模型不推断性别；“男生A”“女生A”均为用户设置的显示名称。分组期间状态为 `Diarizing`。

## 可选云端和演示模式

`start_cloud.cmd` 会选择真实云端模式，`.env` 中填写 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`TRANSCRIPTION_MODEL` 和 `EXTRACTION_MODEL`。兼容服务需要支持音频转写及项目使用的文本接口。密钥只保存在服务端。

`start_mock.cmd` 选择演示模式，用于查看页面和保存流程；其结果明确标记为演示，不能作为真实音频内容。默认 `start.cmd` 明确设置 `AI_MODE=local` 和 `MOCK_MODE=false`。

## 原文件定位播放（接口版本 9）

- `GET /api/recognition/{task_id}/media`：检查保存的原文件，按实际视频轨道返回 `kind`（video/audio）、MIME、时长、尺寸、文件名和播放器 URL；排除音频封面图片。不会返回磁盘绝对路径。
- `GET /api/recognition/{task_id}/media/file`：从项目音频目录提供原文件，支持 HTTP Range 和 206 响应，浏览器可以直接跳转原时间轴。不存在返回 404，目录外路径返回 403，无法读取媒体信息返回 422。来源不接受任意文件路径参数。
- 网页 `source-player.js` 管理原视频/原音频，点击句子设定起止时间，用原生播放器跳转并在句尾暂停；切换记录或句子时阻止旧异步请求继续播放。保留原有片段音频接口兼容此前客户端。
- `verification/test_source_media.py` 检查 Range、实际轨道和路径边界；`verification/test_source_player.cjs` 检查跳转、句尾暂停、切换及手动拖动。

## 实时转写和搜索

- `POST /api/live/transcribe`：请求体为单声道 16 kHz、16 位 PCM WAV，0.1–12 秒且不超过约 388 KB。本地模式返回简体 `text` 和逐词相对时间 `words`；片段只在内存中处理，不创建识别记录。复用完整转写的 Whisper 模型，忙时返回 409，格式错误返回 400，过大返回 413，依赖/模型错误返回 503。
- 浏览器通过 `live-capture.worklet.js` 对输入重采样，`live-capture.js` 每约 4 秒发送一段，附带前 1 秒上下文，再按词时间排除上下文。处理落后时以最多 8 秒的主窗口追赶，停止后补齐尾段。使用标准 Web Audio API，不使用 Web Speech 云端服务。MediaRecorder 独立保留完整录音。
- `GET /api/recognition/search?q=关键词&taskId=可选任务号&limit=100`：搜索保存的分句（兼容只有全文的旧记录），返回 `query/matches/total/truncated`。每个匹配包含记录号、文件名、分句索引、文字、时间和说话人称呼，不返回音频绝对路径。搜索仅查文字，最多展示 100 条，不改变原始记录。

验证脚本位于项目根 `verification`：Python 的 `test_live_search.py` 检查格式上限、忙锁和搜索；Node 的 `test_live_capture.cjs` 检查真实工作线程代码的重采样、WAV 格式、重叠和停录尾段。`live_browser_probe.py` 是仅用于验证的单独回环服务，通过用户选择的测试音频验证真实采音/ASR，不读取麦克风，不包含在源码 ZIP 中。

## 模糊片段检查

本地转写自动返回 `segments[].words`（时间和 probability）、`asrMetrics`、`review` 及 `reviewInfo`。`review.spans` 是简体分句中的字符范围；只标记可定位的低分词，不能定位时按句提示。`review.checked=false` 表示缺少足够识别证据，不能视为可靠。

`POST /api/recognition/{task_id}/review` 为已保存的分句补查：异步返回 `Reviewing`，通过原有 status 接口轮询；有分数时复用，无分数时从项目音频目录的原声重新取得分数，按时间匹配，保留原文和说话人等数据。并发修改或重复提交返回 409。缺失原声时保留已有结果并报告错误。

规则和使用步骤见项目根 README 的“模糊片段与待核对”。分数不等于正确率，提示用于复听核对。

