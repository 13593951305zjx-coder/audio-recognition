const $ = (selector) => document.querySelector(selector);
const terminalStatuses = new Set(["Success", "Partial", "Failed", "Cancelled"]);
const statusLabels = { Queued: "排队中", Preparing: "准备识别", Uploading: "上传中", Analyzing: "分析音高", Recognizing: "转写中", Diarizing: "区分说话人", Reviewing: "检查模糊片段", Summarizing: "提取重点", Success: "已完成", Partial: "部分完成", Failed: "处理失败", Cancelled: "已取消" };
let batchQueue = null;
let mediaRecorder = null;
let mediaStream = null;
let recordInputSession = null;
let fragmentSummaryPanel = null;
let speakerOrganizer = null;
let transcriptEditor = null;
let waveformEditor = null;
let recordStartedAt = 0;
let timerHandle = null;
let durationSeconds = 0;
let lastPitchStats = null;
let currentResult = null;
let activeRun = null;
let toastTimer = null;
let segmentPlayback = null;
let sourcePlayer = null;
let sourceMediaInfo = null;
let speakerSaving = false;
let liveSession = null;
let recordStarting = false;
let maxRecordingSeconds = 300;
let keywordController = null;
let keywordTimer = null;
let keywordMatches = [];
let searchTaskId = null;
let historyRecords = [];
let historyEditId = null;
let historySavingId = null;
let micMonitor = null;
const speakerIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"/></svg>';
const stopIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>';
const videoPlayIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 4 12 8-12 8V4Z"/></svg>';
const speakerStatsColors = ["#6658e8", "#319f83", "#d38738", "#4e86c8", "#bb69a8", "#799342"];
const webSearchIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg>';

