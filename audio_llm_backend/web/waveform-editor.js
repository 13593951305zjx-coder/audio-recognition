(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const svgNode = (tag, attributes = {}, text) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  class WaveformEditor {
    constructor({ getRecord, getEntries, isBusy, hasTextDrafts, request, onSaved, onBusyChange, preview, stopPlayback, notify, formatTime }) {
      Object.assign(this, { getRecord, getEntries, isBusy, hasTextDrafts, request, onSaved, onBusyChange, preview, stopPlayback, notify, formatTime });
      this.drafts = new Map(); this.saving = false; this.zoom = 1;
      this.panel = document.createElement('details'); this.panel.className = 'waveform-editor'; this.panel.id = 'waveform-editor'; this.panel.hidden = true;
      this.panel.innerHTML = '<summary>波形与分句调整<span class="waveform-summary-hint">拖动边界 · 拆句 · 合句</span></summary><div class="waveform-editor-body"><p class="waveform-status" role="status"></p><p class="waveform-error" role="alert" hidden></p><div class="waveform-toolbar"><label>选择分句<select class="waveform-segment-select" aria-label="波形编辑选择分句"></select></label><label>缩放<select class="waveform-zoom" aria-label="波形缩放"><option value="1">完整波形</option><option value="2">2 倍</option><option value="4">4 倍</option><option value="8">8 倍</option></select></label><button type="button" class="text-button waveform-reload">重新加载波形</button><button type="button" class="text-button waveform-undo">撤销上一步分句调整</button></div><div class="waveform-viewport"><svg class="waveform-svg" height="176" role="group" aria-label="音频振幅波形与分句边界"></svg></div><p class="waveform-guide">彩色区域是当前句子。拖动两侧边界调整时间；点击空白波形设置拆分点。缩放后可横向滚动。边界获得焦点后可用方向键微调。</p><div class="waveform-time-fields"><label>开始时间（秒）<input class="waveform-start" aria-label="分句开始时间（秒）" type="number" min="0" step="0.01"></label><label>结束时间（秒）<input class="waveform-end" aria-label="分句结束时间（秒）" type="number" min="0" step="0.01"></label></div><div class="waveform-actions"><button type="button" class="text-button waveform-preview">试听当前时间段</button><button type="button" class="summary-button waveform-save">保存时间调整</button><button type="button" class="text-button waveform-reset">重置本句</button></div><p class="waveform-draft-note" role="status"></p><details class="waveform-split"><summary>拆分当前句子</summary><div class="waveform-sub-body"><label>切分时间（秒）<input class="waveform-split-at" type="number" min="0" step="0.01" aria-label="切分时间（秒）"></label><label>在原句中放置文字光标<textarea class="waveform-original-text" readonly rows="2" aria-label="原句文字切分位置"></textarea></label><button type="button" class="text-button waveform-split-at-caret">按文字光标分配前后句</button><small>时间与文字切分位置分别设置，请试听核对；文字比例只用于预填时间，不是自动对齐。</small><div class="waveform-split-texts"><label>前半句<textarea class="waveform-left-text" rows="3" aria-label="拆分前半句"></textarea></label><label>后半句<textarea class="waveform-right-text" rows="3" aria-label="拆分后半句"></textarea></label></div><button type="button" class="summary-button waveform-split-save">保存为两句</button></div></details><details class="waveform-merge"><summary>与时间上的下一句合并</summary><div class="waveform-sub-body"><p class="waveform-next-text"></p><p class="waveform-merge-warning"></p><label>合并后说话人<select class="waveform-merge-speaker" aria-label="合并后说话人"></select></label><button type="button" class="summary-button waveform-merge-save">合并这两句</button></div></details><p class="waveform-footnote">保存只调整分句，原音视频和音高数据保持保存。原分句及修改记录留在本机；调整后的发言时长按当前分句估算。</p></div>';
      document.querySelector('#transcript').before(this.panel);
      this.recovery = document.createElement('div'); this.recovery.className = 'waveform-recovery'; this.recovery.hidden = true;
      this.panel.querySelector('.waveform-status').after(this.recovery);
      this.svg = this.panel.querySelector('svg'); this.viewport = this.panel.querySelector('.waveform-viewport');
      const find = (selector) => this.panel.querySelector(selector);
      this.fields = { start: find('.waveform-start'), end: find('.waveform-end'), splitAt: find('.waveform-split-at'), leftText: find('.waveform-left-text'), rightText: find('.waveform-right-text') };
      this.selector = find('.waveform-segment-select');
      this.selector.addEventListener('change', () => this.select(Number(this.selector.value)));
      find('.waveform-zoom').addEventListener('change', (event) => { this.zoom = Number(event.target.value); this.paint(); this.revealSelection(); });
      this.panel.addEventListener('toggle', () => { if (this.panel.open && !this.waveform && !this.loading) this.load(); });
      find('.waveform-reload').addEventListener('click', () => this.load(true));
      find('.waveform-undo').addEventListener('click', () => this.save('undo'));
      find('.waveform-save').addEventListener('click', () => this.save('timing'));
      find('.waveform-split-save').addEventListener('click', () => this.save('split'));
      find('.waveform-merge-save').addEventListener('click', () => this.save('merge'));
      find('.waveform-reset').addEventListener('click', () => { this.drafts.delete(this.key()); this.select(this.selectedIndex); });
      find('.waveform-preview').addEventListener('click', () => {
        const draft = this.draft();
        if (draft && this.validRange(draft.start, draft.end)) this.preview(this.selectedIndex, draft.start, draft.end);
      });
      for (const [name, input] of Object.entries(this.fields)) input.addEventListener('input', () => {
        const draft = this.draft(); if (!draft || this.saving) return;
        draft[name] = input.type === 'number' ? input.value === '' ? NaN : Number(input.value) : input.value;
        draft.dirty = true; this.paint(); this.refreshControls();
      });
      find('.waveform-split-at-caret').addEventListener('click', () => {
        const source = find('.waveform-original-text'), offset = source.selectionStart;
        const draft = this.draft(), entry = this.entry();
        if (!draft || offset <= 0 || offset >= entry.text.length) { this.notify('请把文字光标放在原句中间需要拆开的地方'); return; }
        draft.leftText = entry.text.slice(0, offset).trim(); draft.rightText = entry.text.slice(offset).trim();
        draft.splitAt = Number((draft.start + (draft.end - draft.start) * offset / entry.text.length).toFixed(3)); draft.dirty = true;
        this.fillFields(); this.paint(); this.refreshControls();
      });
      find('.waveform-merge-speaker').addEventListener('change', () => { const draft = this.draft(); if (draft) { draft.mergeSpeaker = find('.waveform-merge-speaker').value; this.refreshControls(); } });
      this.svg.addEventListener('pointerdown', (event) => {
        if (this.saving || this.isBusy() || !this.waveform) return;
        const edge = event.target.closest('[data-edge]');
        if (edge) { event.preventDefault(); this.drag = { edge: edge.dataset.edge, pointer: event.pointerId }; this.svg.setPointerCapture(event.pointerId); return; }
        const region = event.target.closest('[data-segment-index]');
        if (region) { this.select(Number(region.dataset.segmentIndex)); return; }
        const draft = this.draft(); if (!draft) return;
        draft.splitAt = this.timeAt(event.clientX); draft.dirty = true;
        this.fields.splitAt.value = draft.splitAt; this.paint(); this.refreshControls();
      });
      this.svg.addEventListener('pointermove', (event) => {
        if (!this.drag || this.drag.pointer !== event.pointerId) return;
        this.moveEdge(this.drag.edge, this.timeAt(event.clientX));
      });
      const endDrag = (event) => { if (this.drag?.pointer === event.pointerId) { if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId); this.drag = null; } };
      this.svg.addEventListener('pointerup', endDrag); this.svg.addEventListener('pointercancel', endDrag);
      this.svg.addEventListener('keydown', (event) => {
        const edge = event.target.dataset.edge;
        const region = event.target.dataset.segmentIndex;
        if (region != null && ['Enter', ' '].includes(event.key)) { event.preventDefault(); this.select(Number(region)); return; }
        if (!edge || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || this.saving || this.isBusy()) return;
        event.preventDefault(); const draft = this.draft();
        const value = event.key === 'Home' ? 0 : event.key === 'End' ? this.waveform.durationSeconds : draft[edge] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? .5 : .05);
        this.moveEdge(edge, value); this.svg.querySelector(`[data-edge="${edge}"]`)?.focus();
      });
      this.resizeObserver = new ResizeObserver(() => { if (this.panel.open) this.paint(); }); this.resizeObserver.observe(this.viewport);
      for (const player of document.querySelectorAll('#segment-audio, #source-video')) player.addEventListener('timeupdate', () => {
        if (this.panel.open && this.waveform) { const line = this.svg.querySelector('.waveform-playhead'); if (line) { const x = player.currentTime / this.waveform.durationSeconds * this.width; line.setAttribute('x1', x); line.setAttribute('x2', x); } }
      });
      window.addEventListener('beforeunload', (event) => { if ([...this.drafts.values()].some((draft) => draft.dirty)) { event.preventDefault(); event.returnValue = ''; } });
      window.addEventListener('pagehide', () => this.controller?.abort());
    }

    key(index = this.selectedIndex) { return `${this.taskId}:${index}`; }
    entry() { return this.entries?.find((entry) => entry.index === this.selectedIndex); }
    draft() { return this.drafts.get(this.key()); }
    validRange(start, end) { return this.waveform && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end - start >= .049999 && end <= this.waveform.durationSeconds + .000001; }
    error(message = '') { const node = this.panel.querySelector('.waveform-error'); node.textContent = message; node.hidden = !message; }

    render(record) {
      const entries = this.getEntries(record).filter((entry) => entry.timed && Number.isInteger(entry.index));
      if (record?.taskId !== this.taskId) {
        this.controller?.abort(); this.loading = false; this.taskId = record?.taskId; this.waveform = null; this.panel.open = false; this.selectedIndex = entries[0]?.index;
        this.error(); this.svg.replaceChildren();
      }
      this.record = record; this.entries = entries; this.panel.hidden = !entries.length;
      const staleDrafts = [...this.drafts.entries()].filter(([key, draft]) => key.startsWith(`${this.taskId}:`) && draft.dirty && draft.expectedRevision !== (record?.transcriptRevision || 0));
      this.recovery.replaceChildren(); this.recovery.hidden = !staleDrafts.length;
      if (staleDrafts.length) {
        const note = document.createElement('p'); note.textContent = '分句已发生其他修改，以下时间草稿未覆盖新版本：'; this.recovery.append(note);
        for (const [key, draft] of staleDrafts) { const text = document.createElement('p'); text.textContent = `原第 ${Number(key.split(':').pop()) + 1} 句：${draft.start}–${draft.end} 秒，切分点 ${draft.splitAt} 秒 · ${draft.sourceText || ''}`; this.recovery.append(text); }
        const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'text-button'; clear.textContent = '丢弃旧时间草稿并加载新分句';
        clear.addEventListener('click', () => { for (const [key] of staleDrafts) this.drafts.delete(key); this.render(this.getRecord()); }); this.recovery.append(clear);
      }
      this.selector.replaceChildren();
      entries.forEach((entry) => { const option = document.createElement('option'); option.value = entry.index; option.textContent = `第 ${entry.index + 1} 句 · ${this.formatTime(entry.start)} · ${entry.text.slice(0, 32)}`; this.selector.append(option); });
      if (!this.entry()) this.selectedIndex = entries[0]?.index;
      if (this.entry()) this.select(this.selectedIndex, false);
      document.querySelectorAll('#transcript .transcript-entry, #review-list .transcript-entry').forEach((row) => {
        row.querySelector('.waveform-edit-row')?.remove();
        const index = Number(row.querySelector('.segment-play')?.dataset.segmentIndex);
        if (!entries.some((entry) => entry.index === index)) return;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button waveform-edit-row'; button.textContent = '调整分句';
        button.setAttribute('aria-label', `调整第 ${index + 1} 句时间与分句`); button.addEventListener('click', () => this.open(index));
        const tools = row.querySelector('.transcript-edit-tools') || row.querySelector('.transcript-entry-text'); tools.append(button);
        row.querySelector('.waveform-edited-badge')?.remove();
        if (record.segments[index].timingManuallyEdited) { const badge = document.createElement('small'); badge.className = 'waveform-edited-badge'; badge.textContent = '分句已调整'; tools.append(badge); }
      });
      this.refreshControls();
    }

    open(index) {
      if (this.saving || this.isBusy()) { this.notify('请等待当前处理完成后再调整分句'); return; }
      if (this.hasTextDrafts()) { this.notify('请先保存或取消文字编辑，再调整分句'); return; }
      this.select(index); this.panel.open = true;
      if (!this.waveform && !this.loading) this.load();
      this.panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    async load(refresh = false) {
      if (!this.taskId || this.loading || this.isBusy()) return;
      if (this.waveform && !refresh) return;
      const taskId = this.taskId, controller = new AbortController(); this.controller = controller; this.loading = true; this.error();
      this.panel.querySelector('.waveform-status').textContent = '正在读取原音频振幅，首次打开需要解码…'; this.refreshControls();
      try {
        const data = await this.request(`/api/recognition/${encodeURIComponent(taskId)}/waveform`, {}, controller.signal, 60000);
        if (this.taskId !== taskId || controller.signal.aborted) return;
        this.waveform = data;
        this.panel.querySelector('.waveform-status').textContent = `原音频 ${this.formatTime(data.durationSeconds)} · 振幅波形（不是音高）`;
        this.select(this.selectedIndex, false); this.paint(); this.revealSelection();
      } catch (error) { if (!controller.signal.aborted && this.taskId === taskId) this.error(error.message || '波形读取失败，可重新加载'); }
      finally { if (this.controller === controller) { this.loading = false; this.refreshControls(); } }
    }

    select(index, reveal = true) {
      if (reveal && index !== this.selectedIndex && this.draft()?.dirty) { this.selector.value = String(this.selectedIndex); this.notify('当前句有未保存的调整，请先保存或重置再切换句子'); return; }
      this.selectedIndex = index; const entry = this.entry(); if (!entry) return;
      this.selector.value = String(index);
      if (!this.draft()) {
        const offset = Math.floor(entry.text.length / 2);
        this.drafts.set(this.key(), { start: entry.start, end: entry.end, splitAt: Number(((entry.start + entry.end) / 2).toFixed(3)),
          leftText: entry.text.slice(0, offset).trim(), rightText: entry.text.slice(offset).trim(),
          expectedRevision: this.record.transcriptRevision || 0, mergeSpeaker: null, dirty: false, sourceText: entry.text });
      }
      this.fillFields(); this.paint(); this.refreshControls(); if (reveal) this.revealSelection();
    }

    fillFields() {
      const draft = this.draft(), entry = this.entry(); if (!draft || !entry) return;
      for (const [name, field] of Object.entries(this.fields)) field.value = Number.isFinite(draft[name]) || typeof draft[name] === 'string' ? draft[name] : '';
      this.panel.querySelector('.waveform-original-text').value = entry.text;
      const position = this.entries.findIndex((item) => item.index === this.selectedIndex); this.nextEntry = this.entries[position + 1];
      const next = this.nextEntry;
      this.panel.querySelector('.waveform-next-text').textContent = next ? `下一句：${this.formatTime(next.start)}–${this.formatTime(next.end)} · ${next.text}` : '当前已经是时间顺序中的最后一句。';
      const differs = next && next.speakerId !== entry.speakerId;
      this.panel.querySelector('.waveform-merge-warning').textContent = differs ? '这两句说话人不同，请明确选择合并后的归属。合并会覆盖两句之间的停顿或重叠时间，请先试听。' : '合并时间覆盖两句之间的全部音频，可能包含停顿，请先核对。';
      const select = this.panel.querySelector('.waveform-merge-speaker'); select.replaceChildren();
      const add = (value, text) => { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); };
      add('', '请选择合并后的说话人'); add('__unknown__', '未确定说话人');
      for (const speaker of this.record.speakers || []) add(speaker.id, speaker.label || speaker.code || speaker.id);
      if (draft.mergeSpeaker === null) draft.mergeSpeaker = differs ? '' : entry.speakerId || '__unknown__';
      select.value = draft.mergeSpeaker;
    }

    timeAt(clientX) { const box = this.svg.getBoundingClientRect(); return Number(Math.max(0, Math.min(this.waveform.durationSeconds, (clientX - box.left) / box.width * this.waveform.durationSeconds)).toFixed(3)); }
    moveEdge(edge, value) {
      const draft = this.draft(); if (!draft || !this.waveform) return;
      draft[edge] = Number((edge === 'start' ? Math.max(0, Math.min(draft.end - .05, value)) : Math.min(this.waveform.durationSeconds, Math.max(draft.start + .05, value))).toFixed(3));
      draft.dirty = true; this.fields[edge].value = draft[edge]; this.paint(); this.refreshControls();
    }
    revealSelection() { if (!this.waveform || !this.entry()) return; const x = this.entry().start / this.waveform.durationSeconds * this.width; this.viewport.scrollLeft = Math.max(0, x - this.viewport.clientWidth * .2); }

    paint() {
      if (!this.waveform || !this.panel.open || !this.entry()) return;
      const data = this.waveform, duration = data.durationSeconds, draft = this.draft();
      const width = Math.max(320, this.viewport.clientWidth) * this.zoom; this.width = width;
      this.svg.setAttribute('width', width); this.svg.setAttribute('viewBox', `0 0 ${width} 176`); this.svg.style.width = `${width}px`;
      const fragment = document.createDocumentFragment();
      const x = (time) => time / duration * width;
      const step = [0.1, .2, .5, 1, 2, 5, 10, 20, 30, 60, 120, 300].find((value) => value * width / duration >= 75) || 300;
      for (let time = 0; time <= duration; time += step) { fragment.append(svgNode('line', { x1: x(time), x2: x(time), y1: 15, y2: 154, class: 'waveform-grid' }), svgNode('text', { x: x(time) + 3, y: 170, class: 'waveform-tick' }, this.formatTime(time))); }
      fragment.append(svgNode('line', { x1: 0, x2: width, y1: 58, y2: 58, class: 'waveform-baseline' }));
      const maximum = Math.max(.00001, ...data.peaks.map((peak) => Math.max(Math.abs(peak[0]), Math.abs(peak[1]))));
      const top = data.peaks.map((peak, i) => `${x(i * data.samplesPerPeak / data.sampleRate).toFixed(2)},${(58 - peak[1] / maximum * 38).toFixed(2)}`);
      const bottom = data.peaks.map((peak, i) => `${x(i * data.samplesPerPeak / data.sampleRate).toFixed(2)},${(58 - peak[0] / maximum * 38).toFixed(2)}`).reverse();
      fragment.append(svgNode('path', { d: `M${top.join(' L')} L${bottom.join(' L')} Z`, class: 'waveform-amplitude', 'pointer-events': 'none' }));
      this.entries.forEach((entry, line) => {
        const selected = entry.index === this.selectedIndex, start = selected ? draft.start : entry.start, end = selected ? draft.end : entry.end;
        if (!Number.isFinite(start) || !Number.isFinite(end)) return;
        const group = svgNode('g', { 'data-segment-index': entry.index, tabindex: '0', role: 'button', 'aria-label': `选择第 ${entry.index + 1} 句：${entry.text.slice(0, 45)}`, class: 'waveform-region' });
        group.append(svgNode('rect', { x: Math.max(0, x(start)), y: 106 + line % 2 * 22, width: Math.max(2, x(Math.min(duration, end)) - Math.max(0, x(start))), height: 20, rx: 3, class: selected ? 'waveform-segment selected' : 'waveform-segment' }));
        if (x(end - start) > 22) group.append(svgNode('text', { x: x(Math.max(0, start)) + 4, y: 120 + line % 2 * 22, class: 'waveform-segment-label', 'pointer-events': 'none' }, String(entry.index + 1)));
        fragment.append(group);
      });
      if (this.validRange(draft.start, draft.end)) {
        fragment.append(svgNode('rect', { x: x(draft.start), y: 12, width: x(draft.end - draft.start), height: 88, class: 'waveform-selected-range', 'pointer-events': 'none' }));
        for (const edge of ['start', 'end']) {
          const handle = svgNode('g', { 'data-edge': edge, role: 'slider', tabindex: 0, 'aria-label': edge === 'start' ? '句子开始时间边界' : '句子结束时间边界', 'aria-valuemin': 0, 'aria-valuemax': duration, 'aria-valuenow': draft[edge], 'aria-valuetext': this.formatTime(draft[edge]), class: `waveform-handle ${edge}` });
          handle.append(svgNode('rect', { x: x(draft[edge]) - 8, y: 10, width: 16, height: 140, fill: 'transparent' }), svgNode('line', { x1: x(draft[edge]), x2: x(draft[edge]), y1: 12, y2: 150 }), svgNode('rect', { x: x(draft[edge]) - 5, y: 15, width: 10, height: 20, rx: 3 })); fragment.append(handle);
        }
      }
      if (Number.isFinite(draft.splitAt)) fragment.append(svgNode('line', { x1: x(draft.splitAt), x2: x(draft.splitAt), y1: 10, y2: 151, class: 'waveform-split-line', 'pointer-events': 'none' }));
      fragment.append(svgNode('line', { x1: 0, x2: 0, y1: 12, y2: 150, class: 'waveform-playhead', 'pointer-events': 'none' })); this.svg.replaceChildren(fragment);
    }

    refreshControls() {
      const busy = this.saving || this.isBusy(), draft = this.draft(), entry = this.entry();
      const valid = draft && this.validRange(draft.start, draft.end), stale = draft && draft.expectedRevision !== (this.record?.transcriptRevision || 0);
      document.querySelectorAll('.waveform-edit-row').forEach((button) => { button.disabled = busy; });
      this.panel.querySelectorAll('input, textarea, select, button').forEach((element) => { element.disabled = busy; });
      this.panel.querySelector('.waveform-reload').disabled = busy || this.loading;
      this.panel.querySelector('.waveform-save').disabled = busy || !valid || stale || (draft.start === entry?.start && draft.end === entry?.end);
      this.panel.querySelector('.waveform-preview').disabled = busy || !valid;
      this.panel.querySelector('.waveform-split-save').disabled = busy || !valid || stale || !draft.leftText?.trim() || !draft.rightText?.trim() || !this.validRange(draft.start, draft.splitAt) || !this.validRange(draft.splitAt, draft.end) || draft.start !== entry.start || draft.end !== entry.end;
      this.panel.querySelector('.waveform-merge-save').disabled = busy || !valid || stale || !this.nextEntry || !draft.mergeSpeaker || draft.start !== entry.start || draft.end !== entry.end;
      this.panel.querySelector('.waveform-undo').disabled = busy || !this.record?.segmentUndo || this.record.segmentUndo.revision !== (this.record.transcriptRevision || 0);
      this.panel.querySelector('.waveform-reset').disabled = busy || !draft;
      this.panel.querySelector('.waveform-draft-note').textContent = stale ? '转写已发生其他修改，此草稿未保存。请记录需要的时间后点击“重置本句”加载新版本。' : draft?.dirty ? '当前调整尚未保存。先试听，再保存时间或拆分结果；合并前请先保存或重置时间修改。' : '选择一句开始调整；操作不会自动保存。';
    }

    async save(operation) {
      if (this.saving || this.isBusy() || !this.waveform || !this.entry()) return;
      if (this.hasTextDrafts()) { this.notify('请先保存或取消文字编辑，再修改分句结构'); return; }
      const draft = this.draft(), taskId = this.taskId;
      if (operation === 'undo' && [...this.drafts.entries()].some(([key, value]) => key.startsWith(`${taskId}:`) && value.dirty)) { this.notify('请先保存或重置未保存的分句调整，再撤销'); return; }
      if (operation !== 'undo' && draft.expectedRevision !== (this.record.transcriptRevision || 0)) { this.error('草稿已过期，请重置本句后再调整'); return; }
      const payload = { operation, expectedRevision: operation === 'undo' ? this.record.transcriptRevision || 0 : draft.expectedRevision, segmentIndex: this.selectedIndex };
      if (operation === 'timing') Object.assign(payload, { start: draft.start, end: draft.end });
      if (operation === 'split') Object.assign(payload, { splitAt: draft.splitAt, leftText: draft.leftText, rightText: draft.rightText });
      if (operation === 'merge') Object.assign(payload, { nextIndex: this.nextEntry?.index, speakerId: draft.mergeSpeaker === '__unknown__' ? null : draft.mergeSpeaker, confirmSpeakerChange: true });
      this.saving = true; this.error(); this.stopPlayback(); this.onBusyChange(); this.refreshControls();
      try {
        const record = await this.request(`/api/recognition/${encodeURIComponent(taskId)}/segments/adjust`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, undefined, 60000);
        for (const key of this.drafts.keys()) if (key.startsWith(`${taskId}:`)) this.drafts.delete(key);
        await this.onSaved(record);
        this.notify(operation === 'undo' ? '已撤销上一步分句调整' : '分句调整已保存，原声播放和统计已更新');
      } catch (error) { this.error(error.message || '分句保存失败，当前调整已保留'); }
      finally { this.saving = false; this.onBusyChange(); this.refreshControls(); }
    }
  }
  window.WaveformEditor = WaveformEditor;
})();
