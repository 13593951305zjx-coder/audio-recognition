(() => {
  const labels = { Queued: '排队中', Preparing: '准备识别', Uploading: '上传中', Analyzing: '分析音高', Recognizing: '正在转写', Diarizing: '区分说话人', Reviewing: '检查模糊片段', Summarizing: '提取重点', Success: '已完成', Partial: '部分完成', Failed: '识别失败', Cancelled: '已取消' };
  class BatchQueuePanel {
    constructor({ request, getRecord, onRecord, onOpen, onChange, onFinished, notify }) {
      Object.assign(this, { request, getRecord, onRecord, onOpen, onChange, onFinished, notify });
      this.staged = []; this.items = []; this.uploading = false; this.processing = false; this.refreshing = false;
      this.staging = document.querySelector('#batch-staging');
      this.panel = document.querySelector('#batch-queue');
      this.list = document.querySelector('#batch-queue-list');
      document.querySelector('#batch-queue-refresh').addEventListener('click', () => this.refresh());
      document.querySelector('#batch-queue-current').addEventListener('click', () => {
        const current = this.items.find((item) => item.queueState === 'processing');
        if (current) this.open(current.taskId, true);
      });
      window.addEventListener('beforeunload', (event) => {
        if (this.uploading || this.staged.some((item) => item.state === 'Draft')) { event.preventDefault(); event.returnValue = ''; }
      });
      window.addEventListener('pagehide', () => { this.closed = true; clearTimeout(this.timer); });
      window.addEventListener('pageshow', (event) => { if (event.persisted) { this.closed = false; this.refresh(); } });
    }

    get pendingCount() { return this.staged.filter((item) => item.state === 'Draft').length; }

    stageFiles(files) {
      const added = [...files];
      if (added.length > 20) { this.notify('单次最多选择 20 个文件，请分次添加'); return; }
      for (const file of added) this.staged.push({ file, id: crypto.randomUUID(), state: 'Draft' });
      this.renderStaged(); this.onChange();
    }

    renderStaged() {
      this.staging.replaceChildren(); this.staging.hidden = !this.staged.length;
      for (const item of this.staged) {
        const row = document.createElement('li'); row.className = 'batch-staged-item';
        const name = document.createElement('strong'); name.textContent = item.file.name;
        const detail = document.createElement('small');
        detail.textContent = `${(item.file.size / 1024 / 1024).toFixed(2)} MB · ${item.state === 'Uploading' ? '上传中' : item.state === 'UploadFailed' ? '上传未完成' : '待上传'}`;
        row.append(name, detail);
        if (item.error) { const error = document.createElement('p'); error.className = 'batch-upload-error'; error.textContent = item.error; row.append(error); }
        const remove = document.createElement('button'); remove.className = 'text-button'; remove.type = 'button'; remove.textContent = '移除'; remove.disabled = item.state === 'Uploading';
        remove.setAttribute('aria-label', `移除待上传文件 ${item.file.name}`);
        remove.addEventListener('click', () => { this.staged = this.staged.filter((other) => other !== item); this.renderStaged(); this.onChange(); });
        row.append(remove); this.staging.append(row);
      }
      const selected = document.querySelector('#selected-file'); selected.replaceChildren();
      const badge = document.createElement('span'); badge.className = 'file-badge'; badge.textContent = '音频';
      const text = document.createElement('span'); text.textContent = this.staged.length ? `已选择 ${this.staged.length} 个文件 · 待上传 ${this.pendingCount} 个` : '还没有选择文件，可一次选择多个';
      selected.append(badge, text);
    }

    async uploadSelected() {
      if (this.uploading || !this.pendingCount) return;
      const batch = this.staged.filter((item) => item.state === 'Draft');
      const focusFirst = !this.processing;
      this.uploading = true; this.onChange();
      let focused = false, uploaded = 0;
      try {
        for (const item of batch) {
          if (!this.staged.includes(item)) continue;
          item.state = 'Uploading'; this.renderStaged();
          const form = new FormData(); form.append('audioFile', item.file, item.file.name);
          form.append('format', item.file.name.split('.').pop()?.toLowerCase() || 'webm'); form.append('duration', '0');
          try {
            const response = await this.request('/api/recognition', { method: 'POST', body: form }, undefined, 120000);
            if (!response?.taskId) throw new Error('服务未返回任务编号，请刷新队列和历史记录确认上传情况');
            this.staged = this.staged.filter((other) => other !== item); uploaded += 1;
            this.processing = true; this.onChange();
            await this.refresh();
            if (focusFirst && !focused) { focused = true; await this.open(response.taskId, true); }
          } catch (error) {
            item.state = 'UploadFailed'; item.error = `${error.message}。其他文件会继续上传；连接异常时，请先检查队列或历史记录，避免重复提交。`;
          }
          this.renderStaged(); this.onChange();
        }
      } finally {
        this.uploading = false; this.renderStaged(); this.onChange();
        this.notify(uploaded ? `${uploaded} 个文件已加入识别队列` : '文件未加入队列，请查看上传提示');
      }
    }

    async open(taskId, follow = false) {
      try {
        const record = await this.request(`/api/recognition/status?taskId=${encodeURIComponent(taskId)}`);
        this.followTaskId = follow ? taskId : null;
        this.onOpen(record);
      } catch (error) { this.notify(error.message || '无法打开识别记录'); }
    }

    renderQueue(data) {
      this.panel.hidden = !this.items.length;
      document.querySelector('#batch-queue-summary').textContent = `处理中 ${data.processingCount} 个 · 排队中 ${data.waitingCount} 个`;
      document.querySelector('#batch-queue-current').disabled = !data.processingCount;
      this.list.replaceChildren();
      for (const item of this.items) {
        const row = document.createElement('li'); row.className = `batch-queue-item state-${item.status}`;
        row.dataset.taskId = item.taskId;
        const name = document.createElement('strong'); name.textContent = item.displayName || item.fileName || '未命名文件';
        const status = document.createElement('span'); status.className = 'batch-state';
        status.textContent = `${labels[item.status] || item.status}${item.position ? ` · 第 ${item.position} 位` : ''}`;
        const message = document.createElement('small'); message.textContent = item.error || item.message || '';
        const actions = document.createElement('div'); actions.className = 'batch-item-actions';
        const view = document.createElement('button'); view.type = 'button'; view.className = 'text-button';
        view.textContent = item.queueState === 'processing' ? '查看进度' : item.queueState === 'waiting' ? '查看任务' : '查看结果';
        view.setAttribute('aria-label', `${view.textContent}：${item.fileName}`);
        view.addEventListener('click', () => this.open(item.taskId, item.queueState === 'processing'));
        actions.append(view);
        if (item.queueState === 'waiting') {
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'text-button'; cancel.textContent = '取消排队';
          cancel.setAttribute('aria-label', `取消排队：${item.fileName}`);
          cancel.addEventListener('click', async () => {
            cancel.disabled = true;
            try { await this.request(`/api/recognition/${encodeURIComponent(item.taskId)}/cancel`, { method: 'POST' }); }
            catch (error) { this.notify(error.message); }
            finally { await this.refresh(); }
          }); actions.append(cancel);
        }
        row.append(name, status, message, actions); this.list.append(row);
      }
    }

    async refresh() {
      if (this.closed || this.refreshing) return;
      clearTimeout(this.timer); this.refreshing = true;
      try {
        const data = await this.request('/api/recognition/queue');
        const previous = new Map(this.items.map((item) => [item.taskId, item.queueState]));
        this.items = data.items || []; this.processing = Boolean(data.waitingCount || data.processingCount);
        if (this.items.some((item) => ['finished', 'cancelled'].includes(item.queueState) && previous.get(item.taskId) !== item.queueState)) this.onFinished();
        document.querySelector('#batch-queue-error').textContent = '';
        this.renderQueue(data); this.onChange();
        const viewedId = this.getRecord()?.taskId;
        const active = this.items.find((item) => item.queueState === 'processing');
        const follow = this.followTaskId && viewedId === this.followTaskId;
        const target = follow && active ? active : this.items.find((item) => item.taskId === viewedId);
        if (target && (target.queueState === 'waiting' || target.queueState === 'processing' || this.getRecord()?.status !== target.status || this.getRecord()?.queueState !== target.queueState || (follow && target.taskId !== viewedId))) {
          const record = await this.request(`/api/recognition/status?taskId=${encodeURIComponent(target.taskId)}`);
          if (this.getRecord()?.taskId === viewedId) {
            if (follow) this.followTaskId = target.taskId;
            this.onRecord(record);
          }
        }
        if (!this.processing) this.followTaskId = null;
      } catch (error) {
        this.panel.hidden = false;
        document.querySelector('#batch-queue-error').textContent = `队列连接暂时中断：${error.message}。已上传任务仍由本地服务处理。`;
      } finally {
        this.refreshing = false;
        if (!this.closed) this.timer = setTimeout(() => this.refresh(), 1600);
      }
    }
  }
  window.BatchQueuePanel = BatchQueuePanel;
})();