function updatePlaybackButtons() {
  document.querySelectorAll(".segment-play").forEach((button) => {
    const active = segmentPlayback?.taskId === (button.dataset.taskId || currentResult?.taskId) && segmentPlayback?.index === Number(button.dataset.segmentIndex);
    const loading = active && segmentPlayback.state === "loading";
    button.setAttribute("aria-pressed", String(Boolean(active)));
    button.setAttribute("aria-busy", String(Boolean(loading)));
    const isVideo = sourceMediaInfo?.kind === "video" && (button.dataset.taskId || currentResult?.taskId) === sourcePlayer?.taskId;
    button.setAttribute("aria-label", `${active ? "停止播放" : "播放"}第 ${button.dataset.lineNumber} 条${isVideo ? "视频" : "原声"}`);
    button.title = active ? "点击停止播放" : button.disabled ? "此条没有可用的时间段" : "跳转到原文件对应时间播放";
    button.innerHTML = loading ? '<span aria-hidden="true">…</span>' : active ? stopIcon : isVideo ? videoPlayIcon : speakerIcon;
    button.closest(".transcript-entry").classList.toggle("is-playing", Boolean(active));
  });
  document.querySelectorAll(".transcript-jump").forEach((button) => {
    const active = segmentPlayback?.taskId === (button.dataset.taskId || currentResult?.taskId) && segmentPlayback?.index === Number(button.dataset.sourceIndex);
    button.setAttribute("aria-pressed", String(Boolean(active)));
  });
}
function stopSegmentPlayback() {
  if (sourcePlayer) sourcePlayer.stop();
  else { segmentPlayback = null; updatePlaybackButtons(); }
}
async function playTranscriptSegment(index) {
  const entry = transcriptEntries(currentResult).find((item) => item.index === index);
  if (!currentResult?.taskId || !entry?.timed || entry.end <= entry.start) return;
  sourcePlayer.prepare(currentResult.taskId, historyName(currentResult));
  await sourcePlayer.playRange(index, entry.start, entry.end);
}

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => $("#toast").classList.remove("show"), 4000);
}
function setError(message = "") { $("#error-text").textContent = message; }
function setState(status) { $("#result-state").textContent = statusLabels[status] || status || "待处理"; }
function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function webSearchChips(terms) {
  const unique = [...new Set(terms.map((term) => String(term || "").trim()).filter((term) => term.length >= 2 && term.length <= 32))];
  if (!unique.length) return "";
  return `<span class="web-search-chips" aria-label="可网页搜索的内容">${unique.map((term) => `<span class="web-search-chip"><span class="web-search-chip-text">${escapeHtml(term)}</span><a class="web-search-link" href="https://www.bing.com/search?q=${escapeHtml(encodeURIComponent(term))}" target="_blank" rel="noopener noreferrer" aria-label="在浏览器搜索：${escapeHtml(term)}" title="在浏览器搜索：${escapeHtml(term)}">${webSearchIcon}</a></span>`).join("")}</span>`;
}
function findWebSearchTerms(text, info, extraTerms = []) {
  const source = String(text || ""), candidates = [];
  const add = (term, index = source.indexOf(term), priority = 1) => {
    const value = String(term || "").trim();
    if (index >= 0 && value.length >= 2 && value.length <= 32) candidates.push({ term: value, index, end: index + value.length, priority });
  };
  for (const word of Array.isArray(info?.keywords) ? info.keywords : []) add(word, source.indexOf(word), /^(?:小|老|阿)[\u4e00-\u9fff]{1,2}$|(?:先生|女士|教授|老师)$/.test(word) ? 3 : 1);
  for (const item of Array.isArray(info?.action_items) ? info.action_items : []) {
    if (item && item.owner && !/^未指定/.test(item.owner)) add(item.owner, source.indexOf(item.owner), 3);
  }
  for (const word of extraTerms) add(word);
  const times = /(?:20\d{2}年(?:\d{1,2}月(?:\d{1,2}[日号])?)?|\d{1,2}月\d{1,2}[日号]|(?:本|上|下)?(?:周|星期)[一二三四五六日天](?:上午|下午|晚上)?(?:\d{1,2}点(?:半|\d{1,2}分)?)?(?:之前|以后|左右)?|(?:今天|明天|后天|昨天)(?:早上|上午|中午|下午|晚上|凌晨)(?:\d{1,2}点(?:半|\d{1,2}分)?)?(?:之前|以后|左右)?|(?:早上|上午|中午|下午|晚上|凌晨)\d{1,2}点(?:半|\d{1,2}分)?|\d{1,2}[:：]\d{2})/gu;
  for (const match of source.matchAll(times)) add(match[0], match.index, 2);
  const titledPeople = /[\u4e00-\u9fff]{1,3}(?:先生|女士|教授|老师)/gu;
  for (const match of source.matchAll(titledPeople)) {
    const trimmed = match[0].replace(/^(?:如果|因为|那个|这个|以及|关于|是否|或者|的|了|在|是|把|给|对|向|和|与|请)/, "");
    add(trimmed, match.index + match[0].length - trimmed.length, 3);
  }
  candidates.sort((a, b) => b.priority - a.priority || a.index - b.index || b.term.length - a.term.length);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= 6) break;
    if (selected.some((item) => item.term === candidate.term || (candidate.index < item.end && candidate.end > item.index))) continue;
    selected.push(candidate);
  }
  return selected.sort((a, b) => a.index - b.index).map((item) => item.term);
}
function numberOrNull(value) { return value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value); }
function formatHz(value) { const hz = numberOrNull(value); return hz == null ? "—" : `${hz.toFixed(1)} Hz`; }
function formatMediaTime(seconds) {
  const ticks = Math.max(0, Math.round(seconds * 100));
  const whole = Math.floor(ticks / 100);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const tail = `${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}.${String(ticks % 100).padStart(2, "0")}`;
  return hours ? `${String(hours).padStart(2, "0")}:${tail}` : tail;
}
function transcriptEntries(result) {
  const entries = (Array.isArray(result?.segments) ? result.segments : []).flatMap((segment, index) => {
    if (!segment || typeof segment.text !== "string" || !segment.text.trim()) return [];
    const start = numberOrNull(segment.start);
    const end = numberOrNull(segment.end);
    const timed = start != null && end != null && start >= 0 && end >= start;
    return [{ text: segment.text.trim(), start, end, timed, index, speakerId: segment.speakerId || null, speakerMixed: Boolean(segment.speakerMixed), review: segment.review || null }];
  });
  // Keep unknown-time entries in their original place rather than inventing times.
  if (entries.length && entries.every((entry) => entry.timed)) entries.sort((a, b) => a.start - b.start || a.index - b.index);
  if (!entries.length && typeof result?.transcript === "string" && result.transcript.trim()) {
    entries.push({ text: result.transcript.trim(), timed: false });
  }
  return entries;
}
function transcriptText(result) {
  return transcriptEntries(result).map((entry) => {
    const name = speakerName(result, entry.speakerId);
    const text = `${name ? `${name}：` : ""}${entry.text}`;
    return entry.timed ? `[${formatMediaTime(entry.start)}–${formatMediaTime(entry.end)}] ${text}` : text;
  }).join("\n");
}
function speakerName(result, id) {
  const speakers = Array.isArray(result?.speakers) ? result.speakers : [];
  return speakers.find((speaker) => speaker.id === id)?.label || (speakers.length ? "未确定说话人" : "");
}
function reviewTextHtml(entry) {
  const spans = (Array.isArray(entry.review?.spans) ? entry.review.spans : []).filter((span) => Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= entry.text.length && entry.text.slice(span.start, span.end) === span.text).sort((a, b) => a.start - b.start);
  let cursor = 0, html = "";
  for (const span of spans) {
    if (span.start < cursor) continue;
    html += escapeHtml(entry.text.slice(cursor, span.start)) + `<mark class="uncertain-word" title="模型对这部分文字识别把握较低，请听原声核对">${escapeHtml(entry.text.slice(span.start, span.end))}</mark>`;
    cursor = span.end;
  }
  return html + escapeHtml(entry.text.slice(cursor));
}
function reviewReasons(entry) {
  return (Array.isArray(entry.review?.reasons) ? entry.review.reasons : []).map(String).join("；");
}
function segmentPlayButton(result, entry, line) {
  return `<button class="segment-play" type="button" data-segment-index="${entry.index ?? -1}" data-line-number="${line + 1}" aria-label="播放第 ${line + 1} 条语音" aria-pressed="false" title="播放对应的原声" ${entry.timed && entry.end > entry.start && result.taskId ? "" : "disabled"}>${speakerIcon}</button>`;
}
function transcriptSentence(result, entry) {
  return `<button class="transcript-jump" type="button" data-source-index="${entry.index ?? -1}" aria-pressed="false" title="点击这句话，跳转播放原音频或视频" ${entry.timed && entry.end > entry.start && result.taskId ? "" : "disabled"}>${reviewTextHtml(entry)}</button>`;
}
function updateReviewButton(busy = Boolean(activeRun || batchQueue?.processing || batchQueue?.uploading || fragmentSummaryPanel?.pending || transcriptEditor?.saving || waveformEditor?.saving)) {
  const available = Boolean(currentResult?.taskId && transcriptEntries(currentResult).some((entry) => entry.timed));
  const processing = currentResult?.status && !terminalStatuses.has(currentResult.status);
  $("#check-review").disabled = Boolean(busy || processing || speakerSaving || !available);
  $("#check-review").textContent = currentResult?.status === "Reviewing" ? "正在检查…" : currentResult?.reviewInfo ? "重新检查模糊片段" : "检查模糊片段";
}
function renderReview(result) {
  const entries = transcriptEntries(result), flagged = entries.filter((entry) => entry.review?.needsReview);
  const checked = entries.filter((entry) => entry.review?.checked).length;
  const unknown = entries.length - checked;
  $("#review-tab").textContent = flagged.length ? `待核对 (${flagged.length})` : "待核对";
  $("#review-summary").textContent = result.status === "Reviewing" ? "正在从原声检查，已有文字、时间和说话人标签会保留。" : result.reviewInfo
    ? `已检查 ${checked}/${entries.length} 条，${flagged.length} 条建议复听。${unknown ? `另有 ${unknown} 条缺少可靠识别分数，暂无法判断。` : ""}`
    : entries.length ? (entries.some((entry) => entry.timed) ? "此记录尚未检查；旧记录可以点击左侧按钮补查。" : "这条记录没有分句时间，请重新上传音频后检查。") : "有转写结果后，可检查需要复听的片段。";
  $("#review-empty").hidden = flagged.length > 0;
  $("#review-list").hidden = !flagged.length;
  $("#review-empty-text").textContent = result.status === "Reviewing" ? "正在检查，请稍候…" : result.reviewInfo
    ? (unknown ? "部分片段暂无法判断，请结合原声核对。" : "本次没有发现达到提示条件的片段，仍可复听核对。")
    : entries.length ? "点击“检查模糊片段”，补查这条历史记录。" : "上传音频后，可疑片段会单独列在这里";
  $("#review-error").textContent = result.reviewError || "";
  $("#review-error").hidden = !result.reviewError;
  $("#review-list").innerHTML = flagged.map((entry) => {
    const line = entries.indexOf(entry), name = speakerName(result, entry.speakerId);
    return `<li class="transcript-entry needs-review"><div class="transcript-entry-text"><span class="transcript-time">${entry.timed ? `[${formatMediaTime(entry.start)}–${formatMediaTime(entry.end)}]` : "时间未记录"}<span class="review-badge">待核对</span></span><p>${name ? `<strong class="speaker-colon">${escapeHtml(name)}：</strong>` : ""}${transcriptSentence(result, entry)}</p>${webSearchChips(findWebSearchTerms(entry.text, result.importantInfo))}<small class="review-reasons">${escapeHtml(reviewReasons(entry))}</small></div>${segmentPlayButton(result, entry, line)}</li>`;
  }).join("");
  updateReviewButton();
}
function updateSpeakerControls(busy = Boolean(activeRun || batchQueue?.processing || batchQueue?.uploading || fragmentSummaryPanel?.pending || transcriptEditor?.saving || waveformEditor?.saving)) {
  const available = Boolean(currentResult?.taskId && transcriptEntries(currentResult).some((entry) => entry.timed));
  const processing = currentResult?.status && !terminalStatuses.has(currentResult.status);
  const disabled = Boolean(busy || processing || speakerSaving);
  $("#identify-speakers").disabled = disabled || !available;
  $("#speaker-stats-start").disabled = disabled || !available;
  $("#identify-speakers").textContent = currentResult?.status === "Diarizing" ? "正在区分说话人…" : currentResult?.speakers?.length ? "重新区分说话人" : "区分说话人";
  document.querySelectorAll("#speaker-name-fields input, #speaker-name-fields select, #save-speaker-labels, .speaker-choice").forEach((element) => { element.disabled = disabled; });
  fragmentSummaryPanel?.refreshControls();
  transcriptEditor?.refreshControls();
  waveformEditor?.refreshControls();
  updateReviewButton(disabled);
}
function renderSpeakerControls(result) {
  const speakers = Array.isArray(result.speakers) ? result.speakers : [];
  const fields = $("#speaker-name-fields");
  const wasEmpty = !fields.children.length;
  $("#speaker-settings").hidden = !speakers.length;
  $("#speaker-settings-title").textContent = `说话人称呼（${speakers.length} 组，点击修改）`;
  $("#speaker-hint").textContent = result.status === "Diarizing" ? "正在从原声分组，请稍候。" : speakers.length
    ? "同一组共用一个称呼；可设为男生A、女生A或自定义名称。每条前方的下拉框可调整归属。"
    : "区分后可在文字前显示说话人名称，并改成男生A、女生A等称呼。";
  fields.innerHTML = speakers.map((speaker) => `<div class="speaker-name-row"><span class="speaker-code">${escapeHtml(speaker.code)}</span><input class="speaker-name-input" data-speaker-id="${escapeHtml(speaker.id)}" aria-label="说话人 ${escapeHtml(speaker.code)} 名称" maxlength="32" value="${escapeHtml(speaker.label)}" placeholder="男生A / 女生A / 自定义"><select class="speaker-preset" aria-label="说话人 ${escapeHtml(speaker.code)} 快捷称呼"><option value="">快捷选择</option><option value="男生${escapeHtml(speaker.code)}">男生${escapeHtml(speaker.code)}</option><option value="女生${escapeHtml(speaker.code)}">女生${escapeHtml(speaker.code)}</option><option value="说话人 ${escapeHtml(speaker.code)}">说话人 ${escapeHtml(speaker.code)}</option></select></div>`).join("");
  if (wasEmpty && speakers.length) $("#speaker-settings").open = true;
}
function speakerPrefix(result, entry, line) {
  const speakers = Array.isArray(result.speakers) ? result.speakers : [];
  if (!speakers.length) return "";
  const options = '<option value="">未确定说话人</option>' + speakers.map((speaker) => `<option value="${escapeHtml(speaker.id)}" ${speaker.id === entry.speakerId ? "selected" : ""}>${escapeHtml(speaker.label)}</option>`).join("");
  return `<select class="speaker-choice" aria-label="第 ${line + 1} 条说话人" data-segment-index="${entry.index}">${options}</select><span class="speaker-colon">：</span>`;
}
function renderTranscript(result) {
  const entries = transcriptEntries(result);
  renderSpeakerControls(result);
  $("#transcript-empty").hidden = entries.length > 0;
  $("#transcript").hidden = !entries.length;
  $("#copy-button").hidden = !entries.length;
  $("#transcript-caption").hidden = !entries.length;
  $("#transcript-caption").textContent = entries.every((entry) => entry.timed)
    ? `共 ${entries.length} 条 · 点击句子定位播放原音频或视频`
    : "此记录有未保存分句时间的文字，已保留原文。";
  $("#transcript").innerHTML = entries.map((entry, line) => `<li class="transcript-entry${entry.review?.needsReview ? " needs-review" : ""}"><div class="transcript-entry-text"><span class="transcript-time">${entry.timed
    ? `[${formatMediaTime(entry.start)}–${formatMediaTime(entry.end)}]` : "时间未记录"}${entry.review?.needsReview ? '<span class="review-badge">待核对</span>' : ""}</span><p>${speakerPrefix(result, entry, line)}${transcriptSentence(result, entry)}</p>${webSearchChips(findWebSearchTerms(entry.text, result.importantInfo))}${entry.review?.needsReview ? `<small class="review-reasons">${escapeHtml(reviewReasons(entry))}</small>` : ""}${entry.speakerMixed ? '<small class="speaker-mixed">此条可能包含多位说话人，可听原声后调整。</small>' : ""}</div>${segmentPlayButton(result, entry, line)}</li>`).join("");
  renderReview(result);
  updatePlaybackButtons();
  updateSpeakerControls();
  fragmentSummaryPanel?.render(result);
  speakerOrganizer?.render(result, entries);
  transcriptEditor?.render(result);
  waveformEditor?.render(result);
  fragmentSummaryPanel?.refreshControls();
}
function formatSpeakingSeconds(seconds) {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${((seconds % 60).toFixed(1))} 秒` : `${seconds.toFixed(1)} 秒`;
}
function speakerPieSvg(rows) {
  const slices = rows.map((row, index) => ({ ...row, color: speakerStatsColors[index % speakerStatsColors.length] })).filter((row) => row.seconds > 0);
  const total = slices.reduce((sum, row) => sum + row.seconds, 0);
  if (!total) return "";
  const width = 380, height = 300, cx = 190, cy = 150, radius = 102;
  const point = (angle, distance) => ({ x: cx + Math.cos(angle) * distance, y: cy + Math.sin(angle) * distance });
  const fixed = (value) => value.toFixed(2);
  let angle = -Math.PI / 2;
  const paths = [], inside = [], outside = [];
  for (const row of slices) {
    const fraction = row.seconds / total;
    const sweep = fraction * Math.PI * 2;
    const endAngle = angle + sweep;
    const middle = angle + sweep / 2;
    const label = `${row.percentage.toFixed(1)}%`;
    if (fraction > 0.99999) {
      paths.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${row.color}"><title>${escapeHtml(row.label)}：${label}</title></circle>`);
    } else {
      const first = point(angle, radius), last = point(endAngle, radius);
      paths.push(`<path d="M ${cx} ${cy} L ${fixed(first.x)} ${fixed(first.y)} A ${radius} ${radius} 0 ${fraction > 0.5 ? 1 : 0} 1 ${fixed(last.x)} ${fixed(last.y)} Z" fill="${row.color}" stroke="#fff" stroke-width="2"><title>${escapeHtml(row.label)}：${label}</title></path>`);
    }
    if (fraction >= 0.08) {
      const labelPoint = point(middle, radius * 0.63);
      inside.push(`<text x="${fixed(labelPoint.x)}" y="${fixed(labelPoint.y)}" text-anchor="middle" dominant-baseline="middle" class="speaker-pie-inside">${label}</text>`);
    } else {
      outside.push({ middle, label, side: Math.cos(middle) >= 0 ? "right" : "left", targetY: point(middle, radius + 25).y });
    }
    angle = endAngle;
  }
  const outer = [];
  for (const side of ["left", "right"]) {
    const labels = outside.filter((item) => item.side === side).sort((a, b) => a.targetY - b.targetY);
    let previous = 0;
    for (const item of labels) {
      item.y = Math.max(17, Math.min(height - 17, item.targetY), previous + 19);
      previous = item.y;
    }
    for (let index = labels.length - 1; index >= 0; index -= 1) {
      labels[index].y = Math.min(labels[index].y, (index === labels.length - 1 ? height - 17 : labels[index + 1].y - 19));
    }
    for (const item of labels) {
      const first = point(item.middle, radius + 2), bend = point(item.middle, radius + 13);
      const lineEnd = side === "right" ? 328 : 52;
      const labelX = side === "right" ? 332 : 48;
      outer.push(`<path d="M ${fixed(first.x)} ${fixed(first.y)} L ${fixed(bend.x)} ${fixed(bend.y)} L ${lineEnd} ${fixed(item.y)}" class="speaker-pie-leader"/><text x="${labelX}" y="${fixed(item.y)}" text-anchor="${side === "right" ? "start" : "end"}" dominant-baseline="middle" class="speaker-pie-outside">${item.label}</text>`);
    }
  }
  const description = slices.map((row) => `${row.label} ${row.percentage.toFixed(1)}%`).join("，");
  return `<svg class="speaker-pie" viewBox="0 0 ${width} ${height}" role="img" aria-label="发言占比饼状图：${escapeHtml(description)}">${paths.join("")}${inside.join("")}${outer.join("")}</svg>`;
}
function renderSpeakerStats(result) {
  const stats = calculateSpeakerStats(result);
  const hasSpeakers = Array.isArray(result.speakers) && result.speakers.length > 0;
  const hasData = hasSpeakers && stats.rows.some((row) => row.seconds > 0 || row.sentences > 0);
  $("#speaker-stats-empty").hidden = hasData;
  $("#speaker-stats-content").hidden = !hasData;
  $("#speaker-stats-start").hidden = hasSpeakers;
  $("#speaker-stats-empty-title").textContent = result.status === "Diarizing" ? "正在区分说话人，请稍候…"
    : hasSpeakers ? "这条记录没有可统计的分句时间" : "区分说话人后，这里会显示发言统计";
  $("#speaker-stats-empty-hint").textContent = hasSpeakers ? "可以打开完整转写，检查原声和分句时间。" : "可在“完整转写”中区分说话人，也可点击下方按钮。";
  if (!hasData) return;
  $("#speaker-stats-total").textContent = formatSpeakingSeconds(stats.totalSeconds);
  $("#speaker-stats-count").textContent = `${result.speakers.length} 组`;
  $("#speaker-stats-list").innerHTML = stats.rows.map((row, index) => {
    const color = speakerStatsColors[index % speakerStatsColors.length];
    return `<div class="speaker-stat-row" role="listitem" style="--speaker-color:${color}"><div class="speaker-stat-top"><strong>${escapeHtml(row.label)}</strong><span>${formatSpeakingSeconds(row.seconds)} · ${row.percentage.toFixed(1)}%</span></div><div class="speaker-stat-track" role="img" aria-label="${escapeHtml(row.label)}发言占比 ${row.percentage.toFixed(1)}%"><span style="width:${row.percentage}%"></span></div><small>${row.sentences} 句转写 · ${row.characters} 个字符</small></div>`;
  }).join("");
  const pie = speakerPieSvg(stats.rows);
  $("#speaker-stats-pie-section").hidden = !pie;
  $("#speaker-stats-pie").innerHTML = pie;
  $("#speaker-stats-note").textContent = `${result.timelineManuallyEdited ? "此记录已人工调整分句，时长按当前分句时间估算。" : stats.hasModelTurns ? "发言时长依据说话人模型识别的语音时间段；手动调整句子归属后，该句按分句时间重算。" : "此记录没有单独保存说话人语音时间段，时长按转写分句时间估算。"}占比以各组发言时长之和为基数；多人同时说话可能分别计时。字符数不含空格和标点。分组错误会影响统计，可听原声核对。`;
}
function setBusy(busy) {
  busy = busy || Boolean(fragmentSummaryPanel?.pending || transcriptEditor?.saving || waveformEditor?.saving);
  const modelBusy = busy || Boolean(batchQueue?.processing || batchQueue?.uploading);
  const recording = mediaRecorder?.state === "recording";
  $("#submit-button").disabled = recordStarting || !batchQueue?.pendingCount || batchQueue?.uploading || recording;
  $("#record-button").disabled = recordStarting || (modelBusy && !recording);
  $("#live-enabled").disabled = recordStarting || recording;
  $("#record-source").disabled = modelBusy || recordStarting || recording;
  $("#audio-file").disabled = recordStarting || recording;
  $("#submit-button").textContent = batchQueue?.uploading ? "正在上传文件…" : `${batchQueue?.processing ? "添加到识别队列" : "上传并识别"}${batchQueue?.pendingCount ? `（${batchQueue.pendingCount} 个）` : ""} ↗`;
  updateSummaryButton(modelBusy);
  updateSpeakerControls(modelBusy);
  updateReviewButton(modelBusy);
  fragmentSummaryPanel?.refreshControls();
  transcriptEditor?.refreshControls();
  waveformEditor?.refreshControls();
}
function updateSummaryButton(busy = Boolean(activeRun || batchQueue?.processing || batchQueue?.uploading || fragmentSummaryPanel?.pending || transcriptEditor?.saving || waveformEditor?.saving)) {
  const available = Boolean(currentResult?.taskId && typeof currentResult.transcript === "string" && currentResult.transcript.trim());
  const processing = Boolean(currentResult?.status && !terminalStatuses.has(currentResult.status));
  $("#retry-summary").disabled = busy || processing || !available;
  $("#retry-summary").textContent = currentResult?.status === "Summarizing" ? "正在提取重点…" : "重新提取重点";
  $("#summary-retry-hint").textContent = currentResult?.status === "Summarizing" ? "正在整理已保存的文字，请稍候。" : available ? "直接使用已有文字，无需重新上传或转写音频。" : "已有转写文字后，可以单独提取重点。";
}
function setSelectedFile(file) {
  if (file) batchQueue.stageFiles([file]);
}

