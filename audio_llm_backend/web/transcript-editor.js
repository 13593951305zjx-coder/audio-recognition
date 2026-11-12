(() => {
  class TranscriptEditor {
    constructor({ getRecord, getEntries, isBusy, onBusyChange, onSaved, notify }) {
      Object.assign(this, { getRecord, getEntries, isBusy, onBusyChange, onSaved, notify });
      this.drafts = new Map();
      this.saving = false;
      this.recovery = document.createElement('section'); this.recovery.className = 'transcript-draft-recovery'; this.recovery.hidden = true;
      this.recovery.setAttribute('aria-label', '分句调整前的文字草稿');
      document.querySelector('#transcript-caption').after(this.recovery);
      window.addEventListener('beforeunload', (event) => {
        if ([...this.drafts.values()].some((draft) => draft.text !== draft.expectedText)) {
          event.preventDefault(); event.returnValue = '';
        }
      });
    }

    render(record) {
      if (!record?.taskId) return;
      for (const [key, draft] of this.drafts) {
        if (draft.taskId === record.taskId && draft.structureRevision !== (record.segmentStructureRevision || 0)) {
          if (draft.text !== draft.expectedText) draft.recovered = true; else this.drafts.delete(key);
        }
      }
      this.renderRecovery(record.taskId);
      const entries = new Map(this.getEntries(record).map((entry) => [entry.index ?? -1, entry]));
      document.querySelectorAll('#transcript .transcript-entry, #review-list .transcript-entry').forEach((row) => {
        row.querySelectorAll('.transcript-edit-tools, .transcript-edit-form').forEach((node) => node.remove());
        const index = Number(row.querySelector('.segment-play')?.dataset.segmentIndex);
        const entry = entries.get(index);
        if (!entry) return;
        const key = `${record.taskId}:${index}`;
        const source = index < 0 ? record : record.segments[index];
        const body = row.querySelector('.transcript-entry-text');
        const tools = document.createElement('div');
        tools.className = 'transcript-edit-tools';
        const edit = document.createElement('button');
        edit.type = 'button'; edit.className = 'text-button transcript-edit-open'; edit.textContent = '编辑文字';
        edit.setAttribute('aria-label', index < 0 ? '编辑整段转写' : `编辑第 ${index + 1} 条转写`);
        edit.addEventListener('click', () => {
          if (this.saving || this.isBusy()) return;
          const existing = this.drafts.get(key);
          if (existing?.recovered) { this.notify('请先复制或清除分句调整前的草稿'); return; }
          this.drafts.set(key, existing || { taskId: record.taskId, index, expectedText: entry.text, text: entry.text, structureRevision: record.segmentStructureRevision || 0, error: '' });
          this.render(this.getRecord());
          [...document.querySelectorAll('.transcript-edit-input')].find((input) => input.dataset.editKey === key)?.focus();
        });
        tools.append(edit);
        if (source.textManuallyEdited) {
          const badge = document.createElement('small'); badge.className = 'transcript-edited-badge'; badge.textContent = '已编辑';
          badge.title = '文字已人工修改，原识别分数不适用于修改后的文字。'; tools.append(badge);
        }
        body.append(tools);
        const existing = this.drafts.get(key), draft = existing?.recovered ? null : existing;
        row.classList.toggle('transcript-is-editing', Boolean(draft));
        edit.hidden = Boolean(draft);
        if (draft) this.addForm(body, key, draft, source);
      });
      this.refreshControls();
    }

    hasDirtyDrafts(taskId) { return [...this.drafts.values()].some((draft) => draft.taskId === taskId && draft.text !== draft.expectedText); }

    renderRecovery(taskId) {
      const drafts = [...this.drafts.entries()].filter(([, draft]) => draft.taskId === taskId && draft.recovered);
      this.recovery.hidden = !drafts.length; this.recovery.replaceChildren();
      if (!drafts.length) return;
      const note = document.createElement('p'); note.textContent = '分句结构已在其他窗口改变。以下未保存的文字草稿已保留，请复制后对照新的分句编辑，避免写入错误的句子。'; this.recovery.append(note);
      for (const [key, draft] of drafts) {
        const block = document.createElement('div'), input = document.createElement('textarea'); input.readOnly = true; input.value = draft.text;
        input.setAttribute('aria-label', `原第 ${draft.index + 1} 句未保存的文字草稿`);
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'text-button'; copy.textContent = '复制这份草稿';
        copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(draft.text); this.notify('草稿已复制'); } catch (_) { this.notify('请选中文字手动复制'); } });
        const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'text-button'; clear.textContent = '清除此草稿';
        clear.addEventListener('click', () => { this.drafts.delete(key); this.render(this.getRecord()); });
        block.append(input, copy, clear); this.recovery.append(block);
      }
    }

    addForm(body, key, draft, source) {
      const form = document.createElement('div'); form.className = 'transcript-edit-form'; form.dataset.editKey = key;
      const label = document.createElement('label');
      label.textContent = draft.index < 0 ? '编辑整段转写' : `编辑第 ${draft.index + 1} 条转写`;
      const input = document.createElement('textarea');
      input.className = 'transcript-edit-input'; input.dataset.editKey = key; input.maxLength = 20000;
      input.rows = 4; input.value = draft.text;
      label.append(input);
      const status = document.createElement('small'); status.className = 'transcript-edit-status'; status.setAttribute('role', 'status');
      const error = document.createElement('p'); error.className = 'transcript-edit-error'; error.setAttribute('role', 'alert');
      error.textContent = draft.error || ''; error.hidden = !draft.error;
      const actions = document.createElement('div'); actions.className = 'transcript-edit-actions';
      const save = document.createElement('button'); save.type = 'button'; save.className = 'summary-button transcript-edit-save'; save.textContent = '保存修改';
      save.addEventListener('click', () => this.save(key));
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'text-button transcript-edit-cancel'; cancel.textContent = '取消';
      cancel.addEventListener('click', () => { if (!this.saving) { this.drafts.delete(key); this.render(this.getRecord()); } });
      actions.append(save, cancel);
      const original = draft.index < 0 ? source.originalTranscript : source.originalText;
      if (typeof original === 'string') {
        const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'text-button transcript-edit-restore'; restore.textContent = '填回识别原文';
        restore.addEventListener('click', () => { draft.text = original; draft.error = ''; this.render(this.getRecord()); });
        actions.append(restore);
      }
      const hint = document.createElement('small'); hint.className = 'transcript-edit-hint'; hint.textContent = 'Ctrl + Enter 保存 · Esc 取消。只修改文字，保留时间段与原声。';
      input.addEventListener('input', () => {
        draft.text = input.value;
        draft.error = '';
        document.querySelectorAll('.transcript-edit-input').forEach((other) => { if (other !== input && other.dataset.editKey === key) other.value = input.value; });
        this.refreshControls();
      });
      input.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); this.save(key); }
        if (event.key === 'Escape' && !this.saving) { event.preventDefault(); this.drafts.delete(key); this.render(this.getRecord()); }
      });
      form.append(label, status, error, actions, hint); body.append(form);
    }

    refreshControls() {
      const busy = this.saving || this.isBusy();
      document.querySelectorAll('.transcript-edit-open').forEach((button) => { button.disabled = busy; });
      document.querySelectorAll('.transcript-edit-form').forEach((form) => {
        const draft = this.drafts.get(form.dataset.editKey);
        if (!draft) return;
        const changed = draft.text.trim() !== draft.expectedText.trim();
        const save = form.querySelector('.transcript-edit-save');
        save.disabled = busy || !changed || !draft.text.trim() || draft.text.length > 20000;
        save.textContent = this.saving ? '正在保存…' : '保存修改';
        form.querySelector('.transcript-edit-input').readOnly = this.saving;
        form.querySelectorAll('.transcript-edit-cancel, .transcript-edit-restore').forEach((button) => { button.disabled = this.saving; });
        form.querySelector('.transcript-edit-status').textContent = `${draft.text.length} / 20000 字 · ${changed ? '尚未保存' : '内容未修改'}`;
        const error = form.querySelector('.transcript-edit-error'); error.textContent = draft.error; error.hidden = !draft.error;
      });
    }

    async save(key) {
      const draft = this.drafts.get(key);
      if (!draft || this.saving || this.isBusy() || !draft.text.trim() || draft.text.trim() === draft.expectedText.trim()) return;
      this.saving = true; draft.error = ''; this.onBusyChange(); this.refreshControls();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const response = await fetch(`/api/recognition/${encodeURIComponent(draft.taskId)}/transcript`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ segmentIndex: draft.index < 0 ? null : draft.index, text: draft.text, expectedText: draft.expectedText, expectedStructureRevision: draft.structureRevision }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(typeof result?.detail === 'string' ? result.detail : `保存失败（${response.status}）`);
        if (!result?.taskId) throw new Error('服务未返回有效的保存结果，请刷新记录确认');
        this.drafts.delete(key);
        await this.onSaved(result);
        this.notify('转写修改已保存到本机');
      } catch (error) {
        draft.error = error.name === 'AbortError' ? '保存等待超时，草稿已保留；请刷新记录确认保存情况。' : error.message;
      } finally {
        clearTimeout(timeout); this.saving = false; this.onBusyChange(); this.refreshControls();
      }
    }
  }
  window.TranscriptEditor = TranscriptEditor;
})();
