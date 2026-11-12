(() => {
  // IDs, rather than display names, keep two equally named speakers distinct.
  function groupSpeakerEntries(record, entries) {
    const speakers = new Map((record?.speakers || []).map((speaker) => [speaker.id, speaker]));
    const groups = new Map();
    for (const entry of entries) {
      const speaker = speakers.get(entry.speakerId);
      const id = speaker ? speaker.id : null;
      if (!groups.has(id)) groups.set(id, {
        id, label: speaker?.label || (speaker?.code ? `说话人 ${speaker.code}` : '未确定说话人'), entries: [],
      });
      groups.get(id).entries.push(entry);
    }
    const order = (a, b) => (a.timed ? a.start : Infinity) - (b.timed ? b.start : Infinity) || (a.index ?? 0) - (b.index ?? 0);
    for (const group of groups.values()) group.entries.sort(order);
    return [...groups.values()].sort((a, b) => a.id === null ? 1 : b.id === null ? -1 : order(a.entries[0], b.entries[0]));
  }

  function groupedSpeakerText(groups, formatTime) {
    return groups.map((group) => [`【${group.label}】`, ...group.entries.map((entry) =>
      `${entry.timed ? `[${formatTime(entry.start)}–${formatTime(entry.end)}]` : '[时间未记录]'} ${entry.text}${entry.speakerMixed ? '（可能包含多人发言，请复听）' : ''}`)].join('\n')).join('\n\n');
  }

  class SpeakerOrganizer {
    constructor({ rerender, summarize, notify, formatTime, download }) {
      Object.assign(this, { rerender, summarize, notify, formatTime, download });
      this.mode = 'time';
      this.toolbar = document.createElement('div');
      this.toolbar.className = 'speaker-organizer-toolbar';
      this.toolbar.hidden = true;
      this.toolbar.innerHTML = '<div class="transcript-order" role="group" aria-label="转写排列方式"><button type="button" data-order="time" aria-pressed="true">按时间</button><button type="button" data-order="speaker" aria-pressed="false">按说话人</button></div><button type="button" class="text-button speaker-organizer-export">导出整理 TXT</button><small class="speaker-organizer-hint" role="status"></small>';
      document.querySelector('#transcript-caption').before(this.toolbar);
      this.toolbar.querySelectorAll('[data-order]').forEach((button) => button.addEventListener('click', () => {
        if (this.mode === button.dataset.order) return;
        this.mode = button.dataset.order;
        this.rerender();
      }));
      this.toolbar.querySelector('.speaker-organizer-export').addEventListener('click', () => this.download(this.text()));
    }

    text(groups = this.groups) { return groupedSpeakerText(groups || [], this.formatTime); }

    render(record, entries) {
      this.groups = groupSpeakerEntries(record, entries);
      this.toolbar.hidden = !entries.length;
      const grouped = this.mode === 'speaker';
      this.toolbar.querySelectorAll('[data-order]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.order === this.mode)));
      this.toolbar.querySelector('.speaker-organizer-hint').textContent = !record?.speakers?.length
        ? '请先点击“区分说话人”；暂未确定归属的发言会单独列出。'
        : grouped ? '同一人的发言归在一起，组内按时间排列；分组有误可在句子前调整。' : '可切换“按说话人”，集中查看、复制和总结每个人的发言。';
      const list = document.querySelector('#transcript');
      list.setAttribute('aria-label', grouped ? '按说话人整理的转写内容' : '按时间排列的转写内容');
      document.querySelector('#copy-button').textContent = grouped ? '复制按说话人整理的内容' : '复制转写';
      if (!grouped || !entries.length) return;
      // Move the original rows: playback, correction and AI selection retain original indices.
      const rows = [...list.querySelectorAll(':scope > .transcript-entry')];
      const rowByEntry = new Map(entries.map((entry, index) => [entry, rows[index]]));
      const fragment = document.createDocumentFragment();
      for (const group of this.groups) {
        const heading = document.createElement('li');
        heading.className = 'speaker-group-heading';
        const title = document.createElement('h3');
        title.textContent = group.label;
        const count = document.createElement('small');
        count.textContent = `${group.entries.length} 段发言`;
        const copy = document.createElement('button');
        copy.type = 'button'; copy.className = 'text-button'; copy.textContent = '复制发言';
        copy.setAttribute('aria-label', `复制${group.label}的发言`);
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(this.text([group])); this.notify('已复制该说话人的发言'); }
          catch (_) { this.notify('复制失败，可使用“导出整理 TXT”保存'); }
        });
        const summary = document.createElement('button');
        summary.type = 'button'; summary.className = 'text-button speaker-group-summarize'; summary.textContent = '✦ AI 总结发言';
        summary.setAttribute('aria-label', `AI 总结${group.label}的发言`);
        const hasSegments = group.entries.every((entry) => Number.isInteger(entry.index));
        const textLength = group.entries.map((entry) => entry.text).join('\n').length;
        summary.dataset.sourceAvailable = String(Boolean(record?.taskId && hasSegments && group.entries.length <= 120 && textLength <= 6000));
        summary.disabled = summary.dataset.sourceAvailable !== 'true';
        summary.title = summary.disabled ? '请先区分说话人；单次总结最多 120 段、6000 字，超出时可勾选部分发言总结。' : '仅总结这一组的转写，不包含其他说话人的发言';
        summary.addEventListener('click', () => this.summarize(group.entries.map((entry) => entry.index), `${group.label}的发言`));
        heading.append(title, count, copy, summary);
        fragment.append(heading);
        for (const entry of group.entries) if (rowByEntry.get(entry)) fragment.append(rowByEntry.get(entry));
      }
      list.replaceChildren(fragment);
    }
  }
  window.groupSpeakerEntries = groupSpeakerEntries;
  window.groupedSpeakerText = groupedSpeakerText;
  window.SpeakerOrganizer = SpeakerOrganizer;
})();