async function fetchJson(url, options = {}, signal, timeoutMs = 30000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = data?.detail || data?.error;
      throw new Error(typeof detail === "string" ? detail : `请求失败（HTTP ${response.status}）`);
    }
    if (data == null) throw new Error("服务返回了无法读取的数据");
    return data;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error("连接超时，请检查本机服务是否仍在运行");
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function checkHealth() {
  $("#refresh-health").disabled = true;
  try {
    const data = await fetchJson("/api/health", {}, undefined, 12000);
    const local = data.mode === "local";
    const ollama = data.ollama || {};
    const ready = local && data.localWhisperInstalled === true && data.pitchInstalled === true && ollama.reachable === true && ollama.modelAvailable === true;
    $("#health-dot").className = ready ? "ok" : "bad";
    $("#health-text").textContent = ready ? "本地 AI · 环境就绪" : data.mockMode || data.mode === "mock" ? "演示模式 · 非真实识别" : local ? "本地 AI · 需要准备环境" : "服务已连接 · API 模式";
    $("#readiness-summary").textContent = ready ? "本地模型环境就绪 · 点击查看" : local ? "本地环境尚未就绪 · 点击查看缺少的组件" : "查看当前识别模式和运行环境";
    if (Number.isFinite(data.maxRecordingSeconds) && data.maxRecordingSeconds > 0) maxRecordingSeconds = data.maxRecordingSeconds;
    const details = local ? [
      `语音转写：${data.localWhisperInstalled === true ? "faster-whisper 已安装" : "尚未安装 faster-whisper"}；模型 ${data.localWhisperModel || "未指定"}（首次使用需要下载模型）。`,
      `重点提取：${ollama.reachable === true ? "Ollama 服务已连接" : "Ollama 服务未连接"}；模型 ${ollama.model || "未指定"}${ollama.modelAvailable === true ? " 已下载" : " 尚未就绪"}。`,
      `音高分析：${data.pitchInstalled === true ? "librosa 已安装" : "尚未安装 librosa 音频分析依赖"}。`,
    ] : [`当前模式：${data.mode || "未知"}。${data.mockMode || data.mode === "mock" ? "结果为演示数据。" : "具体模型连接状态以处理结果为准。"}`];
    if (ollama.error) details.push(String(ollama.error));
    $("#readiness-content").textContent = details.join("\n");
  } catch (error) {
    $("#health-dot").className = "bad";
    $("#health-text").textContent = "服务未连接";
    $("#readiness-summary").textContent = "本机服务未连接 · 请使用项目中的 start.cmd 启动";
    $("#readiness-content").textContent = error.message || "无法读取运行环境";
  } finally { $("#refresh-health").disabled = false; }
}

