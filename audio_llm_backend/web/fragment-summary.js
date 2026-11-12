(() => {
  class FragmentSummaryPanel {
    constructor({ getRecord, getEntries, isBusy, onBusyChange, formatTime, notify }) {
      Object.assign(this, { getRecord, getEntries, isBusy, onBusyChange, formatTime, notify });
      this.selection = new Set();
      this.pending = false;
      this.taskId = null;
      this.entries = [];
      this.tools = document.createElement('div');
      this.tools.className = 'fragment-summary-tools';
      this.tools.hidden = true;
      this.tools.innerHTML = '<label><input type="checkbox" class="fragment-select-all" />全选</label><span class="fragment-selection-count">已选 0 段</span><button type="button" class="summary-button fragment-summarize-selected" disabled>AI 总结选中内容</button><button type="button" class="text-button fragment-clear-selection">清空选择</button><small>可勾选多条转写一起概括，也可单独总结每一段。</small>';
      this.panel = document.createElement('section');
      this.panel.className = 'fragment-summary-result';
      this.panel.hidden = true;
      this.panel.setAttribute('aria-label', 'AI 片段总结');
      this.panel.innerHTML = '<div class="fragment-summary-heading"><strong>AI 片段总结</strong><button type="button" class="text-button fragment-summary-close">收起</button></div><p class="fragment-summary-status" role="status" aria-live="polite"></p><p class="fragment-summary-error" role="alert" hidden></p><p class="fragment-summary-text"></p><ul class="fragment-summary-points"></ul><details class="fragment-summary-source"><summary>查看所选原文</summary><p></p></details><div class="fragment-summary-actions"><button type="button" class="text-button fragment-summary-copy" disabled>复制总结</button><button type="button" class="text-button fragment-summary-retry" hidden>重新总结</button></div><small>总结依据所选转写，原文中的识别错误可能影响概括。</small>';
      document.querySelector('#transcript-caption').after(this.tools, this.panel);
      this.all = this.tools.querySelector('.fragment-select-all');
      this.runButton = this.tools.querySelector('.fragment-summarize-selected');
      this.copy = this.panel.querySelector('.fragment-summary-copy');
      this.retry = this.panel.querySelector('.fragment-summary-retry');
      this.closeButton = this.panel.querySelector('.fragment-summary-close');
      this.all.addEventListener('change', () => {
        this.selection = this.all.checked ? new Set(this.entries.map((entry) => entry.index ?? -1)) : new Set();
        this.refreshControls();
      });
      this.tools.querySelector('.fragment-clear-selection').addEventListener('click', () => { this.selection.clear(); this.refreshControls(); });
      this.runButton.addEventListener('click', () => this.run([...this.selection]));
      this.closeButton.addEventListener('click', () => { this.panel.hidden = true; });
      this.retry.addEventListener('click', () => this.run(this.lastIndices, true, this.lastLabel));
      this.copy.addEventListener('click', async () => {
        if (!this.data) return;
        try {
          await navigator.clipboard.writeText([this.data.summary, ...this.data.keyPoints.map((point) => `• ${point}`)].join('\n'));
          this.notify('已复制片段总结');
        } catch (_) { this.notify('复制失败，可以选中总结文字后复制'); }
      });
      const transcript = document.querySelector('#transcript');
      transcript.addEventListener('change', (event) => {
        if (!event.target.matches('.fragment-select')) return;
        const index = Number(event.target.dataset.segmentIndex);
        if (event.target.checked) this.selection.add(index); else this.selection.delete(index);
        this.refreshControls();
      });
      transcript.addEventListener('click', (event) => {
        const button = event.target.closest('.fragment-summarize-row');
        if (button && !button.disabled) this.run([Number(button.dataset.segmentIndex)]);
      });
    }

    render(record) {
      if (this.structureRevision !== (record?.segmentStructureRevision || 0)) this.selection.clear();
      this.structureRevision = record?.segmentStructureRevision || 0;
      if (this.taskId === record?.taskId && this.revision !== (record?.transcriptRevision || 0)) {
        this.cancel(); this.data = null; this.panel.hidden = true;
      }
      this.revision = record?.transcriptRevision || 0;
      if (this.taskId !== record?.taskId) {
        this.cancel();
        this.taskId = record?.taskId || null;
        this.selection.clear();
        this.data = null;
        this.panel.hidden = true;
      }
      this.entries = this.getEntries(record);
      const valid = new Set(this.entries.map((entry) => entry.index ?? -1));
      this.selection = new Set([...this.selection].filter((index) => valid.has(index)));
      this.tools.hidden = !record?.taskId || !this.entries.length;
      const rows = document.querySelectorAll('#transcript > .transcript-entry');
      this.entries.forEach((entry, line) => {
        if (!rows[line] || !record?.taskId) return;
        const controls = document.createElement('div');
        controls.className = 'fragment-row-tools';
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'fragment-select';
        checkbox.dataset.segmentIndex = entry.index ?? -1;
        checkbox.setAttribute('aria-label', `选中第 ${line + 1} 段用于 AI 总结`);
        label.append(checkbox, document.createTextNode('选入总结'));
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'text-button fragment-summarize-row';
        button.dataset.segmentIndex = entry.index ?? -1;
        button.textContent = '✦ AI 总结这段';
        button.setAttribute('aria-label', `AI 总结第 ${line + 1} 段`);
        controls.append(label, button);
        rows[line].querySelector('.transcript-entry-text').append(controls);
      });
      this.refreshControls();
    }

    refreshControls() {
      const unavailable = this.pending || this.isBusy();
      this.all.checked = this.entries.length > 0 && this.selection.size === this.entries.length;
      this.all.indeterminate = this.selection.size > 0 && this.selection.size < this.entries.length;
      this.all.disabled = unavailable;
      this.tools.querySelector('.fragment-selection-count').textContent = `已选 ${this.selection.size} 段`;
      this.runButton.disabled = unavailable || !this.selection.size;
      this.runButton.textContent = this.pending ? 'AI 正在总结…' : 'AI 总结选中内容';
      document.querySelectorAll('.fragment-select').forEach((box) => {
        box.checked = this.selection.has(Number(box.dataset.segmentIndex));
        box.disabled = unavailable;
      });
      document.querySelectorAll('.fragment-summarize-row').forEach((button) => { button.disabled = unavailable; });
      document.querySelectorAll('.speaker-group-summarize').forEach((button) => { button.disabled = unavailable || button.dataset.sourceAvailable !== 'true'; });
      this.retry.disabled = unavailable;
      this.closeButton.disabled = this.pending;
    }

    async run(indices, refresh = false, label = '') {
      if (this.pending || this.isBusy()) { this.notify('请等待录音或当前处理完成后再总结'); return; }
      const record = this.getRecord();
      if (!record?.taskId || !indices?.length) return;
      const sourceIndices = indices.includes(-1) ? null : [...indices];
      const taskId = record.taskId;
      const controller = new AbortController();
      this.controller = controller;
      this.lastIndices = [...indices];
      this.lastLabel = label;
      this.panel.querySelector('.fragment-summary-heading strong').textContent = label ? `AI 总结 · ${label}` : 'AI 片段总结';
      this.pending = true;
      this.panel.hidden = false;
      this.data = null;
      this.copy.disabled = true;
      this.retry.hidden = true;
      this.panel.querySelector('.fragment-summary-error').hidden = true;
      this.panel.querySelector('.fragment-summary-status').textContent = '正在使用本地 AI 概括所选文字，首次加载模型可能稍慢…';
      this.panel.querySelector('.fragment-summary-text').textContent = '';
      this.panel.querySelector('.fragment-summary-points').replaceChildren();
      this.panel.querySelector('.fragment-summary-source p').textContent = this.entries.filter((entry) => sourceIndices === null || sourceIndices.includes(entry.index)).map((entry) => entry.text).join('\n');
      this.onBusyChange();
      this.refreshControls();
      this.panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const timeout = setTimeout(() => controller.abort(), 195000);
      try {
        const response = await fetch(`/api/recognition/${encodeURIComponent(taskId)}/fragment-summary`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segmentIndices: sourceIndices, refresh, expectedStructureRevision: record.segmentStructureRevision || 0 }), signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `片段总结失败（${response.status}）`);
        if (this.controller !== controller || this.taskId !== taskId) return;
        this.data = data;
        const range = Number.isFinite(data.start) && Number.isFinite(data.end) ? ` · ${this.formatTime(data.start)}–${this.formatTime(data.end)}` : '';
        this.panel.querySelector('.fragment-summary-status').textContent = `${data.segmentCount} 段${range} · ${data.cached ? '已载入本机保存的总结' : '已保存到本机'} · ${data.model}`;
        this.panel.querySelector('.fragment-summary-text').textContent = data.summary;
        const list = this.panel.querySelector('.fragment-summary-points');
        for (const point of data.keyPoints) { const item = document.createElement('li'); item.textContent = point; list.append(item); }
        this.panel.querySelector('.fragment-summary-source p').textContent = data.sourceText;
        this.copy.disabled = false;
        this.retry.hidden = false;
      } catch (error) {
        if (this.controller !== controller) return;
        const notice = this.panel.querySelector('.fragment-summary-error');
        notice.textContent = error.name === 'AbortError' ? '片段总结等待超时，请稍后重试' : error.message;
        notice.hidden = false;
        this.panel.querySelector('.fragment-summary-status').textContent = '总结未完成，原文已保留。';
        this.retry.hidden = false;
      } finally {
        clearTimeout(timeout);
        if (this.controller === controller) {
          this.controller = null;
          this.pending = false;
          this.onBusyChange();
          this.refreshControls();
        }
      }
    }

    cancel() {
      const wasPending = this.pending;
      this.controller?.abort();
      this.controller = null;
      this.pending = false;
      if (wasPending) this.onBusyChange();
    }
  }
  window.FragmentSummaryPanel = FragmentSummaryPanel;
})();