function updateTimer() {
  durationSeconds = Math.floor((Date.now() - recordStartedAt) / 1000);
  $("#record-timer").textContent = formatTime(durationSeconds);
  if (durationSeconds >= maxRecordingSeconds && mediaRecorder?.state === "recording") {
    mediaRecorder.stop(); toast(`已达到 ${maxRecordingSeconds} 秒，录音已自动停止`);
  }
}
function releaseMicrophone() {
  stopMicMonitor();
  recordInputSession?.close();
  recordInputSession = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  window.clearInterval(timerHandle);
  $("#record-icon").classList.remove("recording");
}
function updateRecordingSourceHint() {
  const mode = $("#record-source").value;
  $("#record-source-hint").textContent = mode === "microphone"
    ? "只录制麦克风。使用耳机可减少电脑声音被麦克风重复收录。"
    : !navigator.mediaDevices?.getDisplayMedia
      ? "此浏览器未提供电脑声音录制，请用 Chrome 或 Edge 打开本机网址。"
      : "开始后选择整个屏幕或浏览器标签页，并勾选共享音频。只保存声音，不保存屏幕画面。";
}
async function startMicMonitor(stream) {
  stopMicMonitor();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("此浏览器不支持音量监测");
  const context = new AudioContextClass();
  try {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const monitor = { context, source, analyser, samples: new Float32Array(analyser.fftSize), frame: 0, level: 0, lastSoundAt: performance.now() - 1000 };
    micMonitor = monitor;
    $("#mic-monitor").hidden = false;
    $("#mic-monitor").classList.remove("has-sound");
    $("#mic-track").className = "mic-track is-silent";
    $("#mic-level-label").textContent = "等待声音";
    $("#mic-level-bar").style.height = "0%";
    await context.resume();
    const draw = () => {
      if (micMonitor !== monitor) return;
      analyser.getFloatTimeDomainData(monitor.samples);
      let sum = 0, peak = 0;
      for (const sample of monitor.samples) { sum += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
      const rms = Math.sqrt(sum / monitor.samples.length);
      const now = performance.now();
      if (rms >= 0.004 || peak >= 0.03) monitor.lastSoundAt = now;
      const hasSound = now - monitor.lastSoundAt < 700;
      const loud = hasSound && (peak >= 0.9 || rms >= 0.27);
      const quiet = hasSound && !loud && rms < 0.025;
      const target = Math.max(loud ? 90 : 0, Math.min(100, (20 * Math.log10(Math.max(rms, 0.001)) + 60) / 54 * 100));
      monitor.level = monitor.level * 0.7 + target * 0.3;
      $("#mic-level-bar").style.height = `${Math.max(3, monitor.level).toFixed(1)}%`;
      $("#mic-track").className = `mic-track ${!hasSound ? "is-silent" : loud ? "is-loud" : quiet ? "is-quiet" : "is-good"}`;
      $("#mic-track").setAttribute("aria-valuenow", String(Math.round(monitor.level)));
      $("#mic-level-label").textContent = !hasSound ? "等待声音" : loud ? "声音过高" : quiet ? "声音偏小" : "音量合适";
      $("#mic-monitor").classList.toggle("has-sound", hasSound);
      $("#mic-silence").setAttribute("aria-hidden", String(hasSound));
      monitor.frame = requestAnimationFrame(draw);
    };
    monitor.frame = requestAnimationFrame(draw);
  } catch (error) { stopMicMonitor(); if (context.state !== "closed") context.close().catch(() => {}); throw error; }
}
function stopMicMonitor() {
  const monitor = micMonitor;
  micMonitor = null;
  if (monitor) {
    cancelAnimationFrame(monitor.frame);
    monitor.source.disconnect();
    monitor.context.close().catch(() => {});
  }
  $("#mic-monitor").hidden = true;
}
function renderLivePreview(data) {
  const states = { listening: "正在收音", recognizing: "正在识别", finishing: "正在补齐最后文字", complete: "预览已完成", waiting: "等待本机处理资源", error: "实时预览暂时中断" };
  $("#live-status").textContent = `${states[data.state] || "正在收音"} · 已处理 ${formatTime(data.processedSeconds)}`;
  $("#live-error").hidden = !data.error;
  $("#live-error").textContent = data.error || "";
  $("#copy-live").disabled = !data.lines.length;
  const list = $("#live-lines");
  if (data.lines.length) {
    list.querySelector(".live-empty")?.remove();
    while (list.children.length < data.lines.length) {
      const row = data.lines[list.children.length], li = document.createElement("li");
      const time = document.createElement("time"); time.textContent = `[${formatMediaTime(row.start)}–${formatMediaTime(row.end)}]`;
      li.append(time, document.createTextNode(row.text)); list.append(li);
      list.scrollTop = list.scrollHeight;
    }
  } else if (data.state === "complete") list.innerHTML = '<li class="live-empty">这次预览未检测到清晰语音，可以上传完整录音再识别。</li>';
}
async function toggleRecording() {
  if (recordStarting) return;
  if (mediaRecorder?.state === "recording") { updateTimer(); if (mediaRecorder.state === "recording") mediaRecorder.stop(); return; }
  if (activeRun || batchQueue?.processing || batchQueue?.uploading || fragmentSummaryPanel?.pending || transcriptEditor?.saving || waveformEditor?.saving) { toast("请等待当前任务完成后再录音"); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("当前浏览器不支持录音，请选择音频文件"); return; }
  recordStarting = true; setBusy(false);
  try {
    stopSegmentPlayback();
    liveSession?.cancel(); liveSession = null;
    $("#live-preview").hidden = !$("#live-enabled").checked;
    $("#live-lines").innerHTML = '<li class="live-empty">开始说话后，识别文字会显示在这里。</li>';
    $("#copy-live").disabled = true;
    $("#live-error").hidden = true;
    const mode = $("#record-source").value;
    recordInputSession = new RecordingAudioInput({ onEnded: () => {
      if (mediaRecorder?.state === "recording") {
        updateTimer();
        if (mediaRecorder.state === "recording") mediaRecorder.stop();
        toast("声音来源已停止，正在保存已录到的声音");
      }
    } });
    mediaStream = await recordInputSession.start(mode);
    try { await startMicMonitor(mediaStream); }
    catch (error) { toast(`${error.message}，录音仍可继续`); }
    const chunks = [];
    const supportedType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(mediaStream, supportedType ? { mimeType: supportedType } : undefined);
    mediaRecorder = recorder;
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const session = $("#live-enabled").checked ? new LocalLiveTranscription({ maxSeconds: maxRecordingSeconds,
      onUpdate: (data) => { if (liveSession === session) renderLivePreview(data); } }) : null;
    liveSession = session;
    if (session) {
      $("#live-status").textContent = "正在准备实时采音…";
      try { await session.start(mediaStream); }
      catch (error) { session.cancel(); $("#live-error").hidden = false; $("#live-error").textContent = `${error.message}，录音仍可继续。`; $("#live-status").textContent = "实时预览不可用"; }
    }
    recorder.onstop = async () => {
      recordStarting = true; setBusy(Boolean(activeRun));
      stopMicMonitor();
      const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
      const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
      const blob = new Blob(chunks, { type });
      await session?.stop().catch(() => {});
      releaseMicrophone();
      if (blob.size) setSelectedFile(new File([blob], `${mode}_recording_${Date.now()}.${extension}`, { type }));
      else toast("没有录到声音，请重新录音");
      $("#record-button").textContent = "重新录音";
      $("#record-title").textContent = blob.size ? "录音已准备好" : "录音为空";
      $("#record-hint").textContent = "可以上传识别，或重新录一段。";
      recordStarting = false;
      setBusy(Boolean(activeRun));
    };
    recorder.onerror = () => { session?.cancel(); releaseMicrophone(); recordStarting = false; setBusy(Boolean(activeRun)); toast("录音失败，请重新录音或选择文件"); };
    durationSeconds = 0;
    $("#record-timer").textContent = "00:00";
    if (!recordInputSession || recordInputSession.closed || recordInputSession.ended || !mediaStream.getAudioTracks().some((track) => track.readyState === "live")) {
      throw new Error("声音来源已停止，请重新选择录音来源");
    }
    recorder.start();
    recordStartedAt = Date.now();
    timerHandle = window.setInterval(updateTimer, 250);
    $("#record-button").textContent = "停止录音";
    const modeLabel = { microphone: "麦克风", mixed: "电脑声音＋麦克风", system: "电脑声音" }[mode];
    $("#record-title").textContent = `正在录制${modeLabel}`;
    $("#record-hint").textContent = session ? (mode === "mixed" ? "两路声音共用实时转写；再次点击结束录音。" : "录音中，文字会分段显示；再次点击结束录音。") : "再次点击按钮结束录音。";
    $("#record-icon").classList.add("recording");
  } catch (error) { liveSession?.cancel(); releaseMicrophone(); toast(error.message || "无法录音，请检查声音来源和录音权限"); }
  finally { recordStarting = false; setBusy(Boolean(activeRun)); }
}

function highlightKeyword(text, query) {
  const value = String(text), needle = String(query).toLocaleLowerCase(), lower = value.toLocaleLowerCase();
  if (!needle) return escapeHtml(value);
  let cursor = 0, html = "", index;
  while ((index = lower.indexOf(needle, cursor)) >= 0) {
    html += escapeHtml(value.slice(cursor, index)) + `<mark class="search-highlight">${escapeHtml(value.slice(index, index + query.length))}</mark>`;
    cursor = index + query.length;
  }
  return html + escapeHtml(value.slice(cursor));
}
function queueKeywordSearch(activate = true) {
  keywordController?.abort(); window.clearTimeout(keywordTimer);
  keywordTimer = window.setTimeout(() => searchKeywords(activate), 250);
}
async function searchKeywords(activate = true) {
  keywordController?.abort();
  const query = $("#keyword-search").value.trim();
  keywordMatches = [];
  $("#search-results").innerHTML = ""; $("#search-results").hidden = true;
  if (!query) { $("#search-summary").textContent = "输入关键词，可搜索当前记录或全部历史转写。"; return; }
  if (activate) activateTab("search");
  const controller = new AbortController(); keywordController = controller;
  const currentOnly = $("#keyword-scope").value === "current" && currentResult?.taskId;
  const params = new URLSearchParams({ q: query });
  if (currentOnly) params.set("taskId", currentResult.taskId);
  $("#search-summary").textContent = "正在搜索转写文字…";
  try {
    const data = await fetchJson(`/api/recognition/search?${params}`, {}, controller.signal);
    if (controller.signal.aborted || keywordController !== controller) return;
    keywordMatches = data.matches || [];
    const scope = currentOnly ? "当前记录" : "全部历史";
    $("#search-summary").textContent = data.total ? `${scope}中找到 ${data.total} 条匹配语句${data.truncated ? "，显示前 100 条" : ""}。点击小喇叭复听。` : `${scope}中没有找到“${query}”，可以换个关键词。`;
    $("#search-results").hidden = !keywordMatches.length;
    $("#search-results").innerHTML = keywordMatches.map((match, index) => {
      const start = numberOrNull(match.start), end = numberOrNull(match.end);
      const timed = start != null && end != null && start >= 0 && end > start;
      return `<li class="transcript-entry"><div class="transcript-entry-text"><span class="search-file">${escapeHtml(match.fileName)}</span><span class="transcript-time">${timed ? `[${formatMediaTime(start)}–${formatMediaTime(end)}]` : "时间未记录"}</span><p>${match.speakerLabel ? `<strong class="speaker-colon">${escapeHtml(match.speakerLabel)}：</strong>` : ""}<button class="transcript-jump" data-search-jump="${index}" data-task-id="${escapeHtml(match.taskId)}" data-source-index="${match.segmentIndex ?? -1}" aria-pressed="false" type="button" title="点击文字定位播放原文件" ${timed && match.segmentIndex != null ? "" : "disabled"}>${highlightKeyword(match.text, data.query || query)}</button></p><button class="text-button search-open" type="button" data-search-open="${index}">打开这条记录</button></div><button class="segment-play" data-search-match="${index}" data-task-id="${escapeHtml(match.taskId)}" data-segment-index="${match.segmentIndex ?? -1}" data-line-number="${(match.segmentIndex ?? 0) + 1}" aria-label="播放搜索结果 ${index + 1} 的原声" aria-pressed="false" ${timed && match.segmentIndex != null ? "" : "disabled"}>${speakerIcon}</button></li>`;
    }).join("");
    updatePlaybackButtons();
  } catch (error) {
    if (!controller.signal.aborted && keywordController === controller) $("#search-summary").textContent = `搜索失败：${error.message}`;
  }
}
async function openSearchMatch(index, play = false) {
  const match = keywordMatches[index];
  if (!match) return;
  if (play && segmentPlayback?.taskId === match.taskId && segmentPlayback.index === match.segmentIndex) { stopSegmentPlayback(); return; }
  try {
    if (currentResult?.taskId !== match.taskId || !play) {
      const record = await fetchJson(`/api/recognition/status?taskId=${encodeURIComponent(match.taskId)}`);
      cancelCurrentPoll(); renderResult(record);
    }
    activateTab(play ? "search" : "transcript");
    if (play && match.segmentIndex != null) await playTranscriptSegment(match.segmentIndex);
  } catch (error) { toast(error.message || "无法打开搜索结果"); }
}
function cancelCurrentPoll() {
  stopSegmentPlayback();
  activeRun?.controller.abort();
  activeRun = null;
  setBusy(false);
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const abort = () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
async function pollTask(taskId, run) {
  const deadline = Date.now() + 30 * 60 * 1000;
  let failures = 0;
  while (Date.now() < deadline) {
    if (activeRun !== run) return;
    try {
      const result = await fetchJson(`/api/recognition/status?taskId=${encodeURIComponent(taskId)}`, {}, run.controller.signal);
      if (activeRun !== run) return;
      failures = 0;
      renderResult({ ...currentResult, ...result }, false);
      if (terminalStatuses.has(result.status)) {
        await loadHistory();
        toast(result.status === "Success" ? run.kind === "review" ? "模糊片段检查已完成，可在待核对页复听" : run.kind === "speakers" ? "说话人分组已保存，可设置显示名称" : run.kind === "summary" ? "重点信息已重新提取并保存" : "转写、说话人分组、重点提取和音高分析已完成" : result.status === "Partial" ? "部分处理完成，已有结果已保存" : "处理未完成，请查看提示");
        return;
      }
    } catch (error) {
      if (run.controller.signal.aborted) throw error;
      failures += 1;
      $("#result-message").textContent = `读取进度失败，正在重试（${failures}/5）…`;
      if (failures >= 5) throw new Error(`暂时无法读取进度：${error.message}。任务可能仍在本机运行，可稍后刷新历史记录查看。`);
    }
    await delay(failures ? Math.min(1000 * 2 ** failures, 10000) : 1600, run.controller.signal);
  }
  throw new Error("已等待 30 分钟。任务可能仍在处理，请稍后刷新历史记录查看；首次下载模型或长音频会耗时较久。");
}
async function submitAudio() {
  if (!batchQueue?.pendingCount || batchQueue.uploading || recordStarting || mediaRecorder?.state === "recording") return;
  liveSession?.cancel();
  if (!$("#live-preview").hidden) $("#live-status").textContent = "实时预览已结束，正在完整识别";
  setError("");
  await batchQueue.uploadSelected();
}

async function retrySummary() {
  if (activeRun || $("#retry-summary").disabled) return;
  const taskId = currentResult.taskId;
  const run = { controller: new AbortController(), kind: "summary" };
  activeRun = run;
  setError("");
  setBusy(true);
  activateTab("important");
  try {
    const task = await fetchJson(`/api/recognition/${encodeURIComponent(taskId)}/summary`, { method: "POST" }, run.controller.signal);
    if (activeRun !== run) return;
    renderResult({ ...currentResult, ...task }, false);
    await pollTask(taskId, run);
  } catch (error) {
    if (activeRun !== run || run.controller.signal.aborted) return;
    setError(error.message || "重新提取重点失败，请检查本地模型服务");
    // A lost response may still have queued the job; refresh its saved state.
    try {
      const saved = await fetchJson(`/api/recognition/status?taskId=${encodeURIComponent(taskId)}`, {}, run.controller.signal);
      if (activeRun === run) renderResult(saved, false);
    } catch (_) { /* Keep the already displayed transcript and charts. */ }
    await loadHistory();
  } finally { if (activeRun === run) { activeRun = null; setBusy(false); } }
}

async function identifySpeakers() {
  if (activeRun || $("#identify-speakers").disabled) return;
  const taskId = currentResult.taskId;
  cancelCurrentPoll();
  const run = { controller: new AbortController(), kind: "speakers" };
  activeRun = run;
  setBusy(true);
  setError("");
  activateTab("transcript");
  try {
    const task = await fetchJson(`/api/recognition/${encodeURIComponent(taskId)}/speakers`, { method: "POST" }, run.controller.signal);
    if (activeRun !== run) return;
    renderResult({ ...currentResult, ...task }, false);
    await pollTask(taskId, run);
  } catch (error) {
    if (activeRun === run && !run.controller.signal.aborted) { setError(error.message); await loadHistory(); }
  } finally { if (activeRun === run) { activeRun = null; setBusy(false); } }
}
async function checkTranscriptReview() {
  if (activeRun || $("#check-review").disabled) return;
  const taskId = currentResult.taskId;
  cancelCurrentPoll();
  const run = { controller: new AbortController(), kind: "review" };
  activeRun = run;
  setBusy(true);
  setError("");
  activateTab("review");
  try {
    const task = await fetchJson(`/api/recognition/${encodeURIComponent(taskId)}/review`, { method: "POST" }, run.controller.signal);
    if (activeRun !== run) return;
    renderResult({ ...currentResult, ...task }, false);
    await pollTask(taskId, run);
  } catch (error) {
    if (activeRun === run && !run.controller.signal.aborted) { setError(error.message); await loadHistory(); }
  } finally { if (activeRun === run) { activeRun = null; setBusy(false); } }
}
async function saveSpeakerLabels() {
  if (speakerSaving || !currentResult?.taskId || $("#save-speaker-labels").disabled) return;
  const taskId = currentResult.taskId;
  const labels = Object.fromEntries([...document.querySelectorAll(".speaker-name-input")].map((input) => [input.dataset.speakerId, input.value]));
  speakerSaving = true;
  updateSpeakerControls();
  try {
    const result = await fetchJson(`/api/recognition/${encodeURIComponent(taskId)}/speaker-labels`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ labels }) });
    if (currentResult?.taskId === taskId) renderResult(result, false);
    toast("说话人名称已保存，相关文字已统一更新");
    await loadHistory();
  } catch (error) { toast(error.message || "保存说话人名称失败"); }
  finally { speakerSaving = false; updateSpeakerControls(); }
}
async function changeSegmentSpeaker(index, speakerId) {
  if (speakerSaving || !currentResult?.taskId) return;
  const taskId = currentResult.taskId;
  speakerSaving = true;
  updateSpeakerControls();
  stopSegmentPlayback();
  try {
    const result = await fetchJson(`/api/recognition/${encodeURIComponent(taskId)}/segments/${index}/speaker`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speakerId: speakerId || null, expectedStructureRevision: currentResult.segmentStructureRevision || 0 }) });
    if (currentResult?.taskId === taskId) renderResult(result, false);
    toast("此条说话人归属已保存");
  } catch (error) { toast(error.message || "调整说话人失败"); if (currentResult?.taskId === taskId) renderResult(currentResult, false); }
  finally { speakerSaving = false; updateSpeakerControls(); }
}

function renderResult(result, reset = true) {
  if (currentResult?.taskId !== result.taskId) stopSegmentPlayback();
  if (reset) { lastPitchStats = null; setError(""); }
  currentResult = result;
  sourcePlayer.prepare(result.taskId || null, historyName(result));
  if (searchTaskId !== result.taskId) {
    searchTaskId = result.taskId;
    if ($("#keyword-search").value.trim()) queueKeywordSearch(false);
  }
  setState(result.status);
  $("#result-message").textContent = result.message || (result.status === "Partial" ? "已有结果已保存，部分步骤未完成。" : statusLabels[result.status] || "已载入历史记录");
  const notices = [result.error, ...(Array.isArray(result.warnings) ? result.warnings : result.warnings ? [result.warnings] : [])].filter(Boolean).map(String);
  if (result.importantInfoStale) notices.push("转写内容或分句已调整，当前重要信息仍是修改前的结果。请点击“重新提取重点”更新摘要与待办。");
  $("#result-notices").textContent = [...new Set(notices)].join("\n");
  $("#result-notices").hidden = !notices.length;
  const transcript = typeof result.transcript === "string" ? result.transcript : "";
  renderTranscript(result);
  renderSpeakerStats(result);
  const info = result.importantInfo && typeof result.importantInfo === "object" ? result.importantInfo : null;
  $("#important-empty").hidden = Boolean(info);
  $("#important-content").hidden = !info;
  $("#important-content").innerHTML = info ? importantHtml(info) : "";
  renderPitch(result.pitchStats || null);
  $("#export-text").disabled = !(transcript || info);
  updateSummaryButton();
}

function renderPitch(stats) {
  lastPitchStats = stats;
  const points = Array.isArray(stats?.points) ? stats.points : [];
  const hasPitch = points.length > 0;
  $("#pitch-empty").hidden = hasPitch;
  $("#pitch-content").hidden = !hasPitch;
  $("#pitch-empty-text").textContent = stats?.error ? `音高分析未完成：${stats.error}` : "音高结果将在分析完成后显示";
  $("#pitch-min").textContent = formatHz(stats?.minHz);
  $("#pitch-avg").textContent = formatHz(stats?.avgHz);
  $("#pitch-max").textContent = formatHz(stats?.maxHz);
  $("#pitch-median").textContent = formatHz(stats?.medianHz);
  $("#pitch-voiced").textContent = stats ? `${((numberOrNull(stats.voicedRatio) || 0) * 100).toFixed(1)}%` : "—";
  $("#pitch-duration").textContent = stats ? `${(numberOrNull(stats.durationSeconds) || 0).toFixed(1)} 秒` : "—";
  const voiced = points.some((point) => numberOrNull(point.hz) > 0);
  $("#pitch-method").textContent = `${stats?.method || "librosa.pyin"} · 人声基频估计范围 65–600 Hz；统计只计有效有声片段。空白表示停顿或无法判断音高。${hasPitch && !voiced ? "本段音频未检测到稳定的有声音高。" : ""}${stats?.error ? ` ${stats.error}` : ""}`;
  $("#export-csv").disabled = !hasPitch;
  $("#export-png").disabled = !hasPitch;
  if (hasPitch) drawPitchCharts();
}
function prepareCanvas(selector, exportMode = false) {
  const canvas = $(selector);
  const width = Math.max(320, canvas.clientWidth || (exportMode ? 720 : 640));
  const height = 230;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  context.fillStyle = "#fafbfe"; context.fillRect(0, 0, width, height);
  context.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
  return { canvas, context, width, height, left: 52, right: width - 16, top: 18, bottom: height - 38 };
}
function chartGrid(chart, maximum, minimum = 0, label = (value) => Math.round(value)) {
  const { context: ctx, left, right, top, bottom } = chart;
  ctx.lineWidth = 1;
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = top + (bottom - top) * tick / 4;
    ctx.strokeStyle = "#e6e8f1"; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = "#737d91"; ctx.textAlign = "right"; ctx.fillText(label(maximum - (maximum - minimum) * tick / 4), left - 7, y + 4);
  }
  ctx.textAlign = "left";
}
function drawPitchCharts(force = false) {
  if (!lastPitchStats?.points?.length || (!force && $("#pitch-panel").hidden)) return;
  const points = lastPitchStats.points;
  const values = points.map((point) => numberOrNull(point.hz)).filter((value) => value > 0);
  const chart = prepareCanvas("#pitch-chart", force);
  const { context: ctx, left, right, top, bottom, height } = chart;
  const times = points.map((point) => numberOrNull(point.time)).filter((value) => value != null);
  const duration = Math.max(numberOrNull(lastPitchStats.durationSeconds) || 0, times[times.length - 1] || 0, 0.1);
  let minimum = values.length ? Infinity : 0;
  let maximum = values.length ? 0 : 500;
  values.forEach((value) => { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); });
  const padding = Math.max(15, (maximum - minimum) * 0.1);
  minimum = Math.max(0, Math.floor((minimum - padding) / 10) * 10);
  maximum = Math.ceil((maximum + padding) / 10) * 10;
  chartGrid(chart, maximum, minimum, (value) => `${Math.round(value)}`);
  ctx.fillStyle = "#737d91"; ctx.fillText("Hz", 7, 12);
  for (let tick = 0; tick <= 4; tick += 1) {
    const x = left + (right - left) * tick / 4;
    ctx.textAlign = tick === 0 ? "left" : tick === 4 ? "right" : "center";
    ctx.fillText(`${(duration * tick / 4).toFixed(1)}s`, x, height - 14);
  }
  ctx.strokeStyle = "#6658e8"; ctx.fillStyle = "#6658e8"; ctx.lineWidth = 1.7; ctx.beginPath();
  let connected = false;
  points.forEach((point) => {
    const hz = numberOrNull(point.hz); const time = numberOrNull(point.time);
    if (!(hz > 0) || time == null) { connected = false; return; }
    const x = left + (right - left) * time / duration;
    const y = bottom - (bottom - top) * (hz - minimum) / Math.max(maximum - minimum, 1);
    if (connected) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    connected = true;
  });
  ctx.stroke();
  if (values.length === 1) {
    const point = points.find((item) => numberOrNull(item.hz) > 0);
    ctx.beginPath(); ctx.arc(left + (right - left) * point.time / duration, bottom - (bottom - top) * (point.hz - minimum) / (maximum - minimum), 2.5, 0, 2 * Math.PI); ctx.fill();
  }
  if (!values.length) { ctx.textAlign = "center"; ctx.fillStyle = "#737d91"; ctx.fillText("未检测到稳定的有声音高", (left + right) / 2, (top + bottom) / 2); }
  drawHistogram(force);
}
function drawHistogram(force = false) {
  const chart = prepareCanvas("#pitch-histogram", force);
  const { context: ctx, left, right, top, bottom, height } = chart;
  const bins = (Array.isArray(lastPitchStats?.histogram) ? lastPitchStats.histogram : []).filter((bin) => numberOrNull(bin.count) != null);
  const maxCount = Math.max(1, ...bins.map((bin) => Number(bin.count)));
  chartGrid(chart, maxCount);
  ctx.fillStyle = "#737d91"; ctx.fillText("帧数", 7, 12);
  if (!bins.length) { ctx.textAlign = "center"; ctx.fillText("暂无音高分布数据", (left + right) / 2, (top + bottom) / 2); return; }
  const barWidth = (right - left) / bins.length;
  bins.forEach((bin, index) => {
    const barHeight = (bottom - top) * Math.max(0, bin.count) / maxCount;
    ctx.fillStyle = "#8c81f0"; ctx.fillRect(left + index * barWidth + 2, bottom - barHeight, Math.max(1, barWidth - 4), barHeight);
    if (bins.length <= 10 || index % Math.ceil(bins.length / 8) === 0) {
      ctx.fillStyle = "#737d91"; ctx.textAlign = "center";
      ctx.fillText(`${Math.round(bin.lowerHz)}–${Math.round(bin.upperHz)}`, left + (index + 0.5) * barWidth, height - 16);
    }
  });
  ctx.textAlign = "right"; ctx.fillStyle = "#737d91"; ctx.fillText("Hz", right, height - 2);
}

function listHtml(items, info) { return Array.isArray(items) && items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}${webSearchChips(findWebSearchTerms(item, info))}</li>`).join("")}</ul>` : "<p>无</p>"; }
function importantHtml(info) {
  const actions = (Array.isArray(info.action_items) ? info.action_items : []).map((item) => {
    const task = item?.task || "", owner = item?.owner || "", deadline = item?.deadline || "";
    const terms = findWebSearchTerms(`${task} ${owner} ${deadline}`, info);
    if (owner && !/^未指定/.test(owner)) terms.push(owner);
    if (deadline && !/^未指定/.test(deadline)) terms.push(deadline);
    return `<li>${escapeHtml(task)} <small>${escapeHtml(owner || "未指定负责人")} · ${escapeHtml(deadline || "未指定期限")}</small>${webSearchChips(terms)}</li>`;
  }).join("");
  const keywordChips = webSearchChips(Array.isArray(info.keywords) ? info.keywords : []);
  return `<div class="important-grid"><div class="info-block wide"><h3>摘要</h3><p>${escapeHtml(info.summary || "无")}</p>${webSearchChips(findWebSearchTerms(info.summary, info))}</div><div class="info-block"><h3>关键词</h3>${keywordChips || "<p>无</p>"}</div><div class="info-block"><h3>事实</h3>${listHtml(info.facts, info)}</div><div class="info-block"><h3>决定</h3>${listHtml(info.decisions, info)}</div><div class="info-block"><h3>问题</h3>${listHtml(info.questions, info)}</div><div class="info-block wide"><h3>待办事项</h3>${actions ? `<ul>${actions}</ul>` : "<p>无</p>"}</div></div>`;
}
function activateTab(name) {
  stopSegmentPlayback();
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const active = panel.id === `${name}-panel`;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
    panel.classList.toggle("animate__animated", active);
    panel.classList.toggle("animate__fadeIn", active);
  });
  if (name === "pitch") window.requestAnimationFrame(() => drawPitchCharts());
}
async function showHistoryRecord(record) {
  cancelCurrentPoll();
  renderResult(record);
  activateTab(record.transcript ? "transcript" : record.pitchStats?.points?.length ? "pitch" : "transcript");
  if (["waiting", "processing"].includes(record.queueState)) { batchQueue?.refresh(); return; }
  if (record.taskId && record.status && !terminalStatuses.has(record.status)) {
    const run = { controller: new AbortController() };
    activeRun = run;
    setBusy(true);
    try { await pollTask(record.taskId, run); }
    catch (error) { if (activeRun === run && !run.controller.signal.aborted) setError(error.message); }
    finally { if (activeRun === run) { activeRun = null; setBusy(false); } }
  }
}
function historyName(record) { return record.displayName || record.fileName || "未命名音频"; }
function renderHistory() {
  const query = $("#history-search").value.trim().toLocaleLowerCase();
  const onlyFavorite = $("#history-filter").value === "favorite";
  const order = $("#history-sort").value;
  const sameNames = new Map();
  historyRecords.forEach((record) => {
    const key = String(record.fileName || "").trim().toLocaleLowerCase();
    if (key) sameNames.set(key, (sameNames.get(key) || 0) + 1);
  });
  const visible = historyRecords.filter((record) => (!onlyFavorite || record.favorite)
    && (!query || [historyName(record), record.fileName, record.transcript, ...(record.tags || [])]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query))));
  visible.sort((a, b) => order === "name" ? historyName(a).localeCompare(historyName(b), "zh-CN")
    : order === "oldest" ? String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
      : String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  $("#history-count").textContent = `显示 ${visible.length} / ${historyRecords.length} 条记录`;
  $("#history-list").innerHTML = visible.length ? visible.map((record) => {
    const id = escapeHtml(record.taskId);
    const editing = historyEditId === record.taskId;
    const saving = historySavingId === record.taskId;
    const locked = !terminalStatuses.has(record.status) || saving;
    const sameCount = sameNames.get(String(record.fileName || "").trim().toLocaleLowerCase()) || 0;
    const tags = Array.isArray(record.tags) ? record.tags : [];
    return `<article class="history-item" data-task-id="${id}">
      <button class="history-open" type="button" data-action="open"><strong>${escapeHtml(historyName(record))}</strong><p>${escapeHtml(record.transcript || record.message || "暂无转写")}</p><span class="history-meta">${escapeHtml(record.createdAt || "")} · ${escapeHtml(statusLabels[record.status] || record.status || "未知状态")} · ${escapeHtml(record.duration || 0)} 秒</span></button>
      <div class="history-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}${sameCount > 1 ? `<span class="same-name">同名 ${sameCount} 条</span>` : ""}</div>
      <div class="history-actions"><button type="button" data-action="favorite" aria-label="${record.favorite ? "取消收藏" : "收藏"}${escapeHtml(historyName(record))}" aria-pressed="${Boolean(record.favorite)}" ${locked ? "disabled" : ""}>${record.favorite ? "★ 已收藏" : "☆ 收藏"}</button><button type="button" data-action="edit" ${locked ? "disabled" : ""}>${editing ? "取消编辑" : "整理"}</button></div>
      ${editing ? `<form class="history-edit"><label>记录名称<input name="displayName" maxlength="80" required value="${escapeHtml(historyName(record))}" /></label><label>标签（用逗号分隔，最多 8 个）<input name="tags" value="${escapeHtml(tags.join("，"))}" placeholder="例如：课程、会议" /></label><button class="summary-button" type="submit" ${saving ? "disabled" : ""}>${saving ? "保存中…" : "保存"}</button></form>` : ""}
    </article>`;
  }).join("") : `<div class="history-empty">${historyRecords.length ? "没有符合条件的记录" : "还没有识别记录"}</div>`;
}
async function saveHistoryMeta(record, changes) {
  if (historySavingId) return;
  historySavingId = record.taskId;
  const submit = $("#history-list .history-item[data-task-id='${record.taskId}'] .history-edit button[type=submit]");
  if (submit) { submit.disabled = true; submit.textContent = "保存中…"; }
  let saved = false;
  try {
    const updated = await fetchJson(`/api/recognition/${record.taskId}/history`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        displayName: changes.displayName ?? historyName(record), favorite: changes.favorite ?? Boolean(record.favorite),
        tags: changes.tags ?? (record.tags || []),
      }),
    });
    historyRecords = historyRecords.map((item) => item.taskId === updated.taskId ? updated : item);
    if (currentResult?.taskId === updated.taskId) currentResult = { ...currentResult, displayName: updated.displayName, favorite: updated.favorite, tags: updated.tags };
    historyEditId = null;
    toast("历史记录已保存");
    saved = true;
  } catch (error) { toast(`保存失败：${error.message}`); }
  finally {
    historySavingId = null;
    if (saved) renderHistory();
    else if (submit) { submit.disabled = false; submit.textContent = "保存"; }
  }
}
async function loadHistory() {
  try {
    const records = await fetchJson("/api/recognition/history");
    if (!Array.isArray(records)) throw new Error("历史记录格式不正确");
    historyRecords = records;
    renderHistory();
  } catch (error) { $("#history-list").innerHTML = '<div class="history-empty">历史记录暂时无法加载，请检查服务后点击刷新</div>'; $("#history-count").textContent = ""; }
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function exportName(extension) { return `${historyName(currentResult || {}).replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*]/g, "_")}.${extension}`; }
function exportText() {
  if (!currentResult) return;
  const info = currentResult.importantInfo || {};
  const lines = [historyName(currentResult), `状态：${statusLabels[currentResult.status] || currentResult.status || ""}`, "", "【完整转写】", transcriptText(currentResult) || "暂无", "", "【摘要】", info.summary || "暂无"];
  lines.push("", "【待核对片段】");
  const reviewEntries = transcriptEntries(currentResult).filter((entry) => entry.review?.needsReview);
  if (!currentResult.reviewInfo) lines.push("尚未检查，不能据此判断转写是否可靠。");
  else {
    lines.push("待核对不代表一定有错；未标记也不保证正确。");
    if (currentResult.reviewInfo.checkedCount < currentResult.reviewInfo.totalCount) lines.push("部分片段缺少可靠识别分数，暂无法判断。");
    lines.push(...(reviewEntries.length ? reviewEntries.map((entry) => `[${formatMediaTime(entry.start)}–${formatMediaTime(entry.end)}] ${speakerName(currentResult, entry.speakerId)}：${entry.text}\n原因：${reviewReasons(entry)}`) : ["本次没有发现达到提示条件的片段。"]));
  }
  [["关键词", info.keywords], ["事实", info.facts], ["决定", info.decisions], ["问题", info.questions]].forEach(([title, values]) => lines.push("", `【${title}】`, ...(Array.isArray(values) && values.length ? values.map((item) => `- ${item}`) : ["无"])));
  lines.push("", "【待办事项】", ...(Array.isArray(info.action_items) && info.action_items.length ? info.action_items.map((item) => `- ${item.task || ""}；负责人：${item.owner || "未指定"}；期限：${item.deadline || "未指定"}`) : ["无"]));
  if (lastPitchStats) lines.push("", "【音高统计】", `最低：${formatHz(lastPitchStats.minHz)}；平均：${formatHz(lastPitchStats.avgHz)}；最高：${formatHz(lastPitchStats.maxHz)}；中位数：${formatHz(lastPitchStats.medianHz)}`);
  if ($("#result-notices").textContent) lines.push("", "【处理提示】", $("#result-notices").textContent);
  downloadBlob(new Blob(["\ufeff", lines.join("\r\n")], { type: "text/plain;charset=utf-8" }), exportName("txt"));
}
function exportCsv() {
  if (!lastPitchStats?.points?.length) return;
  const rows = ["time_seconds,pitch_hz", ...lastPitchStats.points.map((point) => `${numberOrNull(point.time) ?? ""},${numberOrNull(point.hz) ?? ""}`)];
  downloadBlob(new Blob(["\ufeff", rows.join("\r\n")], { type: "text/csv;charset=utf-8" }), exportName("csv"));
}
function exportSpeakerStats() {
  if (!currentResult?.speakers?.length) return;
  const stats = calculateSpeakerStats(currentResult);
  const cell = (value) => {
    const text = String(value);
    const safe = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = ["说话人,发言时长(秒),发言占比(%),转写句数,字符数", ...stats.rows.map((row) => [cell(row.label), row.seconds, row.percentage, row.sentences, row.characters].join(","))];
  const name = exportName("csv").replace(/\.csv$/i, "-发言统计.csv");
  downloadBlob(new Blob(["\ufeff", rows.join("\r\n")], { type: "text/csv;charset=utf-8" }), name);
}
function exportPng() {
  if (!lastPitchStats?.points?.length) return;
  drawPitchCharts(true);
  const timeline = $("#pitch-chart"); const histogram = $("#pitch-histogram");
  const output = document.createElement("canvas");
  output.width = Math.max(timeline.width, histogram.width); output.height = timeline.height + histogram.height + 100;
  const ctx = output.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, output.width, output.height);
  ctx.fillStyle = "#18233f"; ctx.font = '20px "Microsoft YaHei", sans-serif';
  ctx.fillText("音高随时间变化 / Hz", 18, 29); ctx.drawImage(timeline, 0, 45);
  ctx.fillText("音高分布 / Hz", 18, timeline.height + 77); ctx.drawImage(histogram, 0, timeline.height + 95);
  output.toBlob((blob) => { if (blob) downloadBlob(blob, exportName("png")); else toast("图片导出失败"); }, "image/png");
}

$("#record-button").addEventListener("click", toggleRecording);
$("#record-source").addEventListener("change", updateRecordingSourceHint);
$("#copy-live").addEventListener("click", async () => {
  const text = liveSession?.lines.map((row) => `[${formatMediaTime(row.start)}–${formatMediaTime(row.end)}] ${row.text}`).join("\n");
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast("已复制实时预览文字"); } catch (_) { toast("复制失败，请选中文字复制"); }
});
$("#keyword-search").addEventListener("input", () => queueKeywordSearch());
$("#keyword-scope").addEventListener("change", () => queueKeywordSearch());
$("#keyword-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { window.clearTimeout(keywordTimer); searchKeywords(); } });
$("#clear-search").addEventListener("click", () => { $("#keyword-search").value = ""; window.clearTimeout(keywordTimer); searchKeywords(false); activateTab("transcript"); });
$("#search-results").addEventListener("click", (event) => {
  const play = event.target.closest("[data-search-match]"), open = event.target.closest("[data-search-open]");
  const jump = event.target.closest("[data-search-jump]");
  if (play && !play.disabled) openSearchMatch(Number(play.dataset.searchMatch), true);
  else if (jump && !jump.disabled) openSearchMatch(Number(jump.dataset.searchJump), true);
  else if (open) openSearchMatch(Number(open.dataset.searchOpen));
});
$("#submit-button").addEventListener("click", submitAudio);
$("#retry-summary").addEventListener("click", retrySummary);
$("#identify-speakers").addEventListener("click", identifySpeakers);
$("#speaker-stats-start").addEventListener("click", identifySpeakers);
$("#check-review").addEventListener("click", checkTranscriptReview);
$("#save-speaker-labels").addEventListener("click", saveSpeakerLabels);
$("#speaker-name-fields").addEventListener("change", (event) => {
  if (event.target.matches(".speaker-preset") && event.target.value) event.target.closest(".speaker-name-row").querySelector("input").value = event.target.value;
});
$("#transcript").addEventListener("change", (event) => {
  if (event.target.matches(".speaker-choice")) changeSegmentSpeaker(Number(event.target.dataset.segmentIndex), event.target.value);
});
$("#transcript").addEventListener("click", (event) => {
  const button = event.target.closest(".segment-play");
  const sentence = event.target.closest(".transcript-jump");
  if (button && !button.disabled) playTranscriptSegment(Number(button.dataset.segmentIndex));
  else if (sentence && !sentence.disabled) playTranscriptSegment(Number(sentence.dataset.sourceIndex));
});
$("#review-list").addEventListener("click", (event) => {
  const button = event.target.closest(".segment-play");
  const sentence = event.target.closest(".transcript-jump");
  if (button && !button.disabled) playTranscriptSegment(Number(button.dataset.segmentIndex));
  else if (sentence && !sentence.disabled) playTranscriptSegment(Number(sentence.dataset.sourceIndex));
});
$("#audio-file").addEventListener("change", (event) => {
  const files = [...(event.target.files || [])];
  if (files.length) { durationSeconds = 0; batchQueue.stageFiles(files); $("#record-title").textContent = "文件已选择"; }
  event.target.value = "";
});
$("#refresh-history").addEventListener("click", loadHistory);
$("#history-search").addEventListener("input", renderHistory);
$("#history-filter").addEventListener("change", renderHistory);
$("#history-sort").addEventListener("change", renderHistory);
$("#history-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  const record = historyRecords.find((item) => item.taskId === button.closest(".history-item")?.dataset.taskId);
  if (!record) return;
  if (button.dataset.action === "open") showHistoryRecord(record);
  else if (button.dataset.action === "edit") {
    historyEditId = historyEditId === record.taskId ? null : record.taskId;
    renderHistory();
    if (historyEditId) $("#history-list .history-edit input")?.focus();
  } else if (button.dataset.action === "favorite") saveHistoryMeta(record, { favorite: !record.favorite });
});
$("#history-list").addEventListener("submit", (event) => {
  if (!event.target.matches(".history-edit")) return;
  event.preventDefault();
  const record = historyRecords.find((item) => item.taskId === event.target.closest(".history-item")?.dataset.taskId);
  if (!record) return;
  const name = event.target.elements.namedItem("displayName").value.trim();
  const tags = [...new Set(event.target.elements.namedItem("tags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
  if (!name || name.length > 80) { toast("记录名称需为 1–80 个字符"); return; }
  if (tags.length > 8 || tags.some((tag) => tag.length > 24)) { toast("最多 8 个标签，每个不超过 24 个字符"); return; }
  saveHistoryMeta(record, { displayName: name, tags });
});
$("#refresh-health").addEventListener("click", checkHealth);
$("#copy-button").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(speakerOrganizer?.mode === "speaker" ? speakerOrganizer.text() : transcriptText(currentResult)); toast("已复制带时间段的转写内容"); }
  catch (error) { toast("复制失败，请选中文字复制，或使用导出 TXT"); }
});
$("#export-text").addEventListener("click", exportText);
$("#export-csv").addEventListener("click", exportCsv);
$("#export-speaker-stats").addEventListener("click", exportSpeakerStats);
$("#export-png").addEventListener("click", exportPng);
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));
window.addEventListener("resize", () => drawPitchCharts());
window.addEventListener("pagehide", () => { keywordController?.abort(); liveSession?.cancel(); fragmentSummaryPanel?.cancel(); activeRun?.controller.abort(); releaseMicrophone(); stopSegmentPlayback(); });
sourcePlayer = new SourceMediaPlayer({ container: $("#source-player"), video: $("#source-video"), audio: $("#segment-audio"),
  title: $("#source-title"), caption: $("#source-caption"), error: $("#source-error"), formatTime: formatMediaTime,
  onChange: (range, info) => { segmentPlayback = range?.state === "paused" ? null : range; sourceMediaInfo = info; updatePlaybackButtons(); } });
fragmentSummaryPanel = new FragmentSummaryPanel({
  getRecord: () => currentResult,
  getEntries: transcriptEntries,
  isBusy: () => Boolean(activeRun || batchQueue?.processing || batchQueue?.uploading || speakerSaving || transcriptEditor?.saving || waveformEditor?.saving || recordStarting || mediaRecorder?.state === "recording" || (currentResult?.status && !terminalStatuses.has(currentResult.status))),
  onBusyChange: () => setBusy(Boolean(activeRun)),
  formatTime: formatMediaTime,
  notify: toast,
});
speakerOrganizer = new SpeakerOrganizer({
  rerender: () => { if (currentResult) renderTranscript(currentResult); },
  summarize: (indices, label) => fragmentSummaryPanel.run(indices, false, label),
  notify: toast,
  formatTime: formatMediaTime,
  download: (text) => downloadBlob(new Blob(["\ufeff", historyName(currentResult || {}), "\n\n", text], { type: "text/plain;charset=utf-8" }), `按说话人整理-${exportName("txt")}`),
});
transcriptEditor = new TranscriptEditor({
  getRecord: () => currentResult,
  getEntries: transcriptEntries,
  isBusy: () => Boolean(activeRun || batchQueue?.processing || batchQueue?.uploading || speakerSaving || fragmentSummaryPanel?.pending || waveformEditor?.saving || recordStarting || mediaRecorder?.state === "recording" || (currentResult?.status && !terminalStatuses.has(currentResult.status))),
  onBusyChange: () => setBusy(Boolean(activeRun)),
  onSaved: async (result) => {
    if (currentResult?.taskId === result.taskId) { renderResult(result, false); if ($("#keyword-search").value.trim()) queueKeywordSearch(false); }
    await loadHistory();
  },
  notify: toast,
});
waveformEditor = new WaveformEditor({
  getRecord: () => currentResult,
  getEntries: transcriptEntries,
  isBusy: () => Boolean(activeRun || batchQueue?.processing || batchQueue?.uploading || speakerSaving || fragmentSummaryPanel?.pending || transcriptEditor?.saving || recordStarting || mediaRecorder?.state === "recording" || (currentResult?.status && !terminalStatuses.has(currentResult.status))),
  hasTextDrafts: () => transcriptEditor.hasDirtyDrafts(currentResult?.taskId),
  request: fetchJson,
  onBusyChange: () => setBusy(Boolean(activeRun)),
  onSaved: async (result) => {
    if (currentResult?.taskId === result.taskId) {
      renderResult(result, false);
      keywordMatches = []; $("#search-results").replaceChildren();
      if ($("#keyword-search").value.trim()) queueKeywordSearch(false);
    }
    await loadHistory();
  },
  preview: (index, start, end) => { stopSegmentPlayback(); sourcePlayer.prepare(currentResult.taskId, historyName(currentResult)); return sourcePlayer.playRange(index, start, end); },
  stopPlayback: stopSegmentPlayback,
  notify: toast,
  formatTime: formatMediaTime,
});
batchQueue = new BatchQueuePanel({
  request: fetchJson,
  getRecord: () => currentResult,
  onRecord: (record) => { if (!activeRun) renderResult(record, false); },
  onOpen: showHistoryRecord,
  onChange: () => setBusy(Boolean(activeRun)),
  onFinished: loadHistory,
  notify: toast,
});
batchQueue.renderStaged();
batchQueue.refresh();
updateRecordingSourceHint();
checkHealth();
loadHistory();
window.setInterval(checkHealth, 30000);
